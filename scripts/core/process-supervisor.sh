#!/bin/bash
# Cycle-scoped process supervision for auto-loop.sh.
#
# Linux uses a child subreaper to contain setsid and orphaned descendants.
# Other platforms start each engine command in its own process group. The group ID
# is the cycle ownership boundary: descendants inherit it even if their parent
# exits and they are re-parented. Cleanup selects targets only by that owned
# PGID, never by executable name or working directory.

CYCLE_SUPERVISOR_ACTIVE_PID=""
CYCLE_SUPERVISOR_ACTIVE_PGID=""
CYCLE_SUPERVISOR_TIMER_PID=""
CYCLE_SUPERVISOR_TIMEOUT_FLAG=""
CYCLE_SUPERVISOR_TERM_GRACE="5"
CYCLE_SUPERVISOR_KILL_WAIT="5"
CYCLE_SUPERVISOR_EXIT_CODE=0
CYCLE_SUPERVISOR_TIMED_OUT=0
CYCLE_SUPERVISOR_CLEANUP_FAILED=0
CYCLE_SUPERVISOR_LAST_PGID=""
CYCLE_SUPERVISOR_LINUX_RESULT=""
CYCLE_SUPERVISOR_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

_cycle_supervisor_linux_result() {
    if [ -s "$CYCLE_SUPERVISOR_LINUX_RESULT.owner" ]; then
        read -r CYCLE_SUPERVISOR_LAST_PGID < "$CYCLE_SUPERVISOR_LINUX_RESULT.owner"
    fi
    if [ -s "$CYCLE_SUPERVISOR_LINUX_RESULT" ]; then
        read -r CYCLE_SUPERVISOR_EXIT_CODE CYCLE_SUPERVISOR_TIMED_OUT CYCLE_SUPERVISOR_CLEANUP_FAILED < "$CYCLE_SUPERVISOR_LINUX_RESULT"
    else
        CYCLE_SUPERVISOR_CLEANUP_FAILED=1
    fi
    if [ "$CYCLE_SUPERVISOR_CLEANUP_FAILED" -eq 0 ]; then
        CYCLE_SUPERVISOR_ACTIVE_PID=""
        CYCLE_SUPERVISOR_ACTIVE_PGID=""
        rm -f "$CYCLE_SUPERVISOR_LINUX_RESULT" "$CYCLE_SUPERVISOR_LINUX_RESULT.owner"
        CYCLE_SUPERVISOR_LINUX_RESULT=""
    fi
    [ "$CYCLE_SUPERVISOR_CLEANUP_FAILED" -eq 0 ]
}

_cycle_supervisor_run_linux() {
    local timeout="$1" term_grace="$2" kill_wait="$3" cwd="$4" output_file="$5"
    shift 5
    CYCLE_SUPERVISOR_LINUX_RESULT=$(mktemp)
    CYCLE_SUPERVISOR_EXIT_CODE=0
    CYCLE_SUPERVISOR_TIMED_OUT=0
    CYCLE_SUPERVISOR_CLEANUP_FAILED=0
    CYCLE_SUPERVISOR_TERM_GRACE="$term_grace"
    CYCLE_SUPERVISOR_KILL_WAIT="$kill_wait"
    python3 "$CYCLE_SUPERVISOR_LIB_DIR/process-supervisor-linux.py" \
        "$CYCLE_SUPERVISOR_LINUX_RESULT" "$timeout" "$term_grace" "$kill_wait" \
        "$$" "$cwd" "$@" < /dev/null > "$output_file" 2>&1 &
    CYCLE_SUPERVISOR_ACTIVE_PID=$!
    # The Python owner creates the engine's session and reports completion only
    # after every adopted child has been reaped. Do not kill its process group.
    CYCLE_SUPERVISOR_ACTIVE_PGID=""
    CYCLE_SUPERVISOR_LAST_PGID=""
    while [ ! -s "$CYCLE_SUPERVISOR_LINUX_RESULT" ] && kill -0 "$CYCLE_SUPERVISOR_ACTIVE_PID" 2>/dev/null; do
        sleep 0.05
    done
    # Failed cleanup can leave the recovery owner alive holding the checkout
    # lock. Do not wait indefinitely for an uninterruptible child here.
    if [ -s "$CYCLE_SUPERVISOR_LINUX_RESULT" ]; then
        read -r CYCLE_SUPERVISOR_EXIT_CODE CYCLE_SUPERVISOR_TIMED_OUT CYCLE_SUPERVISOR_CLEANUP_FAILED < "$CYCLE_SUPERVISOR_LINUX_RESULT"
    fi
    if [ "$CYCLE_SUPERVISOR_CLEANUP_FAILED" -eq 0 ]; then
        wait "$CYCLE_SUPERVISOR_ACTIVE_PID" 2>/dev/null || true
    fi
    _cycle_supervisor_linux_result
}

