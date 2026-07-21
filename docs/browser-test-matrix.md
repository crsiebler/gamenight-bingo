# Browser Test Matrix

GameNight Bingo runs Playwright browser coverage in the isolated projects below.
The full host/player journey runs in Chromium, installed Chrome/Edge, Firefox,
and Android Chromium emulation. The local production-mode Next harness is HTTP,
and WebKit correctly refuses the application's required `Secure` participant
cookie over HTTP. The `webkit` and `ios-webkit` projects therefore run every
noncredential browser check locally and leave the authenticated host/player
journey to the native HTTPS coverage below; do not weaken cookie security for a
test harness. Every database-backed invocation requires a fresh, empty, migrated
browser-test PostgreSQL database that is not shared with Vitest or another
Playwright run; startup fails if any lobby already exists. Never use production
data.

```sh
E2E_DATABASE_CONFIRMED_NONPRODUCTION=true \
  TEST_DATABASE_URL='<fresh-empty-migrated-browser-test-url>' \
  PLAYWRIGHT_BROWSER_MATRIX=all PLAYWRIGHT_MATRIX_PROJECT='<one-project>' \
  bun run test:e2e
```

Repeat that command for each project with a different fresh database. The
configuration rejects database-backed matrix runs that omit one exact
`PLAYWRIGHT_MATRIX_PROJECT`, preventing parallel projects from sharing retained
lobby state.

Install the Playwright-managed engines with
`bunx playwright install chromium firefox webkit`. Stable Chrome and Edge
projects use separately installed system channels.

## Automated Coverage

| Project            | Playwright target                                | What it proves                                | Limitation                                  |
| ------------------ | ------------------------------------------------ | --------------------------------------------- | ------------------------------------------- |
| `chromium`         | Playwright-managed desktop Chromium              | Current bundled Chromium engine               | Not branded Google Chrome                   |
| `chrome`           | Installed stable Google Chrome channel           | Current installed Chrome                      | Does not retain the previous stable release |
| `edge`             | Installed stable Microsoft Edge channel          | Current installed Edge                        | Does not retain the previous stable release |
| `firefox`          | Playwright-managed desktop Firefox               | Current bundled Firefox engine                | Not a retained prior stable release         |
| `webkit`           | Playwright-managed desktop WebKit                | Noncredential WebKit compatibility            | Authenticated journey requires native HTTPS |
| `ios-webkit`       | Playwright WebKit with iPhone 15 device settings | Mobile viewport, touch, and WebKit behavior   | Authenticated journey requires native HTTPS |
| `android-chromium` | Playwright Chromium with Pixel 7 device settings | Mobile viewport, touch, and Chromium behavior | Not native Android Chrome                   |

Run one installed project when the complete local browser set is unavailable:

```sh
E2E_DATABASE_CONFIRMED_NONPRODUCTION=true \
  TEST_DATABASE_URL='<fresh-empty-migrated-browser-test-url>' \
  PLAYWRIGHT_BROWSER_MATRIX=all PLAYWRIGHT_MATRIX_PROJECT=chrome bun run test:e2e
```

`PLAYWRIGHT_BROWSER_CHANNEL=chrome bun run test:e2e` remains the short form for
the stable Chrome project without enabling the full matrix.

## Native And Version Coverage

Playwright cannot install or execute native Safari/iOS Safari, and its managed
browsers do not retain the latest two branded stable releases. The release owner
must record the tested browser, OS, build, and result before release and run the
host/player journey over production-like HTTPS in:

- Current and previous stable Google Chrome on desktop.
- Current and previous stable Microsoft Edge on desktop.
- Current and previous stable Mozilla Firefox on desktop.
- Current and previous stable Safari on supported macOS releases.
- Current iOS Safari on a physical iPhone or native device service.
- Current Android Chrome on a physical Android device or native device service.

For each target, create a lobby in one private session and join from another.
Start a manual round, call until the host can mark a card cell, mark it, then
reload/reconnect both sessions. Confirm the authoritative host card and mark
return, the later player remains queued without a current-round card, both
participants remain listed once, host controls remain host-only, and no
participant can see another participant's card. Also record keyboard operation,
touch behavior where applicable, viewport size, failures, and the exact build.

Device emulation is useful automated coverage but must never be reported as a
native Safari, iOS Safari, or Android Chrome result.
