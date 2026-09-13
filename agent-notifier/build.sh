#!/usr/bin/env bash
# Builds "Agent Notifier.app" into ~/Applications (ad-hoc signed).
set -euo pipefail
cd "$(dirname "$0")"
APP="$HOME/Applications/Agent Notifier.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp Info.plist "$APP/Contents/Info.plist"
ICON=/Applications/Ghostty.app/Contents/Resources/Ghostty.icns
[ -f "$ICON" ] && cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
swiftc -O -target arm64-apple-macos13.0 -sdk "$(xcrun --sdk macosx --show-sdk-path)" -framework AppKit -framework UserNotifications -o "$APP/Contents/MacOS/agent-notifier" main.swift
codesign --force --sign - --identifier id.afgventura.agent-notifier "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" || true
echo "built: $APP"
