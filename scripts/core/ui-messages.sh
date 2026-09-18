#!/bin/bash
# Human-facing output only. Never source operator configuration or use eval.
UI_MESSAGES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ui_message() {
    local key="$1" value
    shift
    local arguments=()
    for value in "$@"; do
        arguments+=("--arg=$value")
    done
    if command -v python3 >/dev/null 2>&1 && \
        python3 "$UI_MESSAGES_DIR/localization.py" message \
            --root "${PROJECT_DIR:-$UI_MESSAGES_DIR/../..}" --key "$key" "${arguments[@]}"; then
        return 0
    fi
    # Python is unavailable: keep dependency diagnostics useful without hiding
    # the original engine/service error or executing a configuration value.
    printf '%s\n' '提示：请安装 Python 3 并确认 python3 在 PATH 中。 / Install Python 3 and ensure python3 is on PATH.'
    printf '[%s]' "$key"
    printf ' %s' "$@"
    printf '\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    PROJECT_DIR="$(cd "$UI_MESSAGES_DIR/../.." && pwd)"
    if [ "${1:-}" = "help" ]; then
        if command -v python3 >/dev/null 2>&1; then
            python3 "$UI_MESSAGES_DIR/localization.py" help --root "$PROJECT_DIR"
        else
            ui_message python.required
            # The English Makefile comments remain an emergency offline help.
            while IFS= read -r line; do
                [[ "$line" =~ ^([a-zA-Z_-]+):.*\#\#\ (.*)$ ]] && \
                    printf '  %-24s %s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
            done < "$PROJECT_DIR/Makefile"
            true
        fi
    else
        ui_message "$@"
    fi
fi
