"""Keep bundled skill instructions in one English source per skill."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
# These are literal search queries for Chinese-language community sources,
# not instructions or output-language requirements.
SEARCH_EXAMPLES = {
    ".claude/skills/github-explorer/SKILL.md": (
        "`<project_name> 评测 使用体验`",
        "`<project> 评测`",
    ),
}


class SkillsLanguageTests(unittest.TestCase):
    def test_bundled_skill_text_has_no_untranslated_chinese_prose(self):
        failures = []
        for path in sorted((ROOT / ".claude/skills").rglob("*")):
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue  # Binary assets do not contain skill instructions.
            relative = path.relative_to(ROOT).as_posix()
            for example in SEARCH_EXAMPLES.get(relative, ()):
                self.assertIn(example, text, f"Stale search-example exception: {relative}")
                text = text.replace(example, "")
            for number, line in enumerate(text.splitlines(), 1):
                if CJK.search(line):
                    failures.append(f"{relative}:{number}: {line.strip()}")
        self.assertEqual(failures, [], "\n".join(failures))

    def test_skills_have_no_language_specific_copies(self):
        copies = sorted(
            path.relative_to(ROOT).as_posix()
            for path in (ROOT / "i18n").glob("*/.claude/skills/**/*")
            if path.is_file()
        )
        self.assertEqual(copies, [], "Bundled skills use their canonical English source")


if __name__ == "__main__":
    unittest.main()