_cycle_supervisor_valid_seconds() {
    case "$1" in
        ""|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

cycle_supervisor_validate_config() {
    _cycle_supervisor_valid_seconds "$1" &&
        _cycle_supervisor_valid_seconds "$2" &&
        _cycle_supervisor_valid_seconds "$3"
}

_cycle_supervisor_group_alive() {
    local pgid="$1" process_table
    [ -n "$pgid" ] || return 1

    # kill -0 also reports zombie-only groups as alive. Zombies have exited and
    # cannot edit the repository, so inspect the owned PGID and require at least
    # one non-zombie member. Fall back to kill -0 only if ps itself is missing.
    if process_table=$(ps -axo pgid=,stat= 2>/dev/null); then
        echo "$process_table" | awk -v owned_pgid="$pgid" '
            $1 == owned_pgid && $2 !~ /^Z/ { found = 1 }
            END { exit(found ? 0 : 1) }
        '
        return $?
    fi
    kill -0 -- "-$pgid" 2>/dev/null
}

_cycle_supervisor_current_pgid() {
    ps -o pgid= -p $$ 2>/dev/null | tr -d '[:space:]'
}

_cycle_supervisor_validate_owned_pgid() {
    local pgid="$1" current_pgid
    case "$pgid" in
        ""|*[!0-9]*) return 1 ;;
    esac

    current_pgid=$(_cycle_supervisor_current_pgid)
    [ -n "$current_pgid" ] || return 1
    [ "$pgid" != "$current_pgid" ] || return 1
    return 0
}

_cycle_supervisor_wait_group_gone() {
    local pgid="$1" limit="$2" waited=0

    while _cycle_supervisor_group_alive "$pgid"; do
        [ "$waited" -lt "$limit" ] || return 1
        sleep 1
        waited=$((waited + 1))
    done
    return 0
}

# TERM the owned group, wait a bounded grace period, then KILL and verify it is
# gone. A non-zero result is fail-closed: the caller must not start another
# cycle because ownership cleanup could not be confirmed.
_cycle_supervisor_terminate_group() {
    local pgid="$1" term_grace="$2" kill_wait="$3"

    _cycle_supervisor_group_alive "$pgid" || return 0
    _cycle_supervisor_validate_owned_pgid "$pgid" || return 1

    kill -TERM -- "-$pgid" 2>/dev/null || true
    if _cycle_supervisor_wait_group_gone "$pgid" "$term_grace"; then
        return 0
    fi

    kill -KILL -- "-$pgid" 2>/dev/null || true
    _cycle_supervisor_wait_group_gone "$pgid" "$kill_wait"
}

_cycle_supervisor_watchdog_stop() {
    local sleeper_pid="$1"
    if [ -n "$sleeper_pid" ]; then
        kill -TERM "$sleeper_pid" 2>/dev/null || true
        wait "$sleeper_pid" 2>/dev/null || true
    fi
    exit 0
}

_cycle_supervisor_watchdog() {
    local timeout="$1" timeout_flag="$2" pgid="$3" term_grace="$4" kill_wait="$5"
    local sleeper_pid="" waited=0

    trap '_cycle_supervisor_watchdog_stop "$sleeper_pid"' SIGTERM SIGINT SIGHUP
    while [ "$waited" -lt "$timeout" ]; do
        # If auto-loop is SIGKILLed, this watchdog survives long enough to clean
        # its engine group, but exits promptly once that owned group is empty.
        # This prevents a stale long-running timer from targeting a reused PGID.
        _cycle_supervisor_group_alive "$pgid" || exit 0
        sleep 1 &
        sleeper_pid=$!
        if ! wait "$sleeper_pid" 2>/dev/null; then
            exit 0
        fi
        sleeper_pid=""
        waited=$((waited + 1))
    done

    _cycle_supervisor_group_alive "$pgid" || exit 0
    printf '1\n' > "$timeout_flag"
    _cycle_supervisor_terminate_group "$pgid" "$term_grace" "$kill_wait" || true
}

