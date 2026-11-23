#!/bin/bash
# One-shot orchestration: dev server on :8199, booted simulator, Appium on
# :4723, then the layout fuzzer. Run from the repo root:
#   bash tests/ios/run.sh [--seed N] [--steps N]
set -u
cd "$(dirname "$0")/../.."

APPIUM=/tmp/appium-root/node_modules/.bin/appium
if [[ ! -x "$APPIUM" ]]; then
  echo "Appium not installed. See tests/ios/README.md (npm i --prefix /tmp/appium-root appium && appium driver install xcuitest)" >&2
  exit 1
fi

# Server (fixture program behind it). Port 8199 stays clear of Playwright.
if ! lsof -iTCP:8199 -sTCP:LISTEN -P >/dev/null 2>&1; then
  nohup node server/cli.js --port 8199 --no-sign-in -- tests/fixtures/fake-pi.js > /tmp/afield-server.log 2>&1 &
  echo $! > /tmp/afield-server.pid
fi
for i in $(seq 1 20); do curl -sf http://127.0.0.1:8199/ >/dev/null && break; sleep 0.5; done

# Simulator: reuse any booted device, else boot iPhone 17 Pro.
booted=$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next((v[0]["udid"] for k,v in d.items() if v), ""))')
[[ -n "$booted" ]] || xcrun simctl bootstatus "iPhone 17 Pro"

# Appium
if ! curl -sf http://127.0.0.1:4723/status >/dev/null 2>&1; then
  nohup "$APPIUM" --port 4723 --relaxed-security > /tmp/appium.log 2>&1 &
  echo $! > /tmp/appium.pid
  for i in $(seq 1 30); do curl -sf http://127.0.0.1:4723/status >/dev/null && break; sleep 1; done
fi

node tests/ios/fuzz.mjs "$@"
