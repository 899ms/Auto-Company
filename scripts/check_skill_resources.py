"""Check bundled skill links and resource paths without executing skill commands.

Markdown links are document-relative; bare resource-directory paths are skill-relative.
Examples, output paths and optional user files require exact, reasoned exclusions in
tests/skill_resource_exclusions.json. External URLs and fragment-only links are ignored.
"""

import argparse
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
RESOURCE = re.compile(
    r"(?<![\w/])(?:skills/[\w-]+/)?"
    r"(?:references?|scripts|assets|templates|resources|examples|data|state)/"
    r"[\w./-]+\.[A-Za-z0-9]+"
)
LINK = re.compile(r"\]\(([^)\s]+)\)")


def skill_root(source):
    current = source.parent
    while not (current / "SKILL.md").is_file() and current != current.parent:
        current = current.parent
    return current if (current / "SKILL.md").is_file() else source.parent


def references(source):
    for number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        links = sorted(set(LINK.findall(line)))
        candidates = [(target, source.parent) for target in links]
        # Do not reinterpret a Markdown link as a bare skill-relative path.
        without_links = LINK.sub("]()", line)
        candidates.extend((target, skill_root(source)) for target in sorted(set(RESOURCE.findall(without_links))))
        for target, base in candidates:
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith(("#", "/")):
                continue
            path = unquote(parsed.path)
            # Placeholder links such as (URL) are not filesystem references.
            if not path or ("/" not in path and not Path(path).suffix):
                continue
            yield number, target, base / path


def check(root, exclusions=None):
    root = Path(root).resolve()
    if exclusions is None:
        exclusions = json.loads((root / "tests/skill_resource_exclusions.json").read_text(encoding="utf-8"))
    excluded = {(item["source"], item["target"]): item["reason"] for item in exclusions}
    files = sorted((root / ".claude/skills").rglob("*.md"))
    files += sorted((root / "i18n").glob("*/.claude/skills/**/*.md"))
    failures = []
    count = 0
    for source in files:
        relative = source.relative_to(root).as_posix()
        for number, target, resolved in references(source):
            if (relative, target) in excluded:
                continue
            count += 1
            if not resolved.resolve().is_relative_to(root) or not resolved.exists():
                failures.append({"source": relative, "line": number, "target": target})
    return {"documents": len(files), "references_checked": count, "missing": failures}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = check(args.root)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for item in result["missing"]:
            print(f"{item['source']}:{item['line']}: missing {item['target']}")
        print(f"Checked {result['references_checked']} references in {result['documents']} documents; "
              f"{len(result['missing'])} missing.")
    return bool(result["missing"])


if __name__ == "__main__":
    sys.exit(main())
