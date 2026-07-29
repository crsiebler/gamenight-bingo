# PRD: Mark-Order-Independent Winner Attribution

## Introduction

GameNight Bingo currently recognizes a winner only when the participant's final
mark is the latest called ball. This makes winner recognition depend on click
order rather than on the call that made the pattern achievable.

The defect was reproduced in a live local game using a One Line row containing
`B 14`, `I 25`, `N 33`, `G 51`, and `O 62`. `O 62` was the latest call. Marking
`O 62` first and the four older called balls afterward left the active round at
`5 of 5 required spaces marked` without opening a co-winner window. In a control
game, marking the older balls first and the latest called ball last produced the
expected confirmed winner.

Winner attribution must continue to belong to the current latest call, but the
participant may mark the required called cells in any order. A newly completed
canonical pattern variation is attributable when that variation is complete
with the latest call available and would be incomplete without that call.

## Goals

- Remove mark-order dependence from authoritative winner recognition.
- Preserve the requirement that the current latest call made the completed
  pattern variation possible.
- Apply the rule consistently to exact and flexible patterns and to One Line,
  Two Lines, and Blackout stages.
- Preserve server authority, co-winner timing, idempotency, transactional
  persistence, event ordering, privacy, and deterministic canonical behavior.
- Prevent an eligible card from remaining active while the UI reports all
  required spaces marked.

## User Stories

### US-001: Define Latest-Call Pattern Attribution

**Description:** As a game participant, I want a newly completed pattern to be
attributed to the call that enabled it regardless of mark order so that valid
wins are recognized consistently.

**Acceptance Criteria:**

- [ ] Add a pure pattern rule that evaluates whether at least one canonical
      variation is complete and depends on the current latest called card cell.
- [ ] A variation depends on the latest call when it is complete under the
      authoritative called-and-marked projection and becomes incomplete when
      that latest called cell is treated as unavailable.
- [ ] The rule does not require the current mark command's ball to equal the
      latest called ball.
- [ ] A card that was already complete before the current mark is not attributed
      to a later unrelated call or mark.
- [ ] Flexible patterns inspect every canonical variation for attribution; the
      progress display's selected closest variation does not suppress another
      attributable completed variation.
- [ ] The free center remains automatically satisfied and can never be treated
      as a triggering call.
- [ ] Unit tests cover exact patterns, flexible patterns, center-containing
      patterns, canonical ties, an unrelated latest call, and an already-complete
      card.
- [ ] Typecheck passes.
- [ ] Tests pass.

**Recommended Agents:** @backend-developer, @test-automator

### US-002: Apply Attribution in Authoritative Mark Commands

**Description:** As a participant, I want the server to open the co-winner
window when my mark completes a variation enabled by the latest call so that
the committed game state records my valid win.

**Acceptance Criteria:**

- [ ] Write a failing database integration regression that reproduces marking
      the latest required ball first and an older required ball last without an
      intervening call.
- [ ] The regression proves the final mark opens a co-winner window, persists the
      participant as a co-winner, and emits the sequenced active-lobby event
      attributed to the current latest call.
- [ ] Replace the `command.ball === latestCall.ball` eligibility condition with
      the pure latest-call pattern-attribution rule.
- [ ] Winner eligibility still requires a new mark and a transition from
      incomplete before the command to complete after the command.
- [ ] The same attribution rule admits additional winners only for the persisted
      triggering call during its open, exclusive co-winner window.
- [ ] Existing protection against attributing an already-complete card to an
      unrelated latest-ball mark remains green.
- [ ] Database integration coverage includes One Line, Two Lines, Blackout, an
      exact catalog pattern, a flexible catalog pattern, active state, paused
      state, and the co-winner-window state.
- [ ] Continuation-stage behavior preserves cards, calls, and marks and applies
      the corrected attribution rule without duplicating prior stage winners.
- [ ] Idempotent command replay returns the original acknowledgement and does not
      add winners, events, marks, or notifications.
- [ ] The winning mark, co-winner row, round transition, command result, active
      event, and PostgreSQL notification remain atomic in one serializable
      transaction.
- [ ] No database migration or wire-contract change is introduced.
- [ ] Typecheck passes.
- [ ] Tests pass.

**Recommended Agents:** @backend-developer, @postgres-pro

### US-003: Verify Complete-Pattern Winner Presentation

**Description:** As a participant, I want a valid completed pattern to progress
to winner presentation instead of remaining silently active so that the visible
game state agrees with authoritative winner eligibility.

**Acceptance Criteria:**

- [ ] Add a component or browser regression for a mark-order-independent winning
      acknowledgement and resulting co-winner/result snapshots.
- [ ] The eligible scenario does not settle into an active or paused UI showing
      all required spaces marked while normal calling controls remain available.
- [ ] The co-winner window and settled result retain their existing accessible
      announcements and focus behavior.
- [ ] A completed card that is not attributable to the current latest call does
      not show a false winner presentation.
- [ ] Run a manual-mode browser scenario in which the latest required ball is
      marked first and an older required ball is marked last; verify the
      co-winner window opens and the result settles.
- [ ] Run the control scenario with the latest required ball marked last and
      verify identical winner attribution.
