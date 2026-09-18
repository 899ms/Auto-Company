#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_command=(git)
elif command -v git.exe >/dev/null 2>&1 \
    && git.exe rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git_command=(git.exe)
else
    echo "Unable to inspect the checkout's tracked file modes." >&2
    exit 1
fi

entrypoints=(
    scripts/core/auto-loop.sh
    scripts/core/consensus-guard.sh
    scripts/core/monitor.sh
    scripts/core/project.sh
    scripts/core/stop-loop.sh
    scripts/macos/install-daemon.sh
    scripts/macos/start-daemon.sh
    scripts/wsl/dashboard-wsl.sh
    scripts/wsl/install-wsl-daemon.sh
    scripts/wsl/uninstall-wsl-daemon.sh
)

for entrypoint in "${entrypoints[@]}"; do
    mode="$("${git_command[@]}" ls-files --stage -- "$entrypoint" | awk '{print $1}')"
    if [ "$mode" != "100755" ]; then
        echo "Expected executable git mode for $entrypoint, got ${mode:-untracked}." >&2
        exit 1
    fi
done

if output="$(ENGINE=invalid make start 2>&1)"; then
    echo "Expected make start to reject the invalid test engine." >&2
    exit 1
fi

if printf '%s\n' "$output" | grep -qi "permission denied"; then
    printf '%s\n' "$output" >&2
    echo "make start failed because the shell entrypoint was not executable." >&2
    exit 1
fi

if ! printf '%s\n' "$output" | grep -Fq "Unsupported ENGINE 'invalid'"; then
    printf '%s\n' "$output" >&2
    echo "make start did not reach the expected invalid-engine guard." >&2
    exit 1
fi

set +e
output="$(ENGINE=claude CLAUDE_PERMISSION_MODE=manual ./scripts/core/auto-loop.sh 2>&1)"
status=$?
set -e
if [ "$status" -ne 78 ]; then
    printf '%s\n' "$output" >&2
    echo "Expected invalid adapter configuration to exit with EX_CONFIG (78), got $status." >&2
    exit 1
fi
if ! printf '%s\n' "$output" | grep -Fq "CLAUDE_PERMISSION_MODE must be one of"; then
    printf '%s\n' "$output" >&2
    echo "Invalid Claude permission mode did not produce an actionable configuration error." >&2
    exit 1
fi

if ! grep -Fq "RestartPreventExitStatus=78" scripts/wsl/install-wsl-daemon.sh; then
    echo "WSL daemon must not restart after an EX_CONFIG failure." >&2
    exit 1
fi

echo "Shell entrypoint modes and safe make start failure verified."
