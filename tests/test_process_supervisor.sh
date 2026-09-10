#!/bin/bash
set -euo pipefail

TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$TEST_DIR/.." && pwd)"
SUPERVISOR_LIB="$PROJECT_DIR/scripts/core/process-supervisor.sh"
FAKE_ENGINE="$TEST_DIR/fixtures/fake-cycle-engine.sh"
SIGNAL_HARNESS="$TEST_DIR/fixtures/supervisor-signal-harness.sh"
TMP_ROOT=$(mktemp -d)
SENTINEL_PID=""
HARNESS_PID=""

source "$SUPERVISOR_LIB"

cleanup_test() {
    cycle_supervisor_cleanup >/dev/null 2>&1 || true
    if [ -n "$HARNESS_PID" ]; then
        kill -KILL "$HARNESS_PID" 2>/dev/null || true
        wait "$HARNESS_PID" 2>/dev/null || true
    fi
    if [ -n "$SENTINEL_PID" ]; then
        kill -TERM "$SENTINEL_PID" 2>/dev/null || true
        wait "$SENTINEL_PID" 2>/dev/null || true
    fi
    rm -rf "$TMP_ROOT"
}
trap cleanup_test EXIT

fail() {
    printf 'not ok - %s\n' "$1" >&2
    exit 1
}

assert_eq() {
    local expected="$1" actual="$2" message="$3"
    [ "$expected" = "$actual" ] || fail "$message (expected=$expected actual=$actual)"
}

assert_file() {
    [ -s "$1" ] || fail "$2"
}

pid_is_running() {
    local pid="$1" stat
    kill -0 "$pid" 2>/dev/null || return 1
    stat=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    case "$stat" in
        ""|Z*) return 1 ;;
        *) return 0 ;;
    esac
}

assert_tree_stopped() {
    local state_dir="$1" role pid
    for role in root child grandchild; do
        assert_file "$state_dir/$role.pid" "$role pid was not recorded"
        pid=$(cat "$state_dir/$role.pid")
        if pid_is_running "$pid"; then
            fail "$role process $pid is still running"
        fi
    done
}

wait_for_file() {
    local file="$1" waited=0
    while [ ! -s "$file" ]; do
        [ "$waited" -lt 100 ] || fail "timed out waiting for $file"
        sleep 0.05
        waited=$((waited + 1))
    done
}

run_normal_exit_test() {
    local state_dir="$TMP_ROOT/normal" output="$TMP_ROOT/normal.out"
    mkdir -p "$state_dir"

    cycle_supervisor_run 5 1 2 "$PROJECT_DIR" "$output" -- bash "$FAKE_ENGINE" normal "$state_dir"
    assert_eq 0 "$CYCLE_SUPERVISOR_EXIT_CODE" "normal exit code"
    assert_eq 0 "$CYCLE_SUPERVISOR_TIMED_OUT" "normal cycle timeout flag"
    assert_eq 0 "$CYCLE_SUPERVISOR_CLEANUP_FAILED" "normal cleanup"
    assert_eq fake-result "$(cat "$output")" "normal output"
    _cycle_supervisor_group_alive "$CYCLE_SUPERVISOR_LAST_PGID" && fail "normal cycle group survived"
    printf 'ok - normal exit\n'
}

run_timeout_test() {
    local state_dir="$TMP_ROOT/timeout" output="$TMP_ROOT/timeout.out"
    mkdir -p "$state_dir"

    # This process is outside the cycle PGID and represents a human session or
    # another repository. It must survive owned-tree cleanup.
    sleep 30 &
    SENTINEL_PID=$!

    cycle_supervisor_run 1 1 2 "$PROJECT_DIR" "$output" -- bash "$FAKE_ENGINE" timeout "$state_dir"
    assert_eq 1 "$CYCLE_SUPERVISOR_TIMED_OUT" "timeout flag"
    assert_eq 0 "$CYCLE_SUPERVISOR_CLEANUP_FAILED" "timeout cleanup"
    assert_tree_stopped "$state_dir"
    assert_file "$state_dir/root.term" "timeout root did not receive TERM before KILL"
    assert_file "$state_dir/child.term" "timeout child did not receive TERM before KILL"
    assert_file "$state_dir/grandchild.term" "timeout grandchild did not receive TERM before KILL"
    pid_is_running "$SENTINEL_PID" || fail "unrelated sentinel was killed"
    kill -TERM "$SENTINEL_PID" 2>/dev/null || true
    wait "$SENTINEL_PID" 2>/dev/null || true
    SENTINEL_PID=""
    printf 'ok - timeout TERM/KILL and ownership isolation\n'
}

