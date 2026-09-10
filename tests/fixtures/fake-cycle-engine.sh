#!/bin/bash
set -u

mode="$1"
state_dir="$2"
script_path="$0"
mkdir -p "$state_dir"

record_pid() {
    printf '%s\n' "$$" > "$state_dir/$1.pid"
}

wait_for_tree() {
    local waited=0
    while [ ! -s "$state_dir/child.pid" ] || [ ! -s "$state_dir/grandchild.pid" ]; do
        [ "$waited" -lt 100 ] || exit 2
        sleep 0.05
        waited=$((waited + 1))
    done
}

on_term() {
    printf 'TERM\n' > "$state_dir/$1.term"
    exit 0
}

on_term_continue() {
    printf 'TERM\n' > "$state_dir/$1.term"
}

case "$mode" in
    normal)
        record_pid root
        printf 'fake-result\n'
        ;;
    timeout)
        record_pid root
        trap 'on_term_continue root' SIGTERM
        bash "$script_path" child-ignore "$state_dir" &
        wait_for_tree
        while true; do wait || true; done
        ;;
    child-ignore)
        record_pid child
        trap 'on_term_continue child' SIGTERM
        bash "$script_path" grandchild-ignore "$state_dir" &
        while true; do wait || true; done
        ;;
    grandchild-ignore)
        record_pid grandchild
        trap 'on_term_continue grandchild' SIGTERM
        while true; do sleep 1; done
        ;;
    detached|detached-timeout)
        record_pid root
        setsid bash "$script_path" child-ignore "$state_dir" &
        wait_for_tree
        if [ "$mode" = "detached-timeout" ]; then
            while true; do sleep 1; done
        fi
        exit 0
        ;;
    orphan)
        record_pid root
        bash "$script_path" child-term "$state_dir" &
        wait_for_tree
        exit 0
        ;;
    stop)
        record_pid root
        trap 'on_term root' SIGTERM
        bash "$script_path" child-term "$state_dir" &
        wait_for_tree
        wait
        ;;
    child-term)
        record_pid child
        trap 'on_term child' SIGTERM
        bash "$script_path" grandchild-term "$state_dir" &
        wait
        ;;
    grandchild-term)
        record_pid grandchild
        trap 'on_term grandchild' SIGTERM
        while true; do sleep 1; done
        ;;
    *)
        printf 'unknown fake engine mode: %s\n' "$mode" >&2
        exit 2
        ;;
esac
