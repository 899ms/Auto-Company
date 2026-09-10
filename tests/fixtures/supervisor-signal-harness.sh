#!/bin/bash
set -euo pipefail

supervisor_lib="$1"
fake_engine="$2"
state_dir="$3"
output_file="$state_dir/output.log"

source "$supervisor_lib"

stop_harness() {
    trap - SIGTERM SIGINT SIGHUP
    if cycle_supervisor_cleanup && cycle_supervisor_cleanup; then
        printf 'clean\n' > "$state_dir/harness.cleaned"
        exit 0
    fi
    printf 'failed\n' > "$state_dir/harness.cleaned"
    exit 1
}

trap stop_harness SIGTERM SIGINT SIGHUP
printf '%s\n' "$$" > "$state_dir/harness.pid"
cycle_supervisor_run 30 1 2 "$state_dir" "$output_file" -- bash "$fake_engine" stop "$state_dir"
printf 'unexpected-return\n' > "$state_dir/harness.returned"