_cycle_supervisor_cancel_watchdog() {
    local timer_pid="$CYCLE_SUPERVISOR_TIMER_PID"
    [ -n "$timer_pid" ] || return 0

    kill -TERM "$timer_pid" 2>/dev/null || true
    wait "$timer_pid" 2>/dev/null || true
    CYCLE_SUPERVISOR_TIMER_PID=""
}

_cycle_supervisor_finish_watchdog() {
    local timeout_flag="$1" timer_pid="$CYCLE_SUPERVISOR_TIMER_PID"
    [ -n "$timer_pid" ] || return 0

    if [ -s "$timeout_flag" ]; then
        wait "$timer_pid" 2>/dev/null || true
    else
        _cycle_supervisor_cancel_watchdog
    fi
    CYCLE_SUPERVISOR_TIMER_PID=""
}

# cycle_supervisor_run <timeout> <term-grace> <kill-wait> <cwd> <output> -- <command...>
#
# Results are returned through CYCLE_SUPERVISOR_* globals so an engine's real
# exit code (including non-zero) does not interact with the caller's set -e.
cycle_supervisor_run() {
    local timeout="$1" term_grace="$2" kill_wait="$3" cwd="$4" output_file="$5"
    shift 5
    [ "${1:-}" = "--" ] || return 2
    shift
    [ "$#" -gt 0 ] || return 2

    cycle_supervisor_validate_config "$timeout" "$term_grace" "$kill_wait" || return 2

    if [ "$(uname -s)" = "Linux" ]; then
        _cycle_supervisor_run_linux "$timeout" "$term_grace" "$kill_wait" "$cwd" "$output_file" "$@"
        return $?
    fi

    local gate_file monitor_was_enabled=0 pid pgid raw_exit=0 timeout_flag supervisor_pid=$$
    gate_file=$(mktemp)
    timeout_flag=$(mktemp)
    : > "$gate_file"
    : > "$timeout_flag"

    CYCLE_SUPERVISOR_EXIT_CODE=0
    CYCLE_SUPERVISOR_TIMED_OUT=0
    CYCLE_SUPERVISOR_CLEANUP_FAILED=0
    CYCLE_SUPERVISOR_TERM_GRACE="$term_grace"
    CYCLE_SUPERVISOR_KILL_WAIT="$kill_wait"
    CYCLE_SUPERVISOR_TIMEOUT_FLAG="$timeout_flag"

    case $- in
        *m*) monitor_was_enabled=1 ;;
    esac
    set -m
    (
        while [ ! -s "$gate_file" ]; do
            kill -0 "$supervisor_pid" 2>/dev/null || exit 1
            sleep 0.05
        done
        rm -f "$gate_file"
        cd "$cwd" || exit 1
        exec "$@"
    ) < /dev/null > "$output_file" 2>&1 &
    pid=$!
    [ "$monitor_was_enabled" -eq 1 ] || set +m

    CYCLE_SUPERVISOR_ACTIVE_PID="$pid"
    CYCLE_SUPERVISOR_ACTIVE_PGID="$pid"
    CYCLE_SUPERVISOR_LAST_PGID="$pid"

    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    if [ "$pgid" != "$pid" ] || ! _cycle_supervisor_validate_owned_pgid "$pgid"; then
        kill -TERM "$pid" 2>/dev/null || true
        printf '1\n' > "$gate_file"
        wait "$pid" 2>/dev/null || true
        rm -f "$gate_file" "$timeout_flag"
        CYCLE_SUPERVISOR_ACTIVE_PID=""
        CYCLE_SUPERVISOR_ACTIVE_PGID=""
        CYCLE_SUPERVISOR_TIMEOUT_FLAG=""
        CYCLE_SUPERVISOR_CLEANUP_FAILED=1
        return 1
    fi

    printf '1\n' > "$gate_file"

    _cycle_supervisor_watchdog "$timeout" "$timeout_flag" "$pgid" "$term_grace" "$kill_wait" &
    CYCLE_SUPERVISOR_TIMER_PID=$!

    if wait "$pid" 2>/dev/null; then
        raw_exit=0
    else
        raw_exit=$?
    fi
    CYCLE_SUPERVISOR_EXIT_CODE="$raw_exit"

    _cycle_supervisor_finish_watchdog "$timeout_flag"
    if [ -s "$timeout_flag" ]; then
        CYCLE_SUPERVISOR_TIMED_OUT=1
    fi

    # A successful root process may still have orphaned descendants. The group
    # must be empty before ownership is released to the next cycle.
    if ! _cycle_supervisor_terminate_group "$pgid" "$term_grace" "$kill_wait"; then
        CYCLE_SUPERVISOR_CLEANUP_FAILED=1
    else
        CYCLE_SUPERVISOR_ACTIVE_PID=""
        CYCLE_SUPERVISOR_ACTIVE_PGID=""
    fi

    rm -f "$timeout_flag"
    CYCLE_SUPERVISOR_TIMEOUT_FLAG=""
    [ "$CYCLE_SUPERVISOR_CLEANUP_FAILED" -eq 0 ]
}

