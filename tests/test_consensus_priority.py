"""Cross-platform checks of the documented P1 record grammar and content boundary."""

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("consensus_format", ROOT / "scripts/core/consensus-format.py")
FORMAT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FORMAT)


class PriorityContentTest(unittest.TestCase):
    def preserved(self, before, after):
        heading = b"## Priority Issues\n"
        return FORMAT.p1_preserved(heading + after, heading + before)

    def test_new_unresolved_formats_block_and_closed_formats_need_baseline(self):
        for item in (b"- [ ] P1: approval", b"* [?] **p1**: approval", b"1. [] P1: approval",
                     b"+ [  ] __P1__: approval", b"P1: approval", b"  - P1: approval"):
            with self.subTest(item=item):
                section = b"## Priority Issues\n" + item + b"\n"
                self.assertTrue(FORMAT.unresolved_p1(section))
                self.assertTrue(self.preserved(b"", item + b"\n"))
        for item in (b"- [x] P1: approval\n", b"1. [X] **P1**: approval\n"):
            with self.subTest(item=item):
                self.assertFalse(self.preserved(b"", item))
                self.assertTrue(self.preserved(item, item))

    def test_multiline_and_nested_non_p1_details_cannot_change(self):
        issue = b"- [x] P1: human approved\n  Details stay.\n  - Scope: local only.\n"
        before = issue + b"- P2: other work\n"
        self.assertTrue(self.preserved(before, issue + b"- P2: completed\n"))
        self.assertTrue(self.preserved(before, issue + b"\n\n- P2: completed\n"))
        self.assertFalse(self.preserved(before, before.replace(b"local only", b"all environments")))
        self.assertFalse(self.preserved(before, before.replace(b"  Details stay.\n", b"")))

    def test_duplicate_counts_and_new_unresolved_reports_are_independent(self):
        closed = b"- [x] P1: approved\n"
        opened = b"- [ ] P1: new blocker\n"
        self.assertTrue(self.preserved(closed * 2, opened + closed * 2))
        self.assertFalse(self.preserved(closed * 2, closed))
        self.assertFalse(self.preserved(closed, closed * 2))
        self.assertFalse(self.preserved(closed + opened, closed))
        self.assertFalse(self.preserved(closed + opened, closed + opened.replace(b"[ ]", b"[x]")))

    def test_p1_raw_line_endings_and_description_are_preserved(self):
        for before in (b"- [x] P1: approved\r\n", b"- [x] P1: approved"):
            with self.subTest(before=before):
                self.assertTrue(self.preserved(before, before))
                self.assertFalse(self.preserved(before, b"- [x] P1: approved\n"))

if __name__ == "__main__":
    unittest.main()
