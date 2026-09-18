"""Bundled resource integrity and realistic failure cases for its checker."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("skill_resources", ROOT / "scripts/check_skill_resources.py")
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class SkillResourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, path, text=""):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding="utf-8")
        return file

    def test_bundled_resources_resolve(self):
        result = CHECKER.check(ROOT)
        self.assertFalse(result["missing"], json.dumps(result["missing"], indent=2))

    def test_removed_resource_is_reported_from_its_actual_callers(self):
        source = ".claude/skills/example/SKILL.md"
        self.write(source, "Read [guide](references/guide.md#details).\n")
        guide = self.write(".claude/skills/example/references/guide.md", "# Details\n")
        self.assertFalse(CHECKER.check(self.root, [])["missing"])
        guide.unlink()
        self.assertEqual(CHECKER.check(self.root, [])["missing"], [
            {"source": source, "line": 1, "target": "references/guide.md#details"}
        ])

    def test_missing_commands_are_checked_inside_code_blocks_and_translations(self):
        text = "```bash\npython scripts/calculate.py --amount 10\n```\n"
        for path in (".claude/skills/example/SKILL.md", "i18n/en/.claude/skills/example/SKILL.md"):
            self.write(path, text)
        missing = CHECKER.check(self.root, [])["missing"]
        self.assertEqual(len(missing), 2)
        self.assertEqual({item["target"] for item in missing}, {"scripts/calculate.py"})

    def test_nested_and_cross_skill_links_use_the_correct_base(self):
        self.write(".claude/skills/example/SKILL.md", "[Peer](../peer/SKILL.md)\n")
        self.write(".claude/skills/peer/SKILL.md")
        self.write(".claude/skills/example/references/guide.md", "[Entry](../SKILL.md)\nRead `references/detail.md`.\n")
        self.write(".claude/skills/example/references/detail.md")
        result = CHECKER.check(self.root, [])
        self.assertEqual(result["references_checked"], 3)
        self.assertFalse(result["missing"])

    def test_examples_outputs_and_optional_files_need_exact_exclusions(self):
        source = ".claude/skills/example/SKILL.md"
        text = (
            "Example: `scripts/demo.py`\n"
            "Save report to `data/report.json`\n"
            "If present, read [context](optional.md)\n"
            "[Official docs](https://example.com/docs) [Section](#details)\n"
            "[Example website route](/signup)\n"
        )
        self.write(source, text)
        exclusions = [dict(source=source, target=target, reason="Example, output, or optional user file.")
                      for target in ("scripts/demo.py", "data/report.json", "optional.md")]
        self.assertEqual(len(CHECKER.check(self.root, [])["missing"]), 3)
        self.assertFalse(CHECKER.check(self.root, exclusions)["missing"])
        self.write(source, text + "Required: `data/source.json`\n")
        self.assertEqual(CHECKER.check(self.root, exclusions)["missing"][0]["target"], "data/source.json")

    def test_exclusions_are_documented_unique_and_still_referenced(self):
        exclusions = json.loads((ROOT / "tests/skill_resource_exclusions.json").read_text(encoding="utf-8"))
        keys = set()
        for item in exclusions:
            key = item["source"], item["target"]
            self.assertNotIn(key, keys)
            keys.add(key)
            self.assertTrue(item["reason"].strip())
            targets = {target for _, target, _ in CHECKER.references(ROOT / item["source"])}
            self.assertIn(item["target"], targets, f"Stale exclusion: {key}")


if __name__ == "__main__":
    unittest.main()
