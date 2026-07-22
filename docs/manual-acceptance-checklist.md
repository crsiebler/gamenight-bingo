# Manual Acceptance Checklist

This is the final product-owner handoff for the GameNight Bingo MVP. Complete it
only after every automated prerequisite below passes for the release candidate.
An implementation agent may prepare and validate this document, but must not
check acceptance boxes, fill the product-owner decision, or approve the MVP.

Use only nonproduction test data. Keep evidence private and exclude cookies,
session credentials, realtime tickets, database URLs, uncalled draw positions,
and unnecessary card data.

## Acceptance Record

| Field                           | Product-owner record |
| ------------------------------- | -------------------- |
| Release commit/build            |                      |
| Environment and public URL      |                      |
| Product owner                   |                      |
| Started (date/time/time zone)   |                      |
| Completed (date/time/time zone) |                      |
| Evidence location               |                      |
| Known limitations or deviations |                      |

## Automated Prerequisite Gate

Do not begin manual acceptance until every row records `Pass`; a failed, skipped,
or missing command row blocks handoff. A passing suite may contain only the
intentional gated cases covered by another dedicated row or by the native manual
matrix below. Record those skips with the command evidence. Use approved
local/test PostgreSQL databases only. Apply committed migrations before
database-backed runs; each restart, performance, and browser-matrix invocation
requires its own fresh, empty, migrated database. Do not share those databases
with Vitest or another browser run.

| Required check                                                                                                                       | Result | Date/build and evidence |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------- |
| `bun install --frozen-lockfile`                                                                                                      |        |                         |
| `bun run test:workspace-boundaries`                                                                                                  |        |                         |
| `bun run lint`                                                                                                                       |        |                         |
| `bun run format:check`                                                                                                               |        |                         |
| `bun run typecheck`                                                                                                                  |        |                         |
| `bun run db:generate`                                                                                                                |        |                         |
| `DATABASE_URL='<approved-local-or-test-url>' bun run db:migrate:deploy`                                                              |        |                         |
| `TEST_DATABASE_URL='<approved-migrated-test-url>' bun run test`                                                                      |        |                         |
| `TEST_DATABASE_URL='<approved-migrated-test-url>' bun run test:database`                                                             |        |                         |
| `E2E_DATABASE_CONFIRMED_NONPRODUCTION=true TEST_DATABASE_URL='<fresh-empty-migrated-restart-test-url>' bun run test:restart`         |        |                         |
| `E2E_DATABASE_CONFIRMED_NONPRODUCTION=true TEST_DATABASE_URL='<fresh-empty-migrated-performance-test-url>' bun run test:performance` |        |                         |
| Browser-matrix command template from `docs/browser-test-matrix.md`                                                                   |        |                         |
| Playwright project `chromium` with its own fresh database                                                                            |        |                         |
| Playwright project `chrome` with its own fresh database                                                                              |        |                         |
| Playwright project `edge` with its own fresh database                                                                                |        |                         |
| Playwright project `firefox` with its own fresh database                                                                             |        |                         |
| Playwright project `webkit` with its own fresh database                                                                              |        |                         |
| Playwright project `ios-webkit` with its own fresh database                                                                          |        |                         |
| Playwright project `android-chromium` with its own fresh database                                                                    |        |                         |

Run each Playwright row separately using the command in the
[browser test matrix](browser-test-matrix.md). The local HTTP harness cannot
carry the required `Secure` participant cookie in WebKit; its expected
authenticated-journey skip does not replace the native Safari and iOS Safari
checks below. Never weaken cookie security to make the local harness pass.

## Core Journeys

Record an evidence link or concise observation beside each completed item.

