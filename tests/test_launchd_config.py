import importlib.util
from pathlib import Path
import plistlib
import unittest


SPEC = importlib.util.spec_from_file_location(
    "launchd_config", Path(__file__).resolve().parents[1] / "scripts/core/launchd-config.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LaunchdConfigTests(unittest.TestCase):
    def test_runtime_budget_and_timeout_survive_install(self):
        env = {
            "HOME": "/Users/test", "ENGINE": "codex",
            "CODEX_SANDBOX_MODE": "workspace-write", "CYCLE_TIMEOUT_SECONDS": "80",
            "CYCLE_TERM_GRACE_SECONDS": "2", "USAGE_BUDGET_PERIOD": "week",
            "USAGE_HARD_LIMIT_TOKENS": "10000", "USAGE_WARNING_USD": "2",
            "OPENAI_COMPATIBLE_API_KEY": "secret-api-sentinel",
            "CURSOR_API_KEY": "secret-cursor-sentinel", "UNRELATED": "not-runtime",
        }
        raw = MODULE.render("/Users/test/repo", "/bin", env)
        actual = plistlib.loads(raw)["EnvironmentVariables"]
        for key in ("ENGINE", "CODEX_SANDBOX_MODE", "CYCLE_TIMEOUT_SECONDS",
                    "CYCLE_TERM_GRACE_SECONDS", "USAGE_BUDGET_PERIOD",
                    "USAGE_HARD_LIMIT_TOKENS", "USAGE_WARNING_USD"):
            self.assertEqual(actual[key], env[key])
        self.assertNotIn(b"secret-", raw)
        self.assertNotIn("UNRELATED", actual)

    def test_xml_special_characters_preserve_exact_configuration(self):
        project = '/Users/test/Research & Development/"trial"'
        model = 'model<&"test>'
        payload = plistlib.loads(MODULE.render(project, "/tools & more:/bin", {
            "HOME": "/Users/test", "MODEL": model,
        }))
        self.assertEqual(payload["WorkingDirectory"], project)
        self.assertEqual(payload["ProgramArguments"][1], project + "/scripts/core/auto-loop.sh")
        self.assertEqual(payload["EnvironmentVariables"]["MODEL"], model)
        self.assertEqual(payload["KeepAlive"]["PathState"], {project + "/.auto-loop-paused": False})


if __name__ == "__main__":
    unittest.main()
