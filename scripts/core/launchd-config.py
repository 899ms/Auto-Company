"""Render launchd configuration without interpolating unescaped XML or secrets."""

import argparse
import os
from pathlib import Path
import plistlib


# Only non-secret runtime settings may cross the service-manager boundary.
RUNTIME_SETTINGS = (
    "ENGINE", "MODEL", "AUTO_COMPANY_LANGUAGE", "CLAUDE_BIN", "CLAUDE_PERMISSION_MODE", "CODEX_BIN",
    "CODEX_SANDBOX_MODE", "CURSOR_BIN", "CURSOR_ADAPTER_ENABLED",
    "CURSOR_SANDBOX_MODE", "CURSOR_FORCE", "CURSOR_ALLOW_UNSANDBOXED",
    "OPENAI_COMPATIBLE_ADAPTER_ENABLED", "OPENAI_COMPATIBLE_ENDPOINT",
    "OPENAI_COMPATIBLE_MODEL", "OPENAI_COMPATIBLE_ALLOW_SHELL",
    "OPENAI_COMPATIBLE_ALLOW_INSECURE_HTTP", "OPENAI_COMPATIBLE_SAFE_COMMANDS",
    "OPENAI_COMPATIBLE_REQUEST_TIMEOUT_SECONDS", "OPENAI_COMPATIBLE_MAX_TURNS",
    "LOOP_INTERVAL", "CYCLE_TIMEOUT_SECONDS", "CYCLE_TERM_GRACE_SECONDS",
    "CYCLE_KILL_WAIT_SECONDS", "MAX_CONSECUTIVE_ERRORS", "COOLDOWN_SECONDS",
    "LIMIT_WAIT_SECONDS", "MAX_LOGS", "AUTO_LOOP_PROTECT_GITIGNORE",
    "USAGE_BUDGET_PERIOD", "USAGE_WARNING_USD", "USAGE_HARD_LIMIT_USD",
    "USAGE_WARNING_TOKENS", "USAGE_HARD_LIMIT_TOKENS", "BUDGET_PAUSE_POLL_SECONDS",
)


def render(project: str, path: str, environ: dict[str, str]) -> bytes:
    settings = {key: environ[key] for key in RUNTIME_SETTINGS if key in environ}
    settings.update({"PATH": path, "HOME": environ["HOME"]})
    return plistlib.dumps({
        "Label": "com.autocompany.loop",
        "ProgramArguments": ["/bin/bash", f"{project}/scripts/core/auto-loop.sh", "--daemon"],
        "WorkingDirectory": project,
        "KeepAlive": {"PathState": {f"{project}/.auto-loop-paused": False}},
        "RunAtLoad": True,
        "StandardOutPath": f"{project}/logs/launchd-stdout.log",
        "StandardErrorPath": f"{project}/logs/launchd-stderr.log",
        "EnvironmentVariables": settings,
        "ThrottleInterval": 30,
    }, sort_keys=False)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    encoded = render(args.project, args.path, dict(os.environ))
    temporary = args.output.with_suffix(".plist.tmp")
    try:
        temporary.write_bytes(encoded)
        temporary.chmod(0o600)
        temporary.replace(args.output)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