| Product-owner check                                                                                                                                                                                                                      | Evidence/observation |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| - [ ] Create a lobby with a normalized host name, selected theme, One Line default pattern, and manual call mode; copy both the code and credential-free invite URL.                                                                     |                      |
| - [ ] Join from a separate private browser session using typed and pasted mixed-case lobby codes; confirm normalized lobby-unique names and host-only controls.                                                                          |                      |
| - [ ] Start a manual round and confirm only explicit host `Call Next` actions advance one ball at a time.                                                                                                                                |                      |
| - [ ] Confirm called numbers can be daubed, uncalled numbers are rejected with clear feedback, repeated daubs do not duplicate marks, and a reload restores the own card and marks.                                                      |                      |
| - [ ] Put one participant exactly one required called-but-unmarked cell from completion; confirm near-win feedback is private, understandable without color or sound, and disabling optional feedback does not change winner validation. |                      |
| - [ ] Complete a 75-call round and confirm the chronological call grid contains every ball exactly once, no repeat is announced, and no 76th call is possible.                                                                           |                      |

### Automatic Calling

For each allowed interval, create or configure an automatic round, record at
least two consecutive scheduled-call timestamps, confirm the configured interval
is displayed, and confirm pause/co-winner states stop scheduling. Host `Call
Next` may remain available but must not race the timer into duplicate positions.

| Interval          | Timestamps/observed delta | No duplicate/race | Evidence |
| ----------------- | ------------------------- | ----------------- | -------- |
| - [ ] 5 seconds   |                           |                   |          |
| - [ ] 10 seconds  |                           |                   |          |
| - [ ] 30 seconds  |                           |                   |          |
| - [ ] 60 seconds  |                           |                   |          |
| - [ ] 120 seconds |                           |                   |          |

### Winners And Progression

| Product-owner check                                                                                                                                                                                                                                                                                             | Evidence/observation |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| - [ ] Prepare two participants one latest-ball mark from the same pattern; confirm the first valid mark opens the two-second co-winner window, calls stop immediately, a second valid completion within the window is admitted, and only the complete deterministic winner set appears after the window closes. |                      |
| - [ ] Win One Line, continue the same round to Two Lines, then to Blackout; confirm the visible card, calls, and marks remain, each prior stage result clears, and subsequent calls continue without resetting or repeating a ball.                                                                             |                      |
| - [ ] Start a non-One-Line exact pattern such as Four Corners, complete it, and confirm the result is terminal with no Two Lines or Blackout continuation.                                                                                                                                                      |                      |
| - [ ] Confirm winner and other-player result views identify outcomes with text and expose only valid host continuation/end actions, with no prior-round browser.                                                                                                                                                |                      |

## Disconnect, Rejoin, And Restart

| Product-owner check                                                                                                                                                                                                                                                                     | Evidence/observation |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| - [ ] Close a playing participant's final tab, wait through the configured 10-second grace, and confirm calling pauses with the participant absence reason. Reconnect and confirm calling does not resume until the host explicitly resumes.                                            |                      |
| - [ ] Repeat with the host absent and confirm the host absence cannot be overridden.                                                                                                                                                                                                    |                      |
| - [ ] Reconnect on the same device within the two-minute (120-second) window using a new single-use realtime ticket; confirm `Rejoin as <username>` restores the exact active identity and authoritative snapshot.                                                                      |                      |
| - [ ] Wait until the two-minute (120-second) rejoin deadline, confirm the prior participant is departed and the old cookie cannot reclaim the slot, then join anew during an active round and confirm the new participant waits without a card or win eligibility.                      |                      |
| - [ ] Start the next round and confirm an eligible waiting participant is promoted with a new card while prior-round calls, marks, and results are absent.                                                                                                                              |                      |
| - [ ] While PostgreSQL and the web process remain available, restart the single game-server process. Reconnect with fresh tickets and confirm exact own cards, marks, calls, stage, call mode/timer, pause state or settled co-winner result return without replayed or repeated calls. |                      |

## Platform And Accessibility

Record the exact browser, operating system, device, assistive technology, and
build for each result. Follow the full current/previous-stable and native-device
targets in the [browser test matrix](browser-test-matrix.md); emulation must not
be recorded as native Safari, iOS Safari, or Android Chrome coverage.

