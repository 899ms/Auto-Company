"""Language selection, customization preservation and real fake-engine routing."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("localization", ROOT / "scripts/core/localization.py")
LOCALIZATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCALIZATION)


class LocalizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.local = self.root / ".auto-company.local"

    def test_precedence_and_explicit_invalid_values(self):
        self.assertEqual(LOCALIZATION.resolve_language(self.root, {}), "zh-CN")
        self.local.write_text("AUTO_COMPANY_LANGUAGE=en\n", encoding="utf-8")
        self.assertEqual(LOCALIZATION.resolve_language(self.root, {}), "en")
        self.assertEqual(LOCALIZATION.resolve_language(self.root, {"AUTO_COMPANY_LANGUAGE": "zh-CN"}), "zh-CN")
        for value in ("", "fr", "../../en", "EN"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                LOCALIZATION.resolve_language(self.root, {"AUTO_COMPANY_LANGUAGE": value})

    def test_set_preserves_selection_comments_and_line_endings(self):
        before = b"# human-owned\r\nACTIVE_PROJECT=projects/example\r\nAUTO_COMPANY_LANGUAGE=zh-CN\r\nCUSTOM_SETTING=keep"
        self.local.write_bytes(before)
        LOCALIZATION.set_language(self.root, "en")
        self.assertEqual(self.local.read_bytes(), before.replace(b"LANGUAGE=zh-CN", b"LANGUAGE=en"))
        LOCALIZATION.set_language(self.root, "en")
        self.assertEqual(self.local.read_bytes().count(b"AUTO_COMPANY_LANGUAGE="), 1)

    def test_running_loop_and_malformed_config_are_not_overwritten(self):
        self.local.write_bytes(b"# keep\n")
        (self.root / ".auto-loop.pid").write_text("1234")
        with self.assertRaises(ValueError):
            LOCALIZATION.set_language(self.root, "en")
        self.assertEqual(self.local.read_bytes(), b"# keep\n")
        (self.root / ".auto-loop.pid").write_text("")
        for raw in (b"AUTO_COMPANY_LANGUAGE=en\nAUTO_COMPANY_LANGUAGE=zh-CN\n", b"$(touch sentinel)\n"):
            self.local.write_bytes(raw)
            with self.assertRaises(ValueError):
                LOCALIZATION.set_language(self.root, "en")
            self.assertEqual(self.local.read_bytes(), raw)

    def test_translated_resource_falls_back_for_customized_or_missing_asset(self):
        source = self.root / "PROMPT.md"
        source.write_bytes("原文\n".encode())
        translated = self.root / "i18n/en/PROMPT.md"
        translated.parent.mkdir(parents=True)
        translated.write_text("Translated prompt\n", encoding="utf-8")
        (self.root / "i18n/source-hashes.json").write_text(json.dumps({
            "PROMPT.md": hashlib.sha256(source.read_bytes()).hexdigest(),
        }), encoding="utf-8")
        self.assertTrue(LOCALIZATION.build_prompt(self.root, "en").startswith("Translated prompt"))
        source.write_bytes("原文\r\n".encode())
        self.assertTrue(LOCALIZATION.build_prompt(self.root, "en").startswith("Translated prompt"))
        source.write_text("My exact custom instruction", encoding="utf-8")
        self.assertTrue(LOCALIZATION.build_prompt(self.root, "en").startswith("My exact custom instruction"))
        self.assertEqual(source.read_text(), "My exact custom instruction")
        source.write_bytes("原文\n".encode())
        translated.unlink()
        self.assertTrue(LOCALIZATION.build_prompt(self.root, "en").startswith("原文"))

    def test_packaged_resource_manifest_matches_sources(self):
        manifest = json.loads((ROOT / "i18n/source-hashes.json").read_text(encoding="utf-8"))
        self.assertIn("PROMPT.md", manifest)
        for name, digest in manifest.items():
            with self.subTest(name=name):
                self.assertEqual(LOCALIZATION.source_digest(ROOT / name), digest,
                                 "Source changed: review translations and update their baseline")
                self.assertTrue(any((ROOT / "i18n" / lang / name).is_file() for lang in LOCALIZATION.LANGUAGES))

    def test_customized_roles_and_skills_override_bundled_translations(self):
        manifest = {}
        names = (".claude/agents/ceo-bezos.md", ".claude/skills/team/SKILL.md")
        for name in names:
            original = self.root / name
            original.parent.mkdir(parents=True)
            original.write_text("Original role or skill\n", encoding="utf-8")
            translated = self.root / "i18n/en" / name
            translated.parent.mkdir(parents=True)
            translated.write_text("Translated role or skill\n", encoding="utf-8")
            manifest[name] = LOCALIZATION.source_digest(original)
        (self.root / "i18n/source-hashes.json").write_text(json.dumps(manifest), encoding="utf-8")
        before = LOCALIZATION.resource_map(self.root, "en")
        self.assertEqual(before[names[0]], "i18n/en/" + names[0])
        for name in names:
            (self.root / name).write_text("My custom instructions\n", encoding="utf-8")
        self.assertEqual(LOCALIZATION.resource_map(self.root, "en"), {name: name for name in names})

    @unittest.skipUnless(os.name == "posix" and os.uname().sysname == "Linux", "Linux fake-engine cycle")
    def test_real_loop_delivers_selected_language_and_preserves_human_config(self):
        for language in LOCALIZATION.LANGUAGES:
            with self.subTest(language=language), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                shutil.copytree(ROOT / "scripts/core", root / "scripts/core")
                shutil.copytree(ROOT / "i18n", root / "i18n")
                shutil.copytree(ROOT / ".claude", root / ".claude")
                (root / "memories").mkdir()
                shutil.copy2(ROOT / "memories/consensus.template.md", root / "memories")
                shutil.copy2(ROOT / "PROMPT.md", root)
                shutil.copy2(ROOT / "CLAUDE.md", root)
                config = f"AUTO_COMPANY_LANGUAGE={language}\n".encode()
                (root / ".auto-company.local").write_bytes(config)
                fake = root / "fake-engine"
                fake.write_text("#!/usr/bin/env python3\nimport json, os, pathlib, sys\n"
                                "if '--version' in sys.argv: print('fake 1'); sys.exit(0)\n"
                                "pathlib.Path(os.environ['CAPTURE']).write_text(json.dumps(sys.argv), encoding='utf-8')\n"
                                "print(json.dumps({'result':'ok','usage':{'input_tokens':2,'output_tokens':2}}))\n")
                fake.chmod(0o755)
                env = dict(os.environ, ENGINE="claude", CLAUDE_BIN=str(fake), CLAUDE_PERMISSION_MODE="default",
                           CAPTURE=str(root / "captured.json"), USAGE_HARD_LIMIT_TOKENS="1",
                           LOOP_INTERVAL="60", BUDGET_PAUSE_POLL_SECONDS="60", CYCLE_TIMEOUT_SECONDS="10")
                env.pop("AUTO_COMPANY_LANGUAGE", None)
                with (root / "output").open("w") as stream:
                    process = subprocess.Popen(["bash", str(root / "scripts/core/auto-loop.sh")],
                                               env=env, stdout=stream, stderr=stream)
                    try:
                        deadline = time.monotonic() + 20
                        while not (root / ".auto-loop-budget-paused").exists():
                            if process.poll() is not None or time.monotonic() > deadline:
                                self.fail((root / "output").read_text())
                            time.sleep(0.05)
                        args = json.loads((root / "captured.json").read_text())
                        prompt = args[args.index("-p") + 1]
                        self.assertIn(f"AUTO_COMPANY_LANGUAGE={language}", prompt)
                        expected = "i18n/en/.claude/skills/team/SKILL.md" if language == "en" else "读 `.claude/skills/team/SKILL.md`"
                        self.assertIn(expected, prompt)
                        self.assertIn("## Human Overrides", prompt)
                        self.assertEqual((root / ".auto-company.local").read_bytes(), config)
                    finally:
                        if process.poll() is None:
                            process.send_signal(signal.SIGTERM)
                        process.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
