#!/bin/bash
# Restart lark-bridge via LaunchAgent (prevents duplicate instances)
# Usage: ./restart.sh
set -e

LABEL="com.kanlu.lark-bridge"
UID_VAL=$(id -u)

echo "Restarting $LABEL..."
# kickstart -k kills existing instance first, then starts fresh
launchctl kickstart -k "gui/$UID_VAL/$LABEL" 2>/dev/null || {
  # If kickstart fails (service not loaded), try bootout+bootstrap
  launchctl bootout "gui/$UID_VAL/$LABEL" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$UID_VAL" ~/Library/LaunchAgents/$LABEL.plist
}
sleep 2
echo "Bridge restarted. Tailing log (Ctrl+C to stop):"
tail -f ~/Library/Logs/lark-bridge.log
