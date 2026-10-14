#!/usr/bin/env bash
# Build QuickClaude and install it as a real app on this Mac.
#   ./deploy.sh            build, install to /Applications, start at login, launch
#   ./deploy.sh --no-login same, but don't add a login item
set -euo pipefail

cd "$(dirname "$0")"
APP_NAME="QuickClaude"
DEST="/Applications/$APP_NAME.app"
BUILT="src-tauri/target/release/bundle/macos/$APP_NAME.app"
ADD_LOGIN_ITEM=1
[[ "${1:-}" == "--no-login" ]] && ADD_LOGIN_ITEM=0

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "Checking prerequisites"
for tool in node npm bun cargo claude; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool"; exit 1; }
done
[[ -z "${ANTHROPIC_API_KEY:-}" ]] || echo "Note: ANTHROPIC_API_KEY is set here, but the app ignores it and uses your subscription."

step "Installing dependencies"
npm install --silent
(cd sidecar && npm install --silent)

step "Building (sidecar binary, UI, release app)"
npm run tauri build -- --bundles app

step "Stopping running copies (installed app and dev build)"
pkill -f "$DEST/Contents/MacOS/" 2>/dev/null || true
pkill -f "target/debug/quickclaude$" 2>/dev/null || true
for _ in {1..20}; do
  pgrep -f "$DEST/Contents/MacOS/|target/debug/quickclaude$" >/dev/null || break
  sleep 0.25
done

step "Installing to $DEST"
rm -rf "$DEST"
ditto "$BUILT" "$DEST"

if [[ $ADD_LOGIN_ITEM == 1 ]]; then
  step "Starting at login"
  osascript >/dev/null <<EOF
tell application "System Events"
  if not (exists login item "$APP_NAME") then
    make login item at end with properties {path:"$DEST", hidden:true}
  end if
end tell
EOF
fi

step "Launching"
open "$DEST"
# The agent can take a few seconds to start on a cold launch.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f "$DEST/Contents/MacOS/quickclaude-agent" >/dev/null && break
  sleep 1
done
if pgrep -f "$DEST/Contents/MacOS/quickclaude-agent" >/dev/null; then
  echo "QuickClaude $(defaults read "$DEST/Contents/Info" CFBundleShortVersionString) is running. Press ⌥Space."
else
  echo "QuickClaude was installed but its agent isn't running; check Console.app for errors."
  exit 1
fi
