"""The visible command marks omitted text without exposing the omitted payload."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/core"))
from runtime_events import Recorder


class EventTruncationTests(unittest.TestCase):
    def test_command_length_boundary_is_explicit(self):
        with tempfile.TemporaryDirectory() as folder:
            recorder = Recorder(Path(folder), "cycle-long")
            for command in ("a" * 1000, "b" * 1000 + "not-visible"):
                recorder.ingest(json.dumps({"type": "item.started", "item": {
                    "id": "tool", "type": "command_execution", "command": command}}))
            events = [json.loads(line) for line in recorder.path.read_text().splitlines()]
            self.assertFalse(events[0]["commandTruncated"])
            self.assertTrue(events[1]["commandTruncated"])
            self.assertEqual(len(events[1]["command"]), 1000)
            self.assertNotIn("not-visible", recorder.path.read_text())
