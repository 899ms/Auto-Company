"""Read-only journal contracts; fixtures never run the company or host services."""

import http.client
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock


DASHBOARD = Path(__file__).resolve().parents[1] / "dashboard"
SPEC = importlib.util.spec_from_file_location("dashboard_journal_server", DASHBOARD / "journal_server.py")
server_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server_module)
data_module = __import__("journal_data")
PRODUCTION_SPEC = importlib.util.spec_from_file_location("journal_production_server", DASHBOARD / "server.py")
production = importlib.util.module_from_spec(PRODUCTION_SPEC)
PRODUCTION_SPEC.loader.exec_module(production)


def record(identity="cycle-0001-run-a", number=1, **changes):
    value = {"schema_version": 1, "kind": "cycle_usage", "cycle_id": identity, "cycle_number": number,
             "started_at": "2026-09-18T12:00:00+08:00", "ended_at": "2026-09-18T12:01:00+08:00",
             "status": "completed", "engine": "codex", "model": "example-model",
             "usage": {"input_tokens": 90, "output_tokens": 10, "total_tokens": 100, "status": "reported"}}
    value.update(changes)
    return value


class JournalFixture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "logs").mkdir()
        (self.root / "memories").mkdir()
        self.source = data_module.JournalSource(self.root, "zh-CN")

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def ledger(self, *records):
        self.write("logs/usage.jsonl", "\n".join(json.dumps(value) for value in records))

    def live_status(self):
        pid = self.write(".auto-loop.pid", "4321\n")
        os.utime(pid, (1700000000, 1700000000))
        self.write(".auto-loop-state", "STATUS=running\nLOOP_COUNT=2\nENGINE=codex\nMODEL=example-model\n")
        self.write("logs/usage.jsonl.pending", json.dumps(record("cycle-0002-live", number=2, status="interrupted")))
        return {"ok": True, "raw": "Loop is running", "stateFile": self.source.pairs(".auto-loop-state"),
                "parsed": {"loop": {"state": "running", "processState": "running", "pid": 4321},
                           "daemon": {"state": "active"}}}


