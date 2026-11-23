#!/bin/bash
# One-shot orchestration: dev server on :8199, booted emulator, Appium on
# :4723, then the layout fuzzer. Run from the repo root:
#   bash tests/android/run.sh [--seed N] [--steps N]
set -u
cd "$(dirname "$0")/../.."

export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}
export ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
DEVICE=${AFIELD_ANDROID_UDID:-emulator-5554}

APPIUM=/tmp/appium-root/node_modules/.bin/appium
if [[ ! -x "$APPIUM" ]] || ! command -v adb >/dev/null; then
  echo "Appium or the Android SDK is not installed. See tests/android/README.md" >&2
  exit 1
fi

# Server (fixture program behind it). Port 8199 stays clear of Playwright.
if ! lsof -iTCP:8199 -sTCP:LISTEN -P >/dev/null 2>&1; then
  nohup node server/cli.js --port 8199 --no-sign-in -- tests/fixtures/fake-pi.js > /tmp/afield-server.log 2>&1 &
  echo $! > /tmp/afield-server.pid
fi
for i in $(seq 1 20); do curl -sf http://127.0.0.1:8199/ >/dev/null && break; sleep 0.5; done

# Emulator: reuse a running one, else boot the afield AVD.
if ! adb -s "$DEVICE" get-state >/dev/null 2>&1; then
  nohup emulator -avd afield -port 5554 </dev/null > /tmp/afield-emulator.log 2>&1 &
  adb -s "$DEVICE" wait-for-device
  until [[ "$(adb -s "$DEVICE" shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; do sleep 2; done
  # Booted is not yet settled: Appium's helper on the device crashes if started at once.
  sleep 20
fi
# The session attaches to Chrome as it is running: launching it through Appium clears its data.
adb -s "$DEVICE" shell am start -n com.android.chrome/com.google.android.apps.chrome.Main >/dev/null
# The page is served to the emulator at the address the server's origin check expects.
adb -s "$DEVICE" reverse tcp:8199 tcp:8199 >/dev/null

# Appium, allowed to fetch the chromedriver that matches the emulator's Chrome.
if ! curl -sf http://127.0.0.1:4723/status >/dev/null 2>&1; then
  nohup "$APPIUM" --port 4723 --relaxed-security --allow-insecure=uiautomator2:chromedriver_autodownload > /tmp/appium.log 2>&1 &
  echo $! > /tmp/appium.pid
  for i in $(seq 1 30); do curl -sf http://127.0.0.1:4723/status >/dev/null && break; sleep 1; done
fi

node tests/ios/fuzz.mjs --platform android "$@"
