#!/bin/bash
# Start with the installed configuration; only a first start installs defaults.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/com.autocompany.loop.plist"

if [ -e "$PLIST_PATH" ] || [ -L "$PLIST_PATH" ]; then
    exec /bin/bash "$SCRIPT_DIR/../core/stop-loop.sh" --resume-daemon
fi

# Do not replace a loaded agent whose configuration file has disappeared.
if [ "$(uname -s)" = Darwin ] && launchctl list com.autocompany.loop >/dev/null 2>&1; then
    echo "Error: Auto Company agent is loaded, but its plist is missing: $PLIST_PATH"
    echo "Restore the original configuration before starting."
    exit 1
fi
exec /bin/bash "$SCRIPT_DIR/install-daemon.sh"
