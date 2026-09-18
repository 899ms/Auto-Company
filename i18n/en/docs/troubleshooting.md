# Common operations and troubleshooting

[English](troubleshooting.md) · [中文](../../../docs/troubleshooting.md) · [Language settings](../../README.md)

Run these commands from the Auto-Company repository root. `make` commands apply to Linux/WSL and macOS; Windows has PowerShell entrypoints. Keep the original error when troubleshooting: translated guidance explains the next step without replacing the underlying evidence.

## Everyday operations

| Goal | Linux/WSL and macOS | Windows PowerShell |
|---|---|---|
| List commands | `make help` | See the [Windows guide](windows-setup.md) |
| Start | Foreground: `make start`; install background service: `make install` | `./scripts/windows/start-win.ps1` |
| Stop | Foreground loop: `make stop`; background service: `make pause` | `./scripts/windows/stop-win.ps1` |
| Check status | `make status` | `./scripts/windows/status-win.ps1` |
| Read the last cycle | `make last` | `./scripts/windows/last-win.ps1` |
| Save English | After stopping: `make language LANGUAGE=en` | After stopping: `python scripts/core/localization.py set --language en` |
| Save Chinese | After stopping: `make language LANGUAGE=zh-CN` | After stopping: `python scripts/core/localization.py set --language zh-CN` |

Before changing language, stop a foreground loop with `make stop`, or pause a background service with `make pause` to prevent automatic restarts. Changes apply at the next start; use `make resume` for a paused service. If the daemon has a saved `AUTO_COMPANY_LANGUAGE` override, update that too; Windows can use `-Language en` or `-Language zh-CN` on the next start. Dashboard interface language is separate.

## Installation and startup

| Symptom or original message | Meaning | Next step |
|---|---|---|
| `wsl.exe not found` | Windows cannot invoke WSL | Install and configure WSL using the [Windows guide](windows-setup.md), then start the project. |
| WSL distribution or path conversion fails | The selected distribution is unavailable, or the repository path cannot be converted | Check distribution names with `wsl --list --verbose`; pass the matching `-Distro` to the entrypoint and keep the original path error. |
| Engine executable not found | The selected engine is missing from the execution environment or PATH | On Windows, check the CLI inside the same WSL distribution; configure its entrypoint using the [engine guide](../../../ENGINE_ADAPTERS.md). Do not automatically switch engines. |
| `systemctl --user` cannot connect | The WSL/Linux user service manager is unavailable | Follow the installation guide to enable systemd and reopen the target distribution; retain the full systemctl diagnostic. |
| Already running | Another loop holds this repository's lock | Check status first; stop normally before changing configuration. Do not bypass the lock by deleting PID/lock files. |
| An installed macOS service fails to start | Service configuration, paths or the underlying launchd operation need investigation | Check `make status` and the original launchctl error; stop before correcting configuration. Do not recreate the service merely to change interface language. |

## Language did not change as expected

1. Check whether you changed the runtime language or the independent Dashboard preference.
2. Runtime language accepts only `zh-CN` or `en`. Invalid values block model startup instead of silently selecting another language.
3. The process environment takes precedence over `.auto-company.local`; an override captured during service installation may still apply. See [language precedence](../../README.md).
4. If asked to stop the loop, use `make stop` for foreground operation or `make pause` for a background service, then save and restart/resume. Reopen interactive `make team` sessions too.
5. Customized prompts or skills retain their source text, and explicit human language instructions take precedence. Commands, protocol fields, history and original errors intentionally remain unchanged.

## Budget pauses and manual recovery

| State | Action |
|---|---|
| Hard budget reached | Read `make usage-status` and `make usage-day` to check usage and limits; resolve the cause before resuming. |
| Hard budget cannot be verified | Usage may be missing; unknown does not mean zero. Check records and engine responses without clearing the ledger. |
| Human-rule or P1 blocker | Read the pause reason, `Human Overrides` and `Priority Issues`; resolve the blocker before resuming instead of removing the rule to bypass it. |

For a Linux/WSL or macOS background service, use `make resume` after resolving the cause. For a foreground loop, stop normally, clear the budget pause with `python3 scripts/core/usage.py resume`, then run `make start` again. Windows users can run the background recovery command inside the matching WSL repository. Resuming does not clear recorded usage; the loop pauses again if the limit is still exceeded. See [usage governance](../../../docs/usage-governance.md).

## What to include in a report

Include your operating system, WSL distribution if applicable, project version, command, selected language, original error and relevant log excerpts. Remove keys, tokens and private business content before sharing; the entire configuration directory is unnecessary.
