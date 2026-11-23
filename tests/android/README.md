# Android layout fuzzer (emulator Chrome + Appium UiAutomator2)

Runs afield in the Android emulator's Chrome with the real Gboard keyboard, and points the layout fuzzer in `tests/ios/fuzz.mjs` at it. One Appium session with two contexts, as on iOS:

- `NATIVE_APP`: taps, drags, rotation and screenshots.
- `CHROMIUM`: script in the page, for `window.afield` and DOM state. Switching to it does not dismiss the keyboard.

## Setup (verified with Android 37, Chrome 145, Gboard 17.2)

```sh
brew install openjdk@21
brew install --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# The google_apis image ships both Chrome and Gboard.
sdkmanager "platform-tools" "emulator" "system-images;android-37.0;google_apis;arm64-v8a"
avdmanager create avd -n afield -k "system-images;android-37.0;google_apis;arm64-v8a" -d pixel_9

# Appium lives in /tmp, as for iOS (see tests/ios/README.md), plus this driver.
env PATH=/tmp/appium-root/node_modules/.bin:$PATH appium driver install uiautomator2
cd tests/ios && npm install      # the webdriverio client
```

Then, once:

- Set `hw.keyboard=no` in `~/.android/avd/afield.avd/config.ini`. With a hardware keyboard the on-screen one never shows.
- On the first boot, open Chrome and dismiss its two prompts ("Stay signed out", then "No thanks" to notifications).

## Run

```sh
bash tests/android/run.sh                       # boots what is missing, then fuzzes
bash tests/android/run.sh --seed 7 --steps 40
```

`run.sh` starts the dev server on 8199, boots the `afield` emulator, forwards the port with `adb reverse` (so the page is at `http://127.0.0.1:8199/`, which the server's origin check accepts) and starts Appium on 4723 with chromedriver autodownload. `AFIELD_ANDROID_UDID` picks another device. Failures and screenshots go to `/tmp/afield-fuzz`.

## Notes

- One device at a time per server: every open page is a viewer and the server sizes the grid for the smallest, so a Simulator tab left on the same port fails the grid check here.
- The session attaches to the Chrome that is already running (`androidUseRunningApp`) and uses a tab already on the page, or a new one. Without that capability chromedriver clears Chrome's data -- tabs, logins and all -- every time it launches it, which matters on a real device.
- Native coordinates and screenshots are in device pixels, not points. The page starts under Chrome's toolbar, at the top of the `android.webkit.WebView` node: 289 px in portrait and 284 in landscape on the Pixel 9 image. `driver.mjs` reads it each time.
- Appium's element `.click()` on a page button skips the app's `pointerdown` handlers, so the fuzzer taps by position.
- Gboard's own keys are only in the page source with the driver setting `enableMultiWindows: true`. The fuzzer turns it on to find the keyboard's top edge, and checks with the keyboard up that the key bar's keys end on it: Chrome can run the visible area under the keyboard, and the bar's padding lifts the keys clear of that part.
- Chrome's toolbar never collapses, because the page itself does not scroll. Landscape with the keyboard up leaves about 51 CSS px: the key bar and no rows.

## Files

- `driver.mjs` -- what the fuzzer needs to know about this platform: the session, the page's context, where the page sits on the glass, and the keyboard's top edge.
- `run.sh` -- server on 8199 + booted emulator + Appium on 4723 + the fuzzer.
