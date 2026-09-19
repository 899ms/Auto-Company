"""Owned renderer process scopes; exited leaders do not orphan their previews."""
from __future__ import annotations

import os
from pathlib import Path
import signal
import subprocess
import time


def proc_identity(pid):
    if not Path("/proc").is_dir():
        return next((row for row in posix_rows(pid) if row["pid"] == pid), None) if os.name != "nt" else None
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return {"pid": pid, "ppid": int(fields[1]), "group": int(fields[2]), "session": int(fields[3]), "start": int(fields[19]), "state": fields[0]}
    except (OSError, ValueError, IndexError):
        return None


def posix_rows(pid=None):
    if Path("/proc").is_dir():
        return [value for entry in Path("/proc").iterdir() if entry.name.isdigit()
                if (value := proc_identity(int(entry.name)))]
    command = ["ps", "-p", str(pid), "-o", "pid=,ppid=,pgid=,stat=,lstart="] if pid else ["ps", "-axo", "pid=,ppid=,pgid=,stat=,lstart="]
    try:
        output = subprocess.run(command, capture_output=True, text=True, timeout=1, env={**os.environ, "LC_ALL": "C"}).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    for line in output.splitlines():
        try:
            fields = line.split()
            rows.append({"pid": int(fields[0]), "ppid": int(fields[1]), "group": int(fields[2]), "session": int(fields[2]),
                         "state": fields[3][0], "start": time.mktime(time.strptime(" ".join(fields[4:9]), "%a %b %d %H:%M:%S %Y"))})
        except (ValueError, IndexError):
            continue
    return rows


class WindowsJob:
    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                        ("flags", wintypes.DWORD), ("minimum", ctypes.c_size_t), ("maximum", ctypes.c_size_t),
                        ("active", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                        ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]

        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("process_memory", ctypes.c_size_t),
                        ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        information = Extended()
        information.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(information), ctypes.sizeof(information)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def assign_and_resume(self, process):
        import ctypes
        from ctypes import wintypes
        if not self.kernel.AssignProcessToJobObject(self.handle, wintypes.HANDLE(int(process._handle))):
            raise ctypes.WinError(ctypes.get_last_error())
        # Popen closes the initial thread handle. Resume the still-suspended
        # process by its owned process handle after assigning the kill-on-close
        # job, so even its first child belongs to the same kernel scope.
        resume = ctypes.WinDLL("ntdll").NtResumeProcess
        resume.argtypes = [wintypes.HANDLE]
        resume.restype = ctypes.c_long
        if resume(wintypes.HANDLE(int(process._handle))) != 0:
            raise OSError("Could not resume the owned media process")

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle)
            self.handle = None


class ProcessScope:
    def __init__(self, command):
        self.job = WindowsJob() if os.name == "nt" else None
        self.members = {}
        options = {"creationflags": subprocess.CREATE_NO_WINDOW | 0x4} if self.job else {"start_new_session": True}
        self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
        try:
            if self.job:
                self.job.assign_and_resume(self.process)
            self.leader = proc_identity(self.process.pid) if os.name != "nt" else None
            self.observe()
        except BaseException:
            if self.job:
                self.job.close()
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait(timeout=3)
            raise

    def observe(self):
        if not self.leader:
            return
        # Session membership survives its leader. Birth identities and pidfds
        # are retained before signaling, including a child's own process group.
        current = proc_identity(self.process.pid)
        if current and current["start"] != self.leader["start"]:
            return
        rows = posix_rows()
        by_pid = {row["pid"]: row for row in rows}
        owned = {self.process.pid, *(pid for pid, (birth, _) in self.members.items()
                                    if by_pid.get(pid, {}).get("start") == birth)}
        changed = True
        while changed:
            changed = False
            for row in rows:
                if row["start"] < self.leader["start"]:
                    continue
                if row["session"] != self.process.pid and row["ppid"] not in owned:
                    continue
                if row["pid"] not in owned:
                    owned.add(row["pid"])
                    changed = True
                previous = self.members.get(row["pid"])
                if not previous or previous[0] != row["start"]:
                    if previous and previous[1] is not None:
                        os.close(previous[1])
                    self.members.pop(row["pid"], None)
                    try:
                        descriptor = os.pidfd_open(row["pid"]) if hasattr(os, "pidfd_open") else None
                    except OSError:
                        continue
                    confirmed = proc_identity(row["pid"])
                    if not confirmed or confirmed["start"] != row["start"]:
                        if descriptor is not None:
                            os.close(descriptor)
                        continue
                    self.members[row["pid"]] = (row["start"], descriptor)

    def signal_members(self, value):
        for pid, (birth, descriptor) in self.members.items():
            try:
                if descriptor is not None and hasattr(signal, "pidfd_send_signal"):
                    signal.pidfd_send_signal(descriptor, value)
                elif (current := proc_identity(pid)) and current["start"] == birth:
                    os.kill(pid, value)
            except (OSError, ProcessLookupError):
                pass

    def close(self):
        try:
            if self.job:
                self.job.close()
            elif self.leader:
                self.observe()
                self.signal_members(signal.SIGTERM)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    if all(not (row := proc_identity(pid)) or row["start"] != birth or row["state"] == "Z"
                           for pid, (birth, _) in self.members.items()):
                        break
                    time.sleep(0.05)
                self.observe()
                self.signal_members(signal.SIGKILL)
            elif self.process.poll() is None:
                os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=3)
        finally:
            for _, descriptor in self.members.values():
                if descriptor is not None:
                    os.close(descriptor)
            self.members.clear()
