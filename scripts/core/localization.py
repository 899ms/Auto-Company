"""Resolve language resources without overwriting human-owned instructions."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]
LANGUAGES = ("zh-CN", "en")
KEY = "AUTO_COMPANY_LANGUAGE"


def diagnostic_language(root, environ=None):
    """Diagnostics remain readable when the configuration itself is broken."""
    environ = os.environ if environ is None else environ
    if KEY in environ:
        return environ[KEY] if environ[KEY] in LANGUAGES else "en"
    try:
        _, language = read_local(root)
        if language is not None:
            return language if language in LANGUAGES else "en"
    except (OSError, UnicodeError, ValueError):
        return "en"
    return "zh-CN"


def message(root, key, *values, language=None, fallback=None):
    language = language or diagnostic_language(root)
    try:
        catalog = json.loads((ROOT / "i18n/messages.json").read_text(encoding="utf-8"))
        entry = catalog[key]
        if not isinstance(entry, dict):
            raise ValueError("message catalog entries must be language maps")
        english = entry.get("en")
        if not isinstance(english, str) or not english.strip():
            raise ValueError("message catalog requires an English fallback")
        template = entry.get(language)
        if (not isinstance(template, str) or not template.strip()
                or sorted(re.findall(r"\{[0-9]+\}", template)) != sorted(re.findall(r"\{[0-9]+\}", english))):
            template = english
        # Substitute only numbered tokens, once. User values are never code or
        # format strings, even if they contain braces or shell metacharacters.
        return re.sub(r"\{([0-9]+)\}", lambda match: str(values[int(match[1])]), template)
    except (OSError, UnicodeError, ValueError, KeyError, IndexError, TypeError):
        return fallback if fallback is not None else f"[{key}] " + " | ".join(str(value) for value in values)


def read_local(root):
    path = root / ".auto-company.local"
    if path.is_symlink():
        raise ValueError("local configuration must not be a symlink")
    data = path.read_bytes() if path.exists() else b""
    language = None
    for line in data.decode("utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if not match:
            raise ValueError("local configuration must contain plain KEY=value lines")
        if match[1] == KEY:
            if language is not None:
                raise ValueError(f"duplicate {KEY} entries")
            language = match[2]
    return data, language


def resolve_language(root, environ=None):
    environ = os.environ if environ is None else environ
    _, local = read_local(root)
    language = environ.get(KEY, local if local is not None else "zh-CN")
    if language not in LANGUAGES:
        raise ValueError(f"{KEY} must be zh-CN or en")
    return language


def set_language(root, language):
    if language not in LANGUAGES:
        raise ValueError("language must be zh-CN or en")
    pid_file = root / ".auto-loop.pid"
    if pid_file.exists() and pid_file.read_text(encoding="utf-8").strip():
        raise ValueError("stop the loop before changing its human-owned language configuration")
    data, _ = read_local(root)
    replacement = f"{KEY}={language}".encode()
    lines = data.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith(f"{KEY}=".encode()):
            ending = b"\r\n" if line.endswith(b"\r\n") else b"\n" if line.endswith(b"\n") else b""
            lines[index] = replacement + ending
            break
    else:
        if data and not data.endswith((b"\r", b"\n")):
            lines.append(b"\n")
        lines.append(replacement + b"\n")
    descriptor, temporary = tempfile.mkstemp(prefix=".auto-company.local.", dir=root)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(b"".join(lines))
        os.replace(temporary, root / ".auto-company.local")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def source_digest(path):
    # Checkouts may use CRLF; line-ending conversion is not a customization.
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def resource_map(root, language):
    manifest = root / "i18n/source-hashes.json"
    if not manifest.is_file():
        return {}
    sources = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(sources, dict) or not all(isinstance(name, str) and isinstance(digest, str) for name, digest in sources.items()):
        raise ValueError("language resource manifest must map source paths to hashes")
    resolved = {}
    for name, digest in sources.items():
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts or "\\" in name:
            raise ValueError("invalid language resource path")
        source = root / relative
        translated = root / "i18n" / language / relative
        # A changed source always wins, even if a packaged translation exists.
        if source.is_file():
            use_translation = translated.is_file() and source_digest(source) == digest
            resolved[name] = translated.relative_to(root).as_posix() if use_translation else name
    return resolved


def context(root, language, resources):
    output = "English" if language == "en" else "简体中文"
    lines = [
        "## Runtime Language / 本轮工作语言",
        "",
        f"- AUTO_COMPANY_LANGUAGE={language}. Write new explanations, decisions and consensus prose in {output}.",
        "- This setting replaces the bundled team's default output language. Explicit human instructions and Human Overrides take precedence.",
        "- Keep protocol headings (especially Human Overrides and Priority Issues), identifiers, commands, paths and quoted evidence unchanged.",
        "- Do not translate or rewrite existing history or the Human Overrides section when switching language.",
        "- All resource paths below are relative to the framework root. Resolve every bundled role/skill reference through this table before reading it; the selected path overrides references and auto-discovered defaults.",
        "- When delegating, pass the selected role instructions and this output-language preference to each subagent.",
        "- A customized source takes precedence over its packaged translation. Never regenerate or overwrite user-edited instructions.",
    ]
    if resources:
        lines.extend(["", "| Bundled resource | Selected resource |", "|---|---|"])
        lines.extend(f"| `{name}` | `{selected}` |" for name, selected in sorted(resources.items()))
    return "\n".join(lines)


def build_prompt(root, language):
    resources = resource_map(root, language)
    path = root / resources.get("PROMPT.md", "PROMPT.md")
    prompt = path.read_text(encoding="utf-8")
    return prompt + "\n\n---\n\n" + context(root, language, resources)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "prompt", "context", "set", "message", "help"))
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--language")
    parser.add_argument("--key")
    parser.add_argument("--arg", action="append", default=[])
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        if args.command == "message":
            if not args.key:
                parser.error("message requires --key")
            print(message(root, args.key, *args.arg))
        elif args.command == "help":
            for line in (root / "Makefile").read_text(encoding="utf-8").splitlines():
                match = re.match(r"^([a-zA-Z_-]+):.*?## (.*)$", line)
                if match:
                    print(f"  {match[1]:<24} {message(root, 'help.' + match[1], fallback=match[2])}")
        elif args.command == "set":
            if args.language is None:
                parser.error("set requires --language")
            set_language(root, args.language)
            print(message(root, "language.saved", args.language))
        else:
            language = resolve_language(root)
            if args.command == "prompt":
                print(build_prompt(root, language))
            elif args.command == "context":
                print(context(root, language, resource_map(root, language)))
            else:
                print(language)
    except (OSError, UnicodeError, ValueError, TypeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        key = "language.running" if "stop the loop before" in str(error) else "language.invalid"
        print(message(root, key), file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    sys.exit(main())
