"""Serve the real dashboard from disposable files without invoking host services."""

import argparse
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import tempfile
import threading
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[2]
STATUS_OUTPUT = """=== Guardian ===
State=stopped
=== Daemon ===
State=inactive
=== Autostart ===
State=not_configured
EnabledState=disabled
=== Loop ===
State=stopped
"""
WINDOWS_STATUS_OUTPUT = """=== Windows Guardian ===
Awake guardian: STOPPED
=== Windows Autostart Task ===
Autostart: NOT CONFIGURED
=== WSL Daemon (systemd --user) ===
inactive
=== Auto Company Status ===
Loop: NOT RUNNING
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=("default", "active-product", "save-failure"),
                        default="default")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="auto-company-browser-") as directory, ExitStack() as stack:
        root = Path(directory)
        # Import a copy so every path, including default arguments, stays in the
        # temporary checkout. No local logs, configuration or services are read.
        shutil.copytree(REPO_ROOT / "dashboard", root / "dashboard")
        core = root / "scripts/core"
        core.mkdir(parents=True)
        for name in ("localization.py", "usage_lib.py"):
            shutil.copy2(REPO_ROOT / "scripts/core" / name, core / name)
        (root / "memories").mkdir()
        (root / "memories/consensus.md").write_text("# Browser smoke consensus\n", encoding="utf-8")
        spec = importlib.util.spec_from_file_location("dashboard_smoke_server", root / "dashboard/server.py")
        server_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server_module)

        stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
        stack.enter_context(mock.patch.object(server_module.localization, "system_language", return_value="en"))
        # Keep parsing, rendering, HTTP handling and language persistence real;
        # replace only the boundary that would inspect or change host services.
        stack.enter_context(mock.patch.object(server_module, "run_status_command", return_value={
            "ok": True, "exitCode": 0, "elapsedMs": 1,
            "output": WINDOWS_STATUS_OUTPUT if platform.system() == "Windows" else STATUS_OUTPUT,
        }))
        stack.enter_context(mock.patch.object(server_module, "run_dashboard_action", return_value={
            "ok": False, "exitCode": 1, "elapsedMs": 1,
            "output": "Host actions are disabled in browser smoke tests.",
        }))
        if args.scenario == "active-product":
            server_module.localization.start_product(root, {})
        elif args.scenario == "save-failure":
            stack.enter_context(mock.patch.object(server_module.localization, "set_language",
                                                 side_effect=OSError("simulated write failure")))

        server = server_module.ThreadingHTTPServer(("127.0.0.1", 0), server_module.DashboardHandler)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.05), daemon=True)
        thread.start()
        print(json.dumps({"url": f"http://127.0.0.1:{server.server_address[1]}"}), flush=True)
        try:
            # Closing the parent's pipe shuts down the server and removes state.
            sys.stdin.read()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)


if __name__ == "__main__":
    main()
