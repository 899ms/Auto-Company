#!/bin/bash
# ============================================================
# Auto Company — Install/Uninstall launchd Daemon (macOS)
# ============================================================
# Generates a launchd plist dynamically based on current paths,
# installs it to ~/Library/LaunchAgents/, and loads it.
#
# Usage:
#   ./install-daemon.sh             # Install and start
#   ./install-daemon.sh --uninstall # Stop and remove
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LABEL="com.autocompany.loop"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
PAUSE_FLAG="${PROJECT_DIR}/.auto-loop-paused"
OS_NAME="$(uname -s)"
ENGINE="${ENGINE:-claude}"
ENGINE="$(echo "$ENGINE" | tr '[:upper:]' '[:lower:]')"
MODEL="${MODEL:-}"
CLAUDE_BIN="${CLAUDE_BIN:-}"
CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-bypassPermissions}"
CODEX_BIN="${CODEX_BIN:-}"
CODEX_SANDBOX_MODE="${CODEX_SANDBOX_MODE:-danger-full-access}"

source "$SCRIPT_DIR/../core/engine-adapters.sh"

if [ "$OS_NAME" != "Darwin" ]; then
    echo "install-daemon.sh supports macOS launchd only."
    echo "Current OS: $OS_NAME"
    echo "Use foreground mode instead: make start"
    exit 1
fi

# --- Uninstall ---
if [ "${1:-}" = "--uninstall" ]; then
    echo "Uninstalling Auto Company daemon..."
    if launchctl list | grep -q "$LABEL"; then
        launchctl unload "$PLIST_PATH" 2>/dev/null || true
        echo "Service unloaded."
    fi
    if [ -f "$PLIST_PATH" ]; then
        rm -f "$PLIST_PATH"
        echo "Plist removed: $PLIST_PATH"
    fi
    echo "Done. Daemon uninstalled."
    exit 0
fi

# --- Install ---

engine_adapter_validate
command -v python3 >/dev/null 2>&1 || {
    echo "Error: Python 3 is required for runtime accounting and launchd configuration."
    exit 1
}

# Check dependencies by selected engine
ENGINE_PATH=""
if ! ENGINE_PATH="$(engine_adapter_resolve)"; then
    echo "Error: $(engine_adapter_missing_dependency_message)"
    exit 1
fi

ENGINE_DIR="$(dirname "$ENGINE_PATH")"

# Detect node path (for wrangler/npx)
NODE_DIR=""
if command -v node &>/dev/null; then
    NODE_DIR="$(dirname "$(command -v node)")"
fi

# Build PATH: include all tool directories
DAEMON_PATH="${ENGINE_DIR}"
[ -n "$NODE_DIR" ] && DAEMON_PATH="${DAEMON_PATH}:${NODE_DIR}"
DAEMON_PATH="${DAEMON_PATH}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

echo "Installing Auto Company daemon..."
echo "  Project: $PROJECT_DIR"
echo "  Engine:  $ENGINE"
echo "  CLI:     $ENGINE_PATH"
engine_version="$("$ENGINE_PATH" --version 2>/dev/null | head -n1 | adapter_redact || true)"
if [ -n "$engine_version" ]; then
    echo "  Version: $engine_version"
fi
echo "  PATH:    $DAEMON_PATH"
if [ "$ENGINE" = "openai-compatible" ] && [ -n "${OPENAI_COMPATIBLE_API_KEY:-}" ]; then
    echo "  Notice: OPENAI_COMPATIBLE_API_KEY is intentionally not written to the launchd plist."
    echo "          Use a secure process-environment injector for authenticated endpoints."
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/logs"
# Install implies active running state
rm -f "$PAUSE_FLAG"

# Unload existing if running
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Export resolved defaults; explicit timeout and budget settings are inherited.
# The renderer allowlists settings, excludes API keys, and escapes XML values.
export ENGINE MODEL CLAUDE_BIN CLAUDE_PERMISSION_MODE CODEX_BIN CODEX_SANDBOX_MODE
export CURSOR_BIN CURSOR_ADAPTER_ENABLED CURSOR_SANDBOX_MODE CURSOR_FORCE CURSOR_ALLOW_UNSANDBOXED
export OPENAI_COMPATIBLE_ADAPTER_ENABLED OPENAI_COMPATIBLE_ENDPOINT OPENAI_COMPATIBLE_MODEL
export OPENAI_COMPATIBLE_ALLOW_SHELL OPENAI_COMPATIBLE_ALLOW_INSECURE_HTTP
python3 "$SCRIPT_DIR/../core/launchd-config.py" \
    --project "$PROJECT_DIR" --path "$DAEMON_PATH" --output "$PLIST_PATH"

echo "Plist written: $PLIST_PATH"

# Load
launchctl load "$PLIST_PATH"
echo ""
echo "Daemon installed and started!"
echo ""
echo "Commands:"
echo "  ./monitor.sh            # Watch live logs"
echo "  ./monitor.sh --status   # Check status"
echo "  ./stop-loop.sh          # Stop the loop (daemon will restart it)"
echo "  ./stop-loop.sh --pause-daemon   # Pause daemon (no auto-restart)"
echo "  ./stop-loop.sh --resume-daemon  # Resume daemon"
echo "  ./install-daemon.sh --uninstall  # Remove daemon completely"