| Product-owner check                                                                                                                                                                                                                                                                                                                        | Browser/device/AT and evidence |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| - [ ] Complete create, join, call, daub, result, and reconnect on required desktop targets at 100% and 200% zoom without clipped content or horizontal two-dimensional scrolling.                                                                                                                                                          |                                |
| - [ ] Complete the touch journey with current iOS Safari and current Android Chrome on physical devices or an approved native device service over production-like HTTPS.                                                                                                                                                                   |                                |
| - [ ] Complete the authenticated journey in current native macOS Safari over production-like HTTPS with the required `Secure` cookie unchanged.                                                                                                                                                                                            |                                |
| - [ ] Operate create/join forms, setup, host controls, card cells, dialogs, sound controls, and result actions using only the keyboard; confirm logical order, visible focus, arrow-key card navigation, and focus recovery when controls disappear.                                                                                       |                                |
| - [ ] With VoiceOver/Safari and NVDA/Firefox or an approved screen-reader equivalent, confirm headings/landmarks, form errors, participant and connection states, card-cell called/marked/free/unavailable semantics, new-call and near-win announcements, pause/co-winner/result updates, and no replay of call history after a snapshot. |                                |
| - [ ] Confirm every connection, pause, called/marked, near-win, winner, and error state remains understandable without color, sound, or motion.                                                                                                                                                                                            |                                |

## Theme And Media Matrix

For every canonical theme, verify readable desktop and mobile layouts, visible
focus, called/marked/unavailable distinctions, winner/other-winner presentation,
sound opt-in, mute and volume, reduced-motion behavior, high contrast or forced
colors, and continued semantic gameplay when the selected decorative sprite is
blocked in browser developer tools. Audio must remain inert before explicit
opt-in and only the selected theme's visual/audio assets may load.

| Theme                 | Desktop/mobile and states | Sound/mute/volume | Reduced motion/high contrast | Decorative-asset failure | Evidence |
| --------------------- | ------------------------- | ----------------- | ---------------------------- | ------------------------ | -------- |
| - [ ] Animals         |                           |                   |                              |                          |          |
| - [ ] Nature          |                           |                   |                              |                          |          |
| - [ ] Superheroes     |                           |                   |                              |                          |          |
| - [ ] Pirates         |                           |                   |                              |                          |          |
| - [ ] Ghosts          |                           |                   |                              |                          |          |
| - [ ] Sports          |                           |                   |                              |                          |          |
| - [ ] Christmas       |                           |                   |                              |                          |          |
| - [ ] Halloween       |                           |                   |                              |                          |          |
| - [ ] July 4th        |                           |                   |                              |                          |          |
| - [ ] Valentine's Day |                           |                   |                              |                          |          |
| - [ ] Birthday        |                           |                   |                              |                          |          |

## Product-Owner Decision

Before deciding, confirm every prerequisite row says `Pass`, every manual item
is checked, deviations are documented, and evidence contains no private game or
credential data.

### Security Advisory Record

Run a current `bun audit --production` and record its nonzero status when it
reports advisories; unlike the automated prerequisite table, the review is based
on finding severity and disposition rather than exit code. Resolve, or explicitly
accept through the normal product/security process, every applicable noncritical
advisory. Any critical finding blocks acceptance.

- [ ] Product/security owner reviewed current dependency and security advisories,
      found no unresolved critical issue, and recorded every applicable finding's
      disposition.

| Advisory field                         | Product/security record |
| -------------------------------------- | ----------------------- |
| `bun audit --production` date/build    |                         |
| Critical/high/moderate/low counts      |                         |
| Applicable findings and disposition    |                         |
| Product/security reviewer and evidence |                         |
| Follow-up owner and due date, if any   |                         |

- [ ] Product owner accepts the GameNight Bingo MVP.

| Decision field                    | Product-owner record |
| --------------------------------- | -------------------- |
| Name                              |                      |
| Decision date/time/time zone      |                      |
| Accepted release commit/build     |                      |
| Open issues explicitly accepted   |                      |
| Signature or approval-record link |                      |

Leaving the decision unchecked means acceptance is pending, not failed. Only the
product owner records the final result; implementation agents do not self-approve
this checklist.