- [ ] Verify browser console and relevant HTTP/realtime traffic contain no new
      errors or failed requests.
- [ ] Typecheck passes.
- [ ] Tests pass.
- [ ] Verify in browser using dev-browser skill.

**Recommended Agents:** @react-specialist, @accessibility-tester

### US-004: Align Winner-Rule Documentation

**Description:** As a maintainer, I want the documented invariant to describe
latest-call attribution rather than click order so that future changes preserve
the corrected rule.

**Acceptance Criteria:**

- [ ] Replace documentation stating that a winner must complete by marking the
      latest called ball with the mark-order-independent attribution rule.
- [ ] Document that the current latest call must be required by at least one
      newly completed canonical variation.
- [ ] Document that a subsequent unrelated call prevents attribution to the
      earlier pattern-enabling call.
- [ ] Document that deployment does not retroactively reconstruct winners for
      already active or completed rounds.
- [ ] Formatting checks pass.

## Functional Requirements

- **FR-1:** Winner evaluation must use authoritative calls, the participant's
  own card, persisted prior marks, the proposed new mark, and the canonical
  current-stage pattern.
- **FR-2:** A mark command may produce an attributable completion only when the
  mark is new, the card was incomplete before the command, and the card is
  complete after the command.
- **FR-3:** An attributable completion must have a current latest call.
- **FR-4:** At least one canonical variation must be complete under the current
  called-and-marked projection and incomplete when the card cell containing the
  current latest call is treated as not called.
- **FR-5:** The current mark command may target any called, unmarked required
  cell; it need not target the latest call.
- **FR-6:** A latest call that is not required by any newly completed canonical
  variation must not produce a winner.
- **FR-7:** A card that was complete before the current command must not produce
  a new winner, including when the command marks an unrelated latest call.
- **FR-8:** Flexible patterns must evaluate attribution across all canonical
  masks in canonical catalog order without changing progress tie selection.
- **FR-9:** The center cell must remain automatically satisfied and excluded
  from latest-call attribution.
- **FR-10:** The first attributable completion in active or paused state must
  open the existing co-winner window and bind it to the current latest call ID.
- **FR-11:** Additional winners must complete an attributable variation for that
  same triggering call before the exclusive persisted close deadline.
- **FR-12:** The corrected rule must apply to One Line, Two Lines, Blackout, and
  all exact and flexible catalog patterns.
- **FR-13:** Existing command idempotency, event sequencing, participant-private
  mark delivery, active-lobby winner delivery, and post-commit broadcasting must
  remain unchanged.
- **FR-14:** Deployment must not scan, mutate, or reconstruct existing rounds.
  Only mark commands evaluated after deployment use the corrected rule.
- **FR-15:** No browser-only winner decision may be introduced.

## Non-Goals

- Recognizing a pattern after a subsequent unrelated ball has become the latest
  call.
- Retroactively awarding wins in existing active, ended, or retained rounds.
- Changing call order, automatic-call cadence, pause rules, co-winner duration,
  or settlement ordering.
- Allowing called but unmarked cells to satisfy a pattern.
- Changing canonical masks, pattern catalog ordering, progress tie selection, or
  near-win feedback policy.
- Adding a manual Bingo claim button or host winner override.
- Adding database columns, migrations, new APIs, or new realtime message types.
- Changing prior-round retention or exposing event history.

## Design Considerations

- Winner presentation should continue to use the existing co-winner-window and
  result UI. No new visual treatment is required.
- Existing live regions, focus movement, card locking, and host continuation
  controls must remain intact.
- The browser's progress calculation remains informational. The server remains
  the sole authority for winner eligibility.

## Technical Considerations

- The current click-order dependency is in
  `packages/database/src/round-command-executor.ts`, where attributable
  completion requires `command.ball === latestCall.ball`.
- Prefer a pure reusable function in `packages/patterns` that evaluates all
  masks directly. `calculatePatternProgress` intentionally selects one closest
  variation and is insufficient by itself when multiple variations are
  complete but only one contains the latest call.
- Preserve the existing prior-progress transition check in the command
  executor. Pattern attribution supplements that check; it does not replace it.
- The persisted `triggeringCallId` remains the ID of the current latest call, so
  co-winner scheduling, settlement, snapshots, and contracts do not require a
  representation change.
- Database integration tests require an explicitly approved, migrated
  `TEST_DATABASE_URL` and must remain serialized with other database-backed
  tests.
- Browser verification should use a fresh nonproduction database when run
  through the full Playwright harness.

## Success Metrics

- The confirmed failure sequence opens a co-winner window and settles a winner
  in both database integration and manual browser verification.
- Marking the same row with the latest required ball last continues to settle
  the same winner.
- The existing unrelated-latest-call regression continues to produce no winner.
- All exact/flexible and continuation-stage regression cases pass.
- No eligible test scenario remains active or paused at full displayed pattern
  progress after authoritative reconciliation.
- Typecheck, lint, formatting, focused tests, and the complete available test
  suite pass without contract or migration changes.

## Open Questions

None. Product decisions for this change are resolved:

- Attribution remains bound to the current latest call.
- Mark order does not affect attribution.
- The rule applies to all patterns and stages.
- Existing rounds receive no retroactive repair.
