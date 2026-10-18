#!/usr/bin/env bash
# Install / remove os-cli as a per-user launchd service (macOS).
set -euo pipefail
umask 077

LABEL=dev.os-cli
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$HOME/Library/Application Support/os-cli"
LOGS="$HOME/Library/Logs/os-cli"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    [ "$(id -u)" -ne 0 ] || { echo "run as the service user, not root" >&2; exit 77; }
    [ -d "$ROOT/dist" ] || { echo "run 'npm run build' first" >&2; exit 1; }
    mkdir -p "$APP/app" "$LOGS" "$HOME/os-cli-inbox" "$HOME/Library/LaunchAgents"
    # run a copy: ~/Desktop, ~/Documents etc. are TCC-protected and a background job gets EPERM there
    rm -rf "$APP/app/dist" && cp -R "$ROOT/dist" "$ROOT/package.json" "$APP/app/"
    [ -e "$APP/config.json" ] || printf '{ "watchDir": "%s/os-cli-inbox", "workers": 2 }\n' "$HOME" > "$APP/config.json"
    sed -e "s|@NODE@|$(command -v node)|" -e "s|@APP@|$APP|g" -e "s|@LOGS@|$LOGS|g" "$ROOT/service/$LABEL.plist" > "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "started $LABEL as uid $(id -u); logs: $LOGS"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    ;;
  *)
    echo "usage: $0 install|uninstall" >&2
    exit 64
    ;;
esac
