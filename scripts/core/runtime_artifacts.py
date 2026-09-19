"""Program-owned artifact registration, check execution and static previews.

No inference from messages or arbitrary URLs. Tools opt into this small
contract; unsupported project runners remain unsupported, not guessed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import uuid
import xml.etree.ElementTree as ET


def safe_path(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise ValueError("Invalid artifact path")
    parts = PurePosixPath(relative)
    if parts.is_absolute() or ".." in parts.parts:
        raise ValueError("Artifact must stay in its project")
    path = root
    for part in parts.parts:
        path /= part
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise ValueError("Linked artifacts are not supported")
    path.resolve().relative_to(root.resolve())
    return path


def report_summary(path):
    if not stat.S_ISREG(path.stat().st_mode) or path.stat().st_size > 1024 * 1024:
        raise ValueError("Report is not a bounded regular file")
    raw = path.read_bytes()
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("DTD reports are unsupported")
    tree = ET.fromstring(raw)
    if tree.tag not in {"testsuites", "testsuite"}:
        raise ValueError("Not a JUnit report")
    cases = list(tree.iter("testcase"))
    return {"tests": len(cases), "failures": sum(case.find("failure") is not None for case in cases),
            "errors": sum(case.find("error") is not None for case in cases),
            "skipped": sum(case.find("skipped") is not None for case in cases)}


def save(root, record):
    folder = safe_path(root, "logs/artifacts")
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (record["id"] + ".json")
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, target)


def base_record(project, kind):
    return {"version": 1, "id": uuid.uuid4().hex, "project": project,
            "kind": kind, "cycleId": os.environ.get("AUTO_COMPANY_CYCLE_ID"),
            "recordedAt": datetime.now(timezone.utc).isoformat(), "source": "runner"}


def fingerprint(path):
    if not stat.S_ISREG(path.stat().st_mode) or path.stat().st_size > 1024 * 1024:
        raise ValueError("Artifact is not a bounded regular file")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--project", required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    document = sub.add_parser("document")
    document.add_argument("path")
    check = sub.add_parser("check")
    check.add_argument("--report")
    check.add_argument("command", nargs=argparse.REMAINDER)
    preview = sub.add_parser("preview")
    preview.add_argument("--directory", default=".")
    preview.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    root = args.root.resolve()
    if not re.fullmatch(r"projects/[a-z0-9][a-z0-9-]*", args.project):
        parser.error("Explicit project identity required")
    project = safe_path(root, args.project)
    if not project.is_dir():
        parser.error("Project does not exist")
    record = base_record(args.project, args.action)
    if args.action == "document":
        path = safe_path(project, args.path)
        record.update(path=path.relative_to(root).as_posix(), sha256=fingerprint(path))
        save(root, record)
        return 0
    if args.action == "check":
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("Check command required")
        path = safe_path(project, args.report) if args.report else None
        if path:
            record["path"] = path.relative_to(root).as_posix()
        before = path.stat().st_mtime_ns if path and path.is_file() else None
        result = subprocess.run(command, cwd=project)
        record.update(exitCode=result.returncode)
        # Revalidate after the command: a tool could replace a regular report
        # with a symlink while executing.
        try:
            path = safe_path(project, args.report) if args.report else None
        except ValueError:
            path = None
            record["reportStatus"] = "unsupported"
        if path and path.is_file() and path.stat().st_mtime_ns != before:
            try:
                record.update(path=path.relative_to(root).as_posix(), sha256=fingerprint(path), tests=report_summary(path))
            except (ValueError, OSError, ET.ParseError):
                record["reportStatus"] = "unsupported"
        elif path:
            record["reportStatus"] = "missing_or_stale"
        save(root, record)
        return result.returncode
    directory = safe_path(project, args.directory)
    if not directory.is_dir():
        parser.error("Preview directory does not exist")
    token = uuid.uuid4().hex

    class PreviewHandler(SimpleHTTPRequestHandler):
        def translate_path(self, path):
            translated = Path(super().translate_path(path))
            try:
                relative = translated.relative_to(directory).as_posix()
                return str(safe_path(directory, relative))
            except ValueError:
                return str(directory / ".unavailable-preview-file")

        def end_headers(self):
            self.send_header("X-Auto-Company-Preview", token)
            super().end_headers()

        def do_GET(self):
            if self.path == "/.auto-company-health":
                self.send_response(204)
                self.end_headers()
            else:
                super().do_GET()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(PreviewHandler, directory=str(directory)))
    record.update(url=f"http://127.0.0.1:{server.server_port}/", token=token, state="running")
    save(root, record)

    def stop(_sig, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        record["state"] = "stopped"
        save(root, record)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
