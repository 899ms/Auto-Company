# 常见操作与排错

[中文](troubleshooting.md) · [English](../i18n/en/docs/troubleshooting.md) · [语言设置](../i18n/README.md)

以下命令从 Auto-Company 仓库根目录执行。`make` 命令适用于 Linux/WSL 和 macOS；Windows 使用 PowerShell 入口。排错时保留原始报错，翻译提示帮助理解下一步，不替代底层证据。

## 日常操作

| 目的 | Linux/WSL、macOS | Windows PowerShell |
|---|---|---|
| 查看可用命令 | `make help` | 参阅 [Windows 指南](windows-setup.md) |
| 启动 | 前台运行：`make start`；后台安装：`make install` | `./scripts/windows/start-win.ps1` |
| 停止 | 前台循环：`make stop`；后台服务：`make pause` | `./scripts/windows/stop-win.ps1` |
| 查看状态 | `make status` | `./scripts/windows/status-win.ps1` |
| 查看上一轮 | `make last` | `./scripts/windows/last-win.ps1` |
| 保存英文语言 | `make language LANGUAGE=en` | `python scripts/core/localization.py set --language en` |
| 保存中文语言 | `make language LANGUAGE=zh-CN` | `python scripts/core/localization.py set --language zh-CN` |

产品运行期间可以保存语言偏好，当前产品继续使用原语言，新偏好在下个产品周期生效。暂停或重启本身不会开始新产品。详见[语言说明](../i18n/README.md)。

## 安装与启动

| 现象或原始提示 | 含义 | 下一步 |
|---|---|---|
| `wsl.exe not found` | Windows 尚无法调用 WSL | 先按 [Windows 指南](windows-setup.md) 安装并配置 WSL，再启动项目。 |
| WSL 发行版或路径转换失败 | 指定的发行版不可用，或仓库路径无法转换 | 用 `wsl --list --verbose` 查看发行版名称；为入口传入对应 `-Distro`，保留原始路径错误。 |
| 引擎命令找不到 | 所选引擎没有安装在实际执行环境中，或不在 PATH | Windows 用户在同一个 WSL 发行版里检查 CLI；按 [引擎指南](../i18n/zh-CN/ENGINE_ADAPTERS.md) 设置正确入口。不要自动换用另一个引擎。 |
| `systemctl --user` 无法连接 | WSL/Linux 用户服务管理器不可用 | 按安装指南启用 systemd 并重新进入目标发行版；保留 systemctl 的完整诊断。 |
| 提示已经运行 | 当前仓库的循环锁已被占用 | 先查看状态；需要改配置时正常停止。不要靠删除 PID/锁文件强行绕过。 |
| macOS 已安装服务但启动失败 | 服务配置、路径或底层 launchd 操作需要排查 | 查看 `make status` 和原始 launchctl 报错；停止后再修正配置。不要为了改界面语言重建服务。 |

## 语言没有按预期变化

1. 在 Dashboard 查看“当前周期语言”和“下个周期语言”；两者不同时，新偏好已保存，正在等待下个产品周期。
2. 暂停、重启以及同一产品的下一轮 AI 执行，都不会切换当前产品语言。
3. 只有明确开始下个产品周期才会采用新偏好，详见[周期切换](../i18n/README.md)。
4. 语言只接受 `zh-CN` 或 `en`。已保存的偏好优先于旧服务环境；没有偏好时才使用兼容环境值或系统显示语言。
5. 技能源文件统一英文，命令、协议字段、历史和原始错误保持原样；已有产品和自定义文档不会被自动重写。

## 预算暂停与人工恢复

| 状态 | 处理 |
|---|---|
| 达到硬预算上限 | 查看 `make usage-status` 与 `make usage-day`，确认实际用量和限制；先解决限制原因，再恢复。 |
| 无法核实硬预算 | 用量可能缺失，未知值不等于零。检查记录与引擎返回值，不要直接清空账本。 |
| 人工规则/P1 阻断 | 查看暂停原因与 `Human Overrides`、`Priority Issues`；修复阻断条件后再恢复，不要删除规则来绕过。 |

Linux/WSL、macOS 的后台服务可在原因解决后使用 `make resume`；前台运行先正常停止，再用 `python3 scripts/core/usage.py resume` 清除预算暂停并重新 `make start`。Windows 用户可在对应 WSL 仓库中执行后台恢复命令。恢复不会清空已记录的用量，再次超限仍会暂停。详细规则见 [用量治理](../i18n/zh-CN/docs/usage-governance.md)。

## 提交问题时提供什么

提供操作系统、WSL 发行版（如适用）、项目版本、执行的命令、所选语言、原始错误及相关日志片段。发送前移除密钥、令牌和不应公开的业务内容；无需提供整个配置目录。
