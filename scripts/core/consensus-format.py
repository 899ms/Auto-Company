#!/usr/bin/env python3
"""Validate governance headings and compare protected sections without text rewrites."""

from pathlib import Path
from datetime import datetime, timezone
import os
import re
import sys
import tempfile


HEADINGS = (b"## Human Overrides", b"## Priority Issues")


def sections(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("consensus must be a regular file")
    data = path.read_bytes()
    if b"\0" in data:
        raise ValueError("consensus contains NUL bytes")
    lines = data.splitlines(keepends=True)
    starts = {}
    for index, raw in enumerate(lines):
        line = raw.rstrip(b"\r\n")
        normalized = b" ".join(line.strip().rstrip(b"#").strip().split()).lower()
        for heading in HEADINGS:
            if normalized == heading.lower():
                if line != heading or heading in starts:
                    raise ValueError("governance headings must occur exactly once in canonical form")
                starts[heading] = index
    if len(starts) != len(HEADINGS):
        raise ValueError("consensus requires exactly one Human Overrides and Priority Issues section")
    result = {}
    for heading, start in starts.items():
        end = start + 1
        while end < len(lines) and not re.match(rb"^ {0,3}#{1,2}(?:[ \t]|$)", lines[end]):
            end += 1
        result[heading] = b"".join(lines[start:end])
    return result


def unresolved_p1(section):
    for line in section.splitlines()[1:]:
        match = re.match(
            rb"^\s*(?:(?:[-+*]|\d+[.)])\s+)?(?:\[([^\]]*)\]\s*)?(?:\*\*|__)?p1\b",
            line, re.IGNORECASE,
        )
        if match and match[1] not in (b"x", b"X"):
            return True
    return False


def atomic_write(path, data):
    path = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".consensus-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def reset_consensus(path, template):
    path = Path(path)
    current = sections(path)
    template_data = Path(template).read_bytes()
    for section in sections(template).values():
        template_data = template_data.replace(section, b"", 1)
    # Retain the original order and endings of both human-governed sections.
    replacement = template_data.rstrip(b"\r\n") + b"\n\n" + b"".join(current.values())
    backup_dir = path.parent / "resets"
    backup_dir.mkdir(exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = backup_dir / f"consensus-before-reset-{stamp}-{os.getpid()}.md"
    with backup.open("xb") as stream:
        stream.write(path.read_bytes())
    atomic_write(path, replacement)
    print(backup)


def main():
    command, path, *extra = sys.argv[1:]
    try:
        if command == "restore":
            # Validate the saved baseline before restoring; never follow target symlinks.
            sections(extra[0])
            atomic_write(path, Path(extra[0]).read_bytes())
            return 0
        if command == "reset":
            reset_consensus(path, extra[0])
            return 0
        current = sections(path)
        if command == "p1":
            return 0 if unresolved_p1(current[HEADINGS[1]]) else 1
        if command == "unchanged":
            baseline = sections(extra[0])
            return 0 if baseline[HEADINGS[0]] == current[HEADINGS[0]] else 1
        if command != "validate":
            raise ValueError("unknown consensus format command")
    except (OSError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
