"""Keep the most recently written cycle logs and their paired JSON sidecars."""

import argparse
from pathlib import Path


def rotate(directory: Path, maximum: int) -> int:
    # mtime works with old names, restarts, and cycle numbers above four digits.
    # Resolve ties by name for deterministic retention on coarse filesystems.
    logs = sorted((path for path in directory.glob("cycle-*.log") if path.is_file()),
                  key=lambda path: (path.stat().st_mtime_ns, path.name))
    expired = logs[:max(0, len(logs) - maximum)]
    for path in expired:
        path.unlink()
        path.with_suffix(".json").unlink(missing_ok=True)
        path.with_suffix(".events.jsonl").unlink(missing_ok=True)
    return len(expired)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("maximum", type=int)
    args = parser.parse_args()
    if args.maximum < 0:
        parser.error("maximum must be nonnegative")
    print(rotate(args.directory, args.maximum))


if __name__ == "__main__":
    main()
