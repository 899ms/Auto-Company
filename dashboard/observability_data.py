"""Bounded, read-only projections of program-recorded events and artifacts."""
from __future__ import annotations

import hashlib
import http.client
import itertools
import json
import re
from urllib.parse import urlsplit


def rows(raw):
    for line in raw.splitlines():
        try:
            value = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if isinstance(value, dict) and value.get("version") == 1:
            yield value


def cycle_events(source, cycle):
    identity = cycle["id"]
    path = f"logs/{identity}.events.jsonl"
    try:
        head, _ = source.read(path, 32 * 1024)
        tail, truncated = source.read(path, 128 * 1024, tail=True)
    except (OSError, ValueError):
        return {"events": [], "eventStatus": "unavailable", "observedConfig": None}
    values = {item.get("sequence"): item for item in rows(head + "\n" + tail)
              if item.get("cycleId") == identity and type(item.get("sequence")) is int}
    ordered = [values[key] for key in sorted(values)]
    config = next((item for item in ordered if item.get("kind") == "session.config"
                   and item.get("source") == "session_context"
                   and isinstance(item.get("model"), str) and isinstance(item.get("reasoning"), str)), None)
    allowed = {"process.started", "process.exited", "turn.started", "turn.completed", "turn.failed", "error", "command", "files", "report"}
    events = [item for item in ordered if isinstance(item.get("kind"), str) and item["kind"] in allowed][-80:]
    dropped = any(type(item.get("dropped")) is int and item["dropped"] > 0 for item in ordered)
    terminal = any(item.get("kind") == "process.exited" for item in ordered)
    interrupted = cycle.get("status") == "interrupted" or any(item.get("interrupted") is True for item in ordered)
    return {"events": events, "eventStatus": "partial" if truncated or dropped or interrupted or (not cycle.get("active") and not terminal) else "recorded",
            "observedConfig": config}


def preview_available(record):
    # No redirects, DNS, inherited proxies, remote hosts or arbitrary paths.
    # The random runner token prevents a reused port from becoming a false hit.
    value = record.get("url")
    token = record.get("token")
    if record.get("state") != "running" or not isinstance(value, str) or not isinstance(token, str) or not re.fullmatch(r"[0-9a-f]{32}", token):
        return False
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not port or parsed.username or parsed.password or parsed.path != "/" or parsed.query or parsed.fragment:
        return False
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.25)
    try:
        connection.request("GET", "/.auto-company-health")
        response = connection.getresponse()
        return response.status == 204 and response.getheader("X-Auto-Company-Preview") == token
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def registered_artifacts(source):
    selected = source.pairs(".auto-company.local").get("ACTIVE_PROJECT", "")
    if not re.fullmatch(r"projects/[a-z0-9][a-z0-9-]*", selected):
        return []
    try:
        folder = source.safe_path("logs/artifacts")
        files = list(itertools.islice(folder.glob("*.json"), 501))
        # Explicit bound; older entries outside this window are not invented.
        files = sorted(files, key=lambda path: path.stat().st_mtime_ns, reverse=True)[:100]
    except (OSError, ValueError):
        return []
    result, seen = [], set()
    preview_count = 0
    for path in files:
        try:
            raw = source.read(path.relative_to(source.root).as_posix(), 16 * 1024)[0]
            record = json.loads(raw)
            if not isinstance(record, dict) or record.get("version") != 1 or record.get("source") != "runner" or record.get("project") != selected:
                continue
            kind, relative = record.get("kind"), record.get("path")
            key = (kind, "project_preview" if kind == "preview" else relative or record.get("id"))
            if key in seen or kind not in {"document", "check", "preview"}:
                continue
            seen.add(key)
            entry = {"kind": kind, "cycleId": record.get("cycleId"), "recordedAt": record.get("recordedAt"),
                     "source": "runner", "label": relative or kind, "available": False}
            if kind == "preview":
                preview_count += 1
                available = preview_count <= 3 and preview_available(record)
                entry.update(label="preview", available=available)
                if available:
                    entry["url"] = record["url"]
            else:
                if isinstance(relative, str) and relative.startswith(selected + "/"):
                    entry.update(path=relative, fileStatus="unavailable")
                    try:
                        _, truncated = source.read(relative, 1024 * 1024)
                        # Hash raw bytes (not decoded/re-encoded text) for BOM files.
                        target = source.safe_path(relative)
                        with target.open("rb") as data:
                            digest = hashlib.sha256(data.read(1024 * 1024 + 1)).hexdigest()
                        valid = not truncated and digest == record.get("sha256")
                        entry.update(available=valid, fileStatus="recorded" if valid else "changed")
                    except (OSError, ValueError):
                        pass
                if kind == "check":
                    code = record.get("exitCode")
                    entry["exitCode"] = code if type(code) is int else None
                    counts = record.get("tests")
                    if entry["available"] and isinstance(counts, dict) and all(type(counts.get(key)) is int and 0 <= counts[key] <= 1000000 for key in ("tests", "failures", "errors", "skipped")):
                        entry["tests"] = counts
                    entry["reportStatus"] = record.get("reportStatus", entry.get("fileStatus", "unavailable"))
            result.append(entry)
        except (OSError, ValueError, TypeError, RecursionError):
            continue
    return result[:20]
