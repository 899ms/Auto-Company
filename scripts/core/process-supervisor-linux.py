#!/usr/bin/env python3
"""Own one Linux cycle, including orphaned descendants that call setsid().

The child subreaper is the lifetime boundary; PGIDs alone cannot contain a
daemonized child. Only descendants of this process are ever signalled.
"""

from __future__ import annotations

import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def process_identity(pid: int) -> str | None:
    try:
        return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
    except (OSError, IndexError):
        return None


def descendants() -> dict[int, str]:
    pending = [os.getpid()]
    owned: dict[int, str] = {}
    while pending:
        parent = pending.pop()
        try:
            # A worker thread can fork too; each task has its own children list.
            children = " ".join(path.read_text() for path in
                                Path(f"/proc/{parent}/task").glob("*/children"))
        except OSError:
            continue
        for value in children.split():
            pid = int(value)
            identity = process_identity(pid)
            if identity is not None and pid not in owned:
                owned[pid] = identity
                pending.append(pid)
    return owned


def send_owned(pid: int, identity: str, sig: int) -> None:
    descriptor = None
    try:
        # Pin the kernel process identity before checking it again: PID reuse
        # between discovery and signalling must not target a human session.
        descriptor = os.pidfd_open(pid)
        if process_identity(pid) == identity:
            signal.pidfd_send_signal(descriptor, sig)
    except ProcessLookupError:
        pass
    finally:
        if descriptor is not None:
            os.close(descriptor)


def supervise(timeout: int, grace: int, kill_wait: int, parent: int,
              cwd: str, command: list[str], owner_file: str) -> tuple[int, int, int]:
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "Cannot establish cycle child subreaper")
    # Fail before spawning on kernels/Python builds without safe PID signalling.
    descriptor = os.pidfd_open(os.getpid())
    os.close(descriptor)
    if not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("Python pidfd_send_signal is required on Linux")

    stopping = False

    def stop(_sig: int, _frame: object) -> None:
        nonlocal stopping
        stopping = True

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)

    if os.getppid() != parent:
        return 125, 0, 0
    child = subprocess.Popen(command, cwd=cwd, start_new_session=True)
    Path(owner_file).write_text(f"{child.pid}\n")
    root_exit = None

    def reap() -> bool:
        nonlocal root_exit
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return True
            if pid == 0:
                return False
            if pid == child.pid:
                root_exit = os.waitstatus_to_exitcode(status)
                child.returncode = root_exit

    deadline = time.monotonic() + timeout
    timed_out = 0
    while True:
        reap()
        if root_exit is not None or stopping or os.getppid() != parent:
            break
        if time.monotonic() >= deadline:
            timed_out = 1
            break
        time.sleep(0.05)

    # Even a successful root can leave orphans. Reaping until ECHILD confirms
    # that no descendant remains, independent of process groups and sessions.
    for sig, wait_seconds in ((signal.SIGTERM, grace), (signal.SIGKILL, kill_wait)):
        deadline = time.monotonic() + wait_seconds
        signalled: set[tuple[int, str]] = set()
        while True:
            if reap():
                code = root_exit if root_exit is not None else 125
                return (code if code >= 0 else 128 - code), timed_out, 0
            for pid, identity in descendants().items():
                if (pid, identity) not in signalled:
                    send_owned(pid, identity, sig)
                    signalled.add((pid, identity))
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
    if reap():
        code = root_exit if root_exit is not None else 125
        return (code if code >= 0 else 128 - code), timed_out, 0
    return 125, timed_out, 1


def main() -> int:
    result_file, timeout, grace, kill_wait, parent, cwd, *command = sys.argv[1:]
    result = (125, 0, 1)
    try:
        result = supervise(int(timeout), int(grace), int(kill_wait), int(parent), cwd, command,
                           result_file + ".owner")
    except Exception as exc:
        print(f"Cycle supervisor failed: {exc}", file=sys.stderr)
    Path(result_file).write_text("%d %d %d\n" % result)
    if result[2]:
        # Publish failure promptly, but retain the inherited checkout lock until
        # the kernel confirms all children are gone. A service restart must not
        # overlap an uninterruptible or otherwise unconfirmed old cycle.
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if pid == 0:
                for child_pid, identity in descendants().items():
                    try:
                        send_owned(child_pid, identity, signal.SIGKILL)
                    except OSError:
                        pass
                time.sleep(0.1)
    return 0 if result[2] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
