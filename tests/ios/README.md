# iOS layout fuzzer (Simulator Safari + Appium XCUITest)

Runs afield in the iOS Simulator's Safari with **real touch physics** and
the real on-screen keyboard, and fuzzes the layout there -- what Playwright
WebKit cannot reach.

Route chosen: **Appium 3 + the XCUITest driver over WebDriverAgent**, one
session with two contexts used alternately:

- `NATIVE_APP`: UIKit-level gestures (`performActions` pointer streams with real
  finger-down / stroke velocity / finger-up -- this is what the W3C actions API
  becomes on iOS). Any WebKit "this is a user gesture" state that the app checks
  (`navigator.userActivation`, `e.isTrusted`) is genuinely true.
- `WEBVIEW_…`: the same simulator Safari as a WebKit remote-inspection target.
  `executeScript` into this context is real JS in the page: `window.afield`,
  `#screen.scrollTop`, and DOM state all read back faithfully.

Why this route (alternatives considered):

- safaridriver cannot inject touch -- no gesture axis.
- idb/applesimutils gestures go through a separate, sim-level channel: momentum
  exists, but there is no JS readback from the same session.
- A homemade XCUITest project needs an Xcode target just to wrap WDA, which
  already has one. Appium is that target, without the project.
- WebKit's WebDriver on sim is remote-debug only, no UIKit gestures. Appium
  covers this too.

## Setup (verified on this machine, Xcode 26.6 / iOS 26.5)

```sh
# One-time: driver + runtime deps (kept out of the repo -- Appium lives in /tmp).
npm install --prefix /tmp/appium-root appium                # ~274 pkgs, ~1 min
env PATH=/tmp/appium-root/node_modules/.bin:$PATH appium driver install xcuitest

# This folder only: webdriverio client for the fuzzer.
cd tests/ios && npm install
```

## Run

```sh
cd /path/to/afield
bash tests/ios/run.sh                       # boots what is missing, then fuzzes
bash tests/ios/run.sh --seed 7 --steps 40
```

`run.sh` starts the dev server on **8199** (so a concurrently running Playwright
on 7681 is undisturbed), reuses any booted simulator or boots "iPhone 17 Pro",
and starts Appium on 4723. The fuzzer targets `AFIELD_SIM_UDID` when set.
Failures and screenshots go to `/tmp/afield-fuzz`.

## Files

- `fuzz.mjs` -- layout fuzzer: random keyboard, rotation, drag and output, then checks alignment, grid, history and a screenshot. `--platform android` runs it against the Android emulator (see `tests/android/README.md`).
- `driver.mjs` -- what the fuzzer needs to know about this platform: the session, the page's tab, and where the page sits on the glass.
- `run.sh` -- server on 8199 + booted sim + Appium on 4723 + the fuzzer.
