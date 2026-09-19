#!/usr/bin/env python3
"""A single-process WSL keepalive, owned by its checkout and locked identity.

The Windows launcher may disappear without terminating a Linux child. Poll the
shared stop marker here as well; never leave a shell/sleep subtree behind.
"""

import fcntl
import json
import os
from pathlib import Path
import signal
import select
import sys
import time


ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".auto-loop-wsl-anchor.linux"
STOP = ROOT / ".auto-loop-wsl-anchor.stop"


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        return {"pid": pid, "start": fields[19],
                "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}
    except (FileNotFoundError, ProcessLookupError):
        return None


def owned():
    if not STATE.exists():
        return None
    with STATE.open("r+") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return None  # An unlocked record is stale; never signal its PID.
        except BlockingIOError:
            record = json.load(stream)
        pid = record["pid"]
        current = identity(pid)
        if current is None:
            return None
        args = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        if (current != {key: record[key] for key in ("pid", "start", "boot")}
                or os.fsencode(str(Path(__file__).resolve())) not in args
                or os.fsencode(record["token"]) not in args):
            if identity(pid) is None:
                return None
            raise RuntimeError("WSL anchor ownership could not be confirmed; no process was signalled.")
        return record


def run(token):
    with STATE.open("a+") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        record = dict(identity(os.getpid()), token=token)
        stream.seek(0)
        stream.truncate()
        json.dump(record, stream)
        stream.flush()
        stopping = False

        def request_stop(*_):
            nonlocal stopping
            stopping = True

        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, request_stop)
        while not stopping and not STOP.exists():
            time.sleep(0.1)


def stop():
    STOP.touch()
    record = owned()
    if record is None:
        return
    try:
        descriptor = os.pidfd_open(record["pid"])
    except ProcessLookupError:
        return
    try:
        # Validate again after opening the handle, which pins this generation.
        if select.select([descriptor], [], [], 0)[0]:
            return
        if owned() != record:
            raise RuntimeError("WSL anchor ownership changed; no process was signalled.")
        for sig in (None, signal.SIGTERM, signal.SIGKILL):
            if sig is not None:
                signal.pidfd_send_signal(descriptor, sig)
            if select.select([descriptor], [], [], 2)[0]:
                return
        raise RuntimeError("WSL anchor cleanup is incomplete.")
    finally:
        os.close(descriptor)


def main():
    action = sys.argv[1]
    if action == "run":
        run(sys.argv[2])
    elif action == "stop":
        stop()
        print("WSL anchor Linux: STOPPED")
    elif action == "status":
        print("WSL anchor Linux: " + ("RUNNING" if owned() else "STOPPED"))
    else:
        raise ValueError("Unsupported anchor action")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError) as exc:
        print(f"WSL anchor: cleanup unconfirmed: {exc}", file=sys.stderr)
        raise SystemExit(1)