class JournalTests(JournalFixture):
    def test_unique_id_preserves_restarted_numbers_and_ignores_prose_cycle_count(self):
        first = record()
        second = record("cycle-0001-run-b", started_at="2026-09-18T13:00:00+08:00")
        self.ledger(first, first, second)
        self.write(".auto-loop-state", "LOOP_COUNT=99\nSTATUS=running\n")
        self.write("memories/consensus.md", "## Current Phase\nLaunching\n## What We Did This Cycle\n- Cycle 15 is a narrative stage\n")
        snapshot = self.source.snapshot()
        self.assertEqual([item["id"] for item in snapshot["cycles"]], [second["cycle_id"], first["cycle_id"]])
        self.assertEqual([item["number"] for item in snapshot["cycles"]], [1, 1])
        self.assertEqual(snapshot["runtime"]["state"], "stopped")
        self.assertEqual(snapshot["consensus"]["phase"], "Launching")
        self.assertEqual(snapshot["runtime"]["reasoning"], "unknown")

    def test_malformed_conflicting_and_traversal_id_records_warn_without_duplicate_count(self):
        first = record()
        self.ledger(first, record(status="failed"), record("../secret"), ["wrong"], record(number=True))
        with (self.root / "logs/usage.jsonl").open("a", encoding="utf-8") as ledger:
            ledger.write("\n{broken\n")
        snapshot = self.source.snapshot()
        self.assertEqual(len(snapshot["cycles"]), 1)
        self.assertIn("ledger_invalid_records:4", snapshot["warnings"])
        self.assertIn("ledger_conflicting_ids:1", snapshot["warnings"])

    def test_unknown_tokens_and_timestamps_remain_unknown(self):
        self.ledger(record(started_at="bad", ended_at="2026-09-18T12:00:00", status=[],
                           usage={"input_tokens": 0, "output_tokens": -1, "total_tokens": None}))
        cycle = self.source.snapshot()["cycles"][0]
        self.assertIsNone(cycle["startedAt"])
        self.assertIsNone(cycle["endedAt"])
        self.assertEqual(cycle["status"], "unknown")
        self.assertEqual(cycle["usage"], {"inputTokens": 0, "outputTokens": None, "totalTokens": None, "status": "partial"})
        for value in (True, "10", 1.5, -1, 2**60):
            self.assertIsNone(data_module.token_count(value))

    def test_consensus_reads_sections_after_long_intro_and_reports_file_mtime(self):
        text = "# Report\n" + ("intro\n" * 800) + "\n## 最后更新\n2020-01-01T00:00:00+08:00\n## 当前阶段\n交付\n## 本轮做了什么\n- 完成测试\n## 下一步行动\n等待人工试用\n"
        path = self.write("memories/consensus.md", text)
        os.utime(path, (1800000000, 1800000000))
        consensus = self.source.snapshot()["consensus"]
        self.assertEqual(consensus["phase"], "交付")
        self.assertEqual(consensus["progress"], ["完成测试"])
        self.assertNotIn("nextAction", consensus)
        self.assertEqual(consensus["reportedUpdatedAt"], "2020-01-01T00:00:00+08:00")
        self.assertEqual(consensus["updatedAt"], "2027-01-15T08:00:00+00:00")
        self.assertEqual(consensus["raw"], path.read_bytes().decode("utf-8"))

    def test_sidecar_is_summary_source_not_fabricated_history(self):
        self.ledger(record())
        self.write("logs/cycle-0001-run-a.json", json.dumps({"result": "**Shipped MVP.**\n\nDetailed evidence."}))
        cycle = self.source.snapshot()["cycles"][0]
        self.assertEqual(cycle["summary"], "Shipped MVP.")
        self.assertIn("Detailed evidence.", cycle["report"])
        self.assertFalse(cycle["logAvailable"])

    def test_recovery_and_clock_rollback_do_not_claim_precise_duration(self):
        self.ledger(record("recovered", status="interrupted", source={"type": "cycle_recovery"}),
                    record("clock-rollback", ended_at="2026-09-18T11:59:00+08:00"),
                    record("timeout-complete", status="completed_with_timeout"))
        cycles = {cycle["id"]: cycle for cycle in self.source.snapshot()["cycles"]}
        self.assertFalse(cycles["recovered"]["durationReliable"])
        self.assertEqual(cycles["recovered"]["endedAtKind"], "recovered")
        self.assertFalse(cycles["clock-rollback"]["durationReliable"])
        self.assertEqual(cycles["timeout-complete"]["status"], "completed_with_timeout")

    def test_markdown_delimiters_remain_bounded_and_nonregular_files_rejected(self):
        text = "[" * data_module.MAX_TEXT_BYTES
        self.assertEqual(data_module.plain_text(text), text)
        with self.assertRaises(ValueError):
            self.source.read("logs")

    def test_log_requires_ledger_identity_and_bounds_tail(self):
        self.ledger(record())
        self.write("logs/cycle-0001-run-a.log", "old-" + "a" * data_module.MAX_LOG_BYTES + "-latest")
        result = self.source.log("cycle-0001-run-a")
        self.assertTrue(result["available"])
        self.assertTrue(result["truncated"])
        self.assertTrue(result["text"].endswith("-latest"))
        self.assertLessEqual(len(result["text"]), data_module.MAX_LOG_BYTES)
        for identity in ("../secret", "cycle-0001-unknown", "cycle-0001-run-a/../../secret"):
            with self.assertRaises(ValueError):
                self.source.log(identity)

    def test_documents_only_advertise_delivery_and_one_explicit_project_readme(self):
        self.write("DELIVERY.md", "# Sample — Local MVP\n[Guide](projects/sample/README.md)\n")
        self.write("projects/sample/README.md", "# Sample guide")
        self.write(".env", "private")
        self.assertEqual([item["path"] for item in self.source.documents()], ["DELIVERY.md", "projects/sample/README.md"])
        self.assertEqual(self.source.snapshot()["project"]["name"], "Sample")
        self.assertEqual(self.source.document("projects/sample/README.md")[0], "# Sample guide")
        for path in (".env", "../.env", "projects/sample/../../.env", "C:/secret", "projects\\sample\\README.md"):
            with self.assertRaises(ValueError):
                self.source.document(path)

    def test_symlinked_source_files_and_ancestor_directories_are_not_exposed(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        secret = Path(outside.name) / "secret.txt"
        secret.write_text("private", encoding="utf-8")
        try:
            (self.root / "DELIVERY.md").symlink_to(secret)
            (self.root / "external").symlink_to(Path(outside.name), target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"Creating test symlinks unavailable: {exc}")
        self.assertEqual(self.source.documents(), [])
        for path in ("DELIVERY.md", "external/secret.txt"):
            with self.assertRaises(ValueError):
                self.source.read(path)

    def test_ledger_and_document_size_boundaries_are_explicit(self):
        line = json.dumps(record()) + "\n"
        self.write("logs/usage.jsonl", line + json.dumps(record("cycle-0002")))
        with mock.patch.object(data_module, "MAX_LEDGER_BYTES", len(line.encode("utf-8")) + 5):
            records, warnings = self.source.ledger()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["cycle_id"], "cycle-0002")
        self.assertIn("ledger_truncated", warnings)
        self.write("DELIVERY.md", "# Delivery\n" + "x" * data_module.MAX_TEXT_BYTES)
        text, truncated = self.source.document("DELIVERY.md")
        self.assertTrue(truncated)
        self.assertLessEqual(len(text), data_module.MAX_TEXT_BYTES)

    def test_saved_language_and_locked_product_are_read_without_writes(self):
        path = self.write(".auto-company.local", "AUTO_COMPANY_LANGUAGE=en\nAUTO_COMPANY_PRODUCT_LANGUAGE=zh-CN\nAUTO_COMPANY_PRODUCT_STATUS=active\n")
        before = path.read_bytes()
        language = data_module.JournalSource(self.root).language()
        self.assertEqual(language["language"], "zh-CN")
        self.assertEqual(language["nextLanguage"], "en")
        self.assertTrue(language["pending"])
        self.assertEqual(path.read_bytes(), before)

    def test_live_cycle_uses_reserved_identity_and_reports_unknown_usage(self):
        self.ledger(record())
        status = self.live_status()
        self.write("logs/cycle-0002-live.log", "provider is working")
        snapshot = self.source.snapshot(status=status)
        self.assertFalse(snapshot["readOnly"])
        self.assertEqual(snapshot["runtime"]["state"], "running")
        self.assertEqual(snapshot["runtime"]["currentCycleId"], "cycle-0002-live")
        self.assertEqual(snapshot["runtime"]["currentCycleNumber"], 2)
        active = snapshot["cycles"][0]
        self.assertTrue(active["active"])
        self.assertEqual(active["status"], "running")
        self.assertIsNone(active["endedAt"])
        self.assertIsNone(active["usage"]["totalTokens"])
        self.assertEqual(self.source.log(active["id"], status)["text"], "provider is working")
        self.assertIs(snapshot["status"], status)
        self.assertEqual(len(self.source.snapshot()["cycles"]), 1)

    def test_stale_mismatched_or_unverified_pending_never_becomes_live_cycle(self):
        self.ledger(record())
        for failure in ("status", "pid", "count", "previous_launch", "path"):
            with self.subTest(failure=failure):
                status = self.live_status()
                if failure == "status":
                    status["ok"] = False
                elif failure == "pid":
                    self.write(".auto-loop.pid", "9999\n")
                elif failure == "count":
                    self.write(".auto-loop-state", "STATUS=running\nLOOP_COUNT=1\nENGINE=codex\nMODEL=example-model\n")
                    status["stateFile"] = self.source.pairs(".auto-loop-state")
                elif failure == "previous_launch":
                    os.utime(self.root / "logs/usage.jsonl.pending", (1600000000, 1600000000))
                else:
                    self.write("logs/usage.jsonl.pending", json.dumps(record("../private", number=2)))
                snapshot = self.source.snapshot(status=status)
                self.assertEqual(len(snapshot["cycles"]), 1)
                self.assertIsNone(snapshot["runtime"]["currentCycleId"])
                self.assertIsNone(snapshot["runtime"]["currentCycleNumber"])
                with self.assertRaises(ValueError):
                    self.source.log("cycle-0002-live", status)

    def test_completed_reservation_is_not_duplicated_while_loop_finishes(self):
        status = self.live_status()
        self.ledger(record("cycle-0002-live", number=2))
        cycles = self.source.snapshot(status=status)["cycles"]
        self.assertEqual(len(cycles), 1)
        self.assertEqual(cycles[0]["status"], "completed")
        self.assertFalse(cycles[0]["active"])

    def test_runtime_failures_do_not_claim_stopped_and_phases_remain_distinct(self):
        status = self.live_status()
        status["ok"] = False
        status["raw"] = "Status command timed out"
        snapshot = self.source.snapshot(status=status)
        self.assertEqual(snapshot["runtime"]["state"], "unavailable")
        self.assertFalse(snapshot["runtime"]["available"])
        self.assertEqual(snapshot["runtime"]["error"], status["raw"])
        self.assertIn("runtime_unavailable", snapshot["warnings"])
        status["ok"] = True
        for phase in ("idle", "paused", "waiting_limit", "circuit_break", "failed", "unknown"):
            with self.subTest(phase=phase):
                status["parsed"]["loop"]["state"] = phase
                status["stateFile"]["STATUS"] = phase
                self.write(".auto-loop-state", "\n".join(f"{key}={value}" for key, value in status["stateFile"].items()))
                runtime = self.source.snapshot(status=status)["runtime"]
                self.assertEqual(runtime["state"], "unavailable" if phase == "unknown" else phase)
                self.assertIsNone(runtime["currentCycleId"])
        status["parsed"]["loop"].update(state="stopped", processState="stopped", pid=None)
        status["parsed"]["daemon"]["state"] = "failed"
        self.assertEqual(self.source.snapshot(status=status)["runtime"]["state"], "failed")

    def test_recorded_cost_and_budget_are_preserved_without_estimation(self):
        budget = {"state": "warning", "period": "day"}
        self.ledger(record(cost_usd=0.125, cost_usd_status="reported", budget=budget),
                    record("cycle-unknown", number=2, cost_usd=None, started_at="2026-09-18T13:00:00+08:00"))
        snapshot = self.source.snapshot()
        self.assertIsNone(snapshot["cycles"][0]["costUsd"])
        self.assertEqual(snapshot["cycles"][1]["costUsd"], 0.125)
        self.assertEqual(snapshot["cycles"][1]["budget"], budget)
        self.assertEqual(snapshot["recordedBudget"], budget)


