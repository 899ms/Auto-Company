# Languages / 语言

Auto-Company supports English and Simplified Chinese for its own instructions,
documentation and Dashboard. [English resources](en/README.md) ·
[English project guide](../README.md) · [中文项目说明](../README-ZH.md)

## Runtime language / 运行语言

Stop the loop before changing its human-owned configuration. From the repository root:

先停止循环，再从仓库根目录修改人工配置：

```bash
make language LANGUAGE=en
# Chinese / 中文
make language LANGUAGE=zh-CN
```

On Windows, without make / Windows 不使用 make 时：

```powershell
python scripts/core/localization.py set --language en
```

This updates only `AUTO_COMPANY_LANGUAGE` in `.auto-company.local`, preserving
project selection, comments and other settings. The default is `zh-CN`.
The process environment variable `AUTO_COMPANY_LANGUAGE` overrides the saved
choice. Invalid values block model invocation. Both `make start` and `make team`
use this setting. Restart an interactive session after changing it.

此命令只更新 `.auto-company.local` 中的 `AUTO_COMPANY_LANGUAGE`，保留项目选择、
注释和其他配置；默认值为 `zh-CN`。同名环境变量优先于已保存设置。
非法值会阻止模型调用。`make start` 与 `make team` 都会使用此设置，
交互会话需要重启才能应用修改。

Windows `start-win.ps1 -Language en` writes an override into the existing
`.auto-loop.env` used by systemd. A macOS language environment override is captured
when installing launchd; reinstall to change that captured override. Prefer the
repository-local setting above for a common configuration across platforms.

Windows 的 `start-win.ps1 -Language en` 会将覆盖值写入现有 systemd 使用的
`.auto-loop.env`。macOS 安装 launchd 时会保存环境变量中的语言覆盖值；修改此覆盖值
需要重新安装服务。跨平台统一配置推荐使用上面的仓库本地设置。

## Resource selection / 资源选择

`scripts/core/localization.py` builds the runtime language instructions and selects
localized files using `source-hashes.json`. It never rewrites the original files.
A packaged translation is used only when its source still matches the reviewed
baseline (CRLF/LF differences do not count as edits). If the source was customized
or a translation is missing, the original source is selected instead. The runtime
prompt lists the selected paths for roles and skills. Explicit human instructions
take precedence over the output-language preference.

`scripts/core/localization.py` 根据 `source-hashes.json` 选择资源并生成语言指令，
不会重写原始文件。仅在原文仍与已审核基线一致时使用配套译文，CRLF/LF 差异不算修改。
若用户已定制原文，或译文缺失，则使用原始文件。运行提示词会列出角色与技能应读取的
路径；明确的人工指令优先于输出语言偏好。

Consensus protocol headings, identifiers, commands and paths remain unchanged.
Existing logs, prior consensus prose and the protected `Human Overrides` section
are not translated. The language selection file retains its existing governance
protection: agents may not edit it during a cycle. Direct CLI invocations outside
`make team` do not automatically receive these runtime language instructions.

共识协议标题、标识符、命令和路径保持不变；既有日志、历史共识和受保护的
`Human Overrides` 区段不会被翻译。语言配置沿用人工配置保护：Agent 不得在周期内修改。
绕过 `make team` 直接运行 CLI 时，不会自动注入本项目的运行语言指令。

## Coverage / 覆盖范围

| Content / 内容 | English / 英文 | Chinese / 中文 |
|---|---|---|
| Project README / 项目说明 | `README.md` | `README-ZH.md` |
| Loop prompt, 14 roles, team and GitHub Explorer skills / 循环提示词、14 个角色、组队及项目调研技能 | `i18n/en/` | Original files / 原文件 |
| Repository index and Windows guide / 仓库索引与 Windows 指南 | `i18n/en/` | Original files / 原文件 |
| Company rules, engine adapters and usage governance / 公司规则、引擎适配与用量治理 | Original files / 原文件 | `i18n/zh-CN/` |
| Dashboard / 看板 | Interface selector / 界面选择器 | Interface selector / 界面选择器 |

Dashboard language is a separate browser preference. It follows the first supported
browser language initially, falls back to English, and remembers an explicit choice
when browser storage is available. It does not change runtime settings or translate
raw provider errors, logs, consensus, or user-created content.

看板语言是独立的浏览器偏好：初次采用浏览器支持的语言，否则回退英文；浏览器允许
存储时会记住手动选择。它不会改变运行语言，也不翻译提供商原始错误、日志、共识或用户内容。

Bundled third-party skills, generated product repositories, terminal diagnostics
and machine-readable status/API fields retain their existing language. This release
does not translate those surfaces.

附带的第三方技能、生成的产品仓库、终端诊断和机器读取的状态/API 字段保留原有语言，
不在本版翻译范围内。

## Updating translations / 维护译文

When changing a source, update both language versions and review instruction strength,
terminology, code blocks and links. Then update its SHA-256 in `source-hashes.json`
using UTF-8 bytes with CRLF normalized to LF. Run `tests/test_localization.py` and
the affected runtime or Dashboard tests. Do not refresh hashes merely to silence
a stale-translation failure. A fallback protects custom source files; it is not a
substitute for keeping the released translations current.

修改原文后，同步更新两种语言并核对指令强度、术语、代码块与链接；再将 UTF-8 内容
的 CRLF 归一为 LF，更新 `source-hashes.json` 中对应 SHA-256。运行语言选择测试及受影响的
运行或看板测试。不得仅为消除失败而刷新哈希。回退用于保护用户定制，不能替代发布前的译文同步。
