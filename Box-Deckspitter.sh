#!/bin/sh
# Box-Deckspitter for Linux. Run it from a terminal or a file manager:
#   sh Box-Deckspitter.sh [files to open]
# The first start downloads the app's parts (node_modules) with npm; after that it just starts.
# Settings › Linux › "Add to the app menu" puts it in your desktop's app menu.

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
cd "$DIR" || exit 1
EL="$DIR/node_modules/electron/dist/electron"

say() {
  echo "$1"
  # started from the app menu there's no terminal to read: show it on screen too
  [ -t 1 ] || { command -v notify-send >/dev/null 2>&1 && notify-send "Box-Deckspitter" "$1"; } || true
}

if [ ! -x "$EL" ]; then
  # missing, or a node_modules copied over from Windows (its Electron is electron.exe)
  if ! command -v npm >/dev/null 2>&1; then
    say "Box-Deckspitter needs Node.js and npm to download its parts once. Install them (e.g. sudo apt install nodejs npm, sudo dnf install nodejs npm, sudo pacman -S nodejs npm), then run this again."
    exit 1
  fi
  say "First start: downloading Box-Deckspitter's parts. This takes a few minutes."
  [ -f node_modules/electron/package.json ] && [ ! -x "$EL" ] && rm -rf node_modules
  npm ci --no-audit --no-fund || npm install --no-audit --no-fund || { say "Downloading the app's parts failed (see above)."; exit 1; }
  # Electron fetches its own program after npm is done; some setups skip that step
  [ -x "$EL" ] || node node_modules/electron/install.js
  [ -x "$EL" ] || { say "Electron didn't download. Check the internet connection and run this again."; exit 1; }
fi

# Chromium's sandbox needs either a root-owned chrome-sandbox or unprivileged user namespaces, which some distros
# turn off (Ubuntu 24.04 and later, for programs it doesn't know). Without either it can't start at all.
SANDBOX=
if [ ! -u "$DIR/node_modules/electron/dist/chrome-sandbox" ] && ! unshare -Ur true >/dev/null 2>&1; then
  SANDBOX=--no-sandbox
fi

exec "$EL" "$DIR/electron/main.js" $SANDBOX "$@"