# Idempotent shutdown hook for auto-loop signals and explicit cleanup.
cycle_supervisor_cleanup() {
    local pid="$CYCLE_SUPERVISOR_ACTIVE_PID" pgid="$CYCLE_SUPERVISOR_ACTIVE_PGID"
    local cleanup_ok=0

    if [ -n "$CYCLE_SUPERVISOR_LINUX_RESULT" ]; then
        if [ -n "$pid" ] && [ ! -s "$CYCLE_SUPERVISOR_LINUX_RESULT" ]; then
            kill -TERM "$pid" 2>/dev/null || true
            local waited=0 limit=$((CYCLE_SUPERVISOR_TERM_GRACE + CYCLE_SUPERVISOR_KILL_WAIT + 2))
            while [ ! -s "$CYCLE_SUPERVISOR_LINUX_RESULT" ] && kill -0 "$pid" 2>/dev/null; do
                if [ "$waited" -ge "$limit" ]; then
                    # Leave the owner alive holding its inherited checkout lock;
                    # killing it would release unreaped descendants.
                    CYCLE_SUPERVISOR_CLEANUP_FAILED=1
                    return 1
                fi
                sleep 1
                waited=$((waited + 1))
            done
            if [ -s "$CYCLE_SUPERVISOR_LINUX_RESULT" ]; then
                read -r CYCLE_SUPERVISOR_EXIT_CODE CYCLE_SUPERVISOR_TIMED_OUT CYCLE_SUPERVISOR_CLEANUP_FAILED < "$CYCLE_SUPERVISOR_LINUX_RESULT"
            fi
            if [ "$CYCLE_SUPERVISOR_CLEANUP_FAILED" -eq 0 ]; then
                wait "$pid" 2>/dev/null || true
            fi
        fi
        _cycle_supervisor_linux_result
        return $?
    fi

    _cycle_supervisor_cancel_watchdog

    if [ -n "$pgid" ]; then
        if ! _cycle_supervisor_terminate_group "$pgid" "$CYCLE_SUPERVISOR_TERM_GRACE" "$CYCLE_SUPERVISOR_KILL_WAIT"; then
            cleanup_ok=1
            CYCLE_SUPERVISOR_CLEANUP_FAILED=1
        fi
    fi

    if [ -n "$pid" ]; then
        wait "$pid" 2>/dev/null || true
    fi

    if [ "$cleanup_ok" -eq 0 ]; then
        CYCLE_SUPERVISOR_ACTIVE_PID=""
        CYCLE_SUPERVISOR_ACTIVE_PGID=""
        if [ -n "$CYCLE_SUPERVISOR_TIMEOUT_FLAG" ]; then
            rm -f "$CYCLE_SUPERVISOR_TIMEOUT_FLAG"
        fi
        CYCLE_SUPERVISOR_TIMEOUT_FLAG=""
    fi

    [ "$cleanup_ok" -eq 0 ]
}