run_orphan_test() {
    local state_dir="$TMP_ROOT/orphan" output="$TMP_ROOT/orphan.out"
    mkdir -p "$state_dir"

    cycle_supervisor_run 5 1 2 "$PROJECT_DIR" "$output" -- bash "$FAKE_ENGINE" orphan "$state_dir"
    assert_eq 0 "$CYCLE_SUPERVISOR_EXIT_CODE" "orphaning root exit code"
    assert_eq 0 "$CYCLE_SUPERVISOR_TIMED_OUT" "orphan cleanup timeout flag"
    assert_eq 0 "$CYCLE_SUPERVISOR_CLEANUP_FAILED" "orphan cleanup"
    assert_tree_stopped "$state_dir"
    assert_file "$state_dir/child.term" "orphan child did not receive TERM"
    assert_file "$state_dir/grandchild.term" "orphan grandchild did not receive TERM"
    printf 'ok - orphaned descendants\n'
}

run_stop_signal_test() {
    local state_dir="$TMP_ROOT/stop"
    mkdir -p "$state_dir"

    bash "$SIGNAL_HARNESS" "$SUPERVISOR_LIB" "$FAKE_ENGINE" "$state_dir" &
    HARNESS_PID=$!
    wait_for_file "$state_dir/grandchild.pid"
    kill -TERM "$HARNESS_PID"
    wait "$HARNESS_PID"
    HARNESS_PID=""

    assert_file "$state_dir/harness.cleaned" "signal harness did not report cleanup"
    assert_eq clean "$(cat "$state_dir/harness.cleaned")" "signal cleanup result"
    [ ! -e "$state_dir/harness.returned" ] || fail "signal harness resumed cycle after cleanup"
    assert_tree_stopped "$state_dir"
    assert_file "$state_dir/root.term" "stop root did not receive TERM"
    assert_file "$state_dir/child.term" "stop child did not receive TERM"
    assert_file "$state_dir/grandchild.term" "stop grandchild did not receive TERM"
    printf 'ok - stop signal\n'
}

run_idempotent_cleanup_test() {
    cycle_supervisor_cleanup || fail "first idempotent cleanup failed"
    cycle_supervisor_cleanup || fail "second idempotent cleanup failed"
    printf 'ok - idempotent cleanup\n'
}

run_detached_tests() {
    [ "$(uname -s)" = Linux ] || return 0
    local mode state_dir
    for mode in detached detached-timeout; do
        state_dir="$TMP_ROOT/$mode"
        mkdir -p "$state_dir"
        cycle_supervisor_run 1 1 2 "$PROJECT_DIR" "$state_dir/output" -- bash "$FAKE_ENGINE" "$mode" "$state_dir"
        assert_tree_stopped "$state_dir"
        assert_eq 0 "$CYCLE_SUPERVISOR_CLEANUP_FAILED" "$mode cleanup"
        assert_file "$state_dir/child.term" "$mode child did not receive TERM"
        assert_file "$state_dir/grandchild.term" "$mode grandchild did not receive TERM"
    done
    printf 'ok - Linux setsid descendants on root exit and timeout\n'
}

run_owner_killed_test() {
    [ "$(uname -s)" = Linux ] || return 0
    local state_dir="$TMP_ROOT/owner-killed" waited=0
    mkdir -p "$state_dir"
    bash "$SIGNAL_HARNESS" "$SUPERVISOR_LIB" "$FAKE_ENGINE" "$state_dir" &
    HARNESS_PID=$!
    wait_for_file "$state_dir/grandchild.pid"
    kill -KILL "$HARNESS_PID"
    wait "$HARNESS_PID" 2>/dev/null || true
    HARNESS_PID=""
    while pid_is_running "$(cat "$state_dir/grandchild.pid")"; do
        [ "$waited" -lt 100 ] || fail "subreaper did not recover after loop SIGKILL"
        sleep 0.05
        waited=$((waited + 1))
    done
    assert_tree_stopped "$state_dir"
    printf 'ok - Linux owner SIGKILL recovery\n'
}

run_threaded_tree_test() {
    [ "$(uname -s)" = Linux ] || return 0
    local state_dir="$TMP_ROOT/threaded"
    mkdir -p "$state_dir"
    cycle_supervisor_run 1 1 2 "$PROJECT_DIR" "$state_dir/output" -- \
        python3 "$TEST_DIR/fixtures/threaded-cycle-engine.py" "$FAKE_ENGINE" "$state_dir"
    assert_tree_stopped "$state_dir"
    assert_file "$state_dir/child.term" "thread-spawned child did not receive TERM"
    assert_file "$state_dir/grandchild.term" "thread-spawned grandchild did not receive TERM"
    printf 'ok - Linux worker-thread descendants receive TERM grace\n'
}

run_normal_exit_test
run_timeout_test
run_orphan_test
run_stop_signal_test
run_idempotent_cleanup_test
run_detached_tests
run_owner_killed_test
run_threaded_tree_test
printf 'process supervisor checks passed\n'