class JournalHTTPTests(JournalFixture):
    def setUp(self):
        super().setUp()
        self.server = server_module.JournalServer(("127.0.0.1", 0), self.source)
        thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        def close():
            self.server.shutdown()
            self.server.server_close()
            thread.join(3)
        self.addCleanup(close)

    def request(self, path, method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=5)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            connection.close()

    def test_every_write_route_is_forbidden_and_source_unchanged(self):
        self.ledger(record())
        before = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        for path in ("/api/action/start", "/api/action/stop", "/api/language", "/api/journal", "/anything"):
            for method in ("POST", "PUT", "PATCH", "DELETE"):
                self.assertEqual(self.request(path, method)[0], 403)
        after = {str(path.relative_to(self.root)): path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        self.assertEqual(before, after)

    def test_host_origin_and_malformed_query_are_rejected(self):
        self.assertEqual(self.request("/api/journal", headers={"Host": "attacker.test"})[0], 403)
        self.assertEqual(self.request("/api/journal", headers={"Origin": "https://attacker.test"})[0], 403)
        self.assertEqual(self.request("/api/journal", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("/api/journal?" + "&".join(f"x{i}=1" for i in range(15)))[0], 400)

    def test_preview_assets_and_safe_adapters_with_opt_in_legacy(self):
        self.ledger(record())
        self.assertEqual(self.request("/legacy")[0], 404)
        self.assertFalse(json.loads(self.request("/api/journal")[1])["legacyAvailable"])
        for route, relative in (("/", "index.html"), ("/journal", "index.html"), ("/app.js", "app.js"), ("/styles.css", "styles.css"), ("/i18n.js", "i18n.js")):
            code, body, _ = self.request(route)
            self.assertEqual(code, 200)
            self.assertEqual(body, (DASHBOARD / relative).read_bytes())
        for route in ("/api/status", "/api/language", "/api/usage?date=2026-09-18", "/api/log-tail"):
            code, body, _ = self.request(route)
            self.assertEqual(code, 200)
            self.assertTrue(json.loads(body)["readOnly"])
        status = json.loads(self.request("/api/status")[1])
        self.assertEqual(status["parsed"]["daemon"]["state"], "unavailable")
        self.assertEqual(status["parsed"]["loop"]["state"], "stopped")

    def test_legacy_backup_asset_routes_do_not_replace_current_assets(self):
        backup = self.root / "backup"
        self.write("backup/index.html", '<link href="/styles.css"><script src="./i18n.js"></script><script src="app.js"></script>')
        self.write("backup/app.js", "// local legacy version\r\n")
        self.write("backup/i18n.js", "// legacy language")
        self.write("backup/styles.css", "/* legacy style */")
        self.server.legacy = data_module.JournalSource(backup)
        for route in ("/legacy", "/legacy/", "/legacy/index.html"):
            code, body, _ = self.request(route)
            self.assertEqual(code, 200)
            for name in ("app.js", "i18n.js", "styles.css"):
                self.assertIn(f'/legacy/assets/{name}'.encode(), body)
        self.assertTrue(json.loads(self.request("/api/journal")[1])["legacyAvailable"])
        self.assertEqual(self.request("/legacy/assets/app.js")[1], (backup / "app.js").read_bytes())
        self.assertEqual(self.request("/app.js")[1], (DASHBOARD / "app.js").read_bytes())
        self.assertEqual(self.request("/legacy/assets/../.env")[0], 404)

    def test_document_plaintext_and_no_arbitrary_files(self):
        self.write("DELIVERY.md", "# Delivery\n<script>alert('no')</script>")
        self.write("memories/consensus.md", "# Current consensus")
        code, body, headers = self.request("/api/journal/document?path=DELIVERY.md")
        self.assertEqual(code, 200)
        self.assertEqual(headers["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIn(b"<script>", body)
        self.assertEqual(self.request("/api/journal/document?path=memories%2Fconsensus.md")[0], 200)
        self.assertEqual(self.request("/api/journal/document?path=..%2F.env")[0], 400)
        self.assertEqual(self.request("/api/journal/log?id=x&id=y")[0], 400)


class ProductionJournalHTTPTests(JournalFixture):
    def setUp(self):
        super().setUp()
        self.ledger(record())
        self.runtime_status = {"ok": True, "raw": "Stopped", "stateFile": {},
                               "parsed": {"loop": {"state": "stopped", "processState": "stopped", "pid": None}}}
        for patch in (mock.patch.object(production, "REPO_ROOT", self.root),
                      mock.patch.object(production, "gather_status_payload", side_effect=lambda: self.runtime_status)):
            patch.start()
            self.addCleanup(patch.stop)
        self.server = production.ThreadingHTTPServer(("127.0.0.1", 0), production.DashboardHandler)
        thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()
        def close():
            self.server.shutdown()
            self.server.server_close()
            thread.join(3)
        self.addCleanup(close)

    request = JournalHTTPTests.request

    def test_root_and_journal_aliases_use_current_dashboard(self):
        for route in ("/", "/index.html", "/journal", "/journal/", "/journal/index.html"):
            self.assertEqual(self.request(route)[1], (DASHBOARD / "index.html").read_text(encoding="utf-8").encode("utf-8"))
        self.assertEqual(self.request("/legacy")[0], 404)

    def test_snapshot_reuses_shared_language_lock_and_budget_pause(self):
        config = self.write(".auto-company.local", "AUTO_COMPANY_LANGUAGE=en\nAUTO_COMPANY_PRODUCT_ID=" + "a" * 32
                            + "\nAUTO_COMPANY_PRODUCT_LANGUAGE=zh-CN\nAUTO_COMPANY_PRODUCT_STATUS=active\n")
        before = config.read_bytes()
        marker = {"reason": "usage_hard_limit", "budget": {"state": "hard_limit"}}
        self.write(".auto-loop-budget-paused", json.dumps(marker))
        code, body, _ = self.request("/api/journal")
        self.assertEqual(code, 200)
        payload = json.loads(body)
        self.assertFalse(payload["readOnly"])
        self.assertFalse(payload["legacyAvailable"])
        self.assertEqual(payload["language"], "zh-CN")
        self.assertEqual(payload["languageState"]["nextLanguage"], "en")
        self.assertTrue(payload["languageState"]["locked"])
        self.assertTrue(payload["languageState"]["pending"])
        self.assertEqual(payload["budgetPause"], marker)
        self.assertEqual(config.read_bytes(), before)
        self.assertEqual(payload["status"], self.runtime_status)

    def test_running_snapshot_and_log_endpoints_share_verified_identity(self):
        self.runtime_status = self.live_status()
        self.write("logs/cycle-0002-live.log", "active text")
        payload = json.loads(self.request("/api/journal")[1])
        self.assertEqual(payload["cycles"][0]["id"], "cycle-0002-live")
        self.assertEqual(json.loads(self.request("/api/journal/log?id=cycle-0002-live")[1])["text"], "active text")
        self.runtime_status["ok"] = False
        payload = json.loads(self.request("/api/journal")[1])
        self.assertEqual(payload["runtime"]["state"], "unavailable")
        self.assertEqual(self.request("/api/journal/log?id=cycle-0002-live")[0], 400)

    def test_recorded_log_does_not_query_host_and_documents_stay_bounded(self):
        self.write("logs/cycle-0001-run-a.log", "recorded text")
        with mock.patch.object(production, "gather_status_payload", side_effect=AssertionError("No host query for history")):
            self.assertEqual(json.loads(self.request("/api/journal/log?id=cycle-0001-run-a")[1])["text"], "recorded text")
        self.write("DELIVERY.md", "# Delivery\n" + "x" * data_module.MAX_TEXT_BYTES)
        code, body, headers = self.request("/api/journal/document?path=DELIVERY.md")
        self.assertEqual(code, 200)
        self.assertLessEqual(len(body), data_module.MAX_TEXT_BYTES)
        self.assertEqual(headers["X-Content-Truncated"], "true")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.request("/api/journal/document?path=../.env")[0], 400)
        self.assertEqual(self.request("/api/journal/log?id=x&id=y")[0], 400)
        self.assertEqual(self.request("/api/journal", headers={"Origin": "https://attacker.test"})[0], 403)


if __name__ == "__main__":
    unittest.main()
