# 用量与预算治理

[中文](usage-governance.md) | [English](../../../docs/usage-governance.md) · [文档与语言设置](../../README.md)

以下命令均在仓库根目录运行。

每个结束的 Cycle 都会向 `logs/usage.jsonl` 追加一个 JSON 对象。报表和 Dashboard 直接读取该账本，不从 `auto-loop.log` 解析费用或 token 用量。

调用提供方之前，循环先将最小 Cycle 标识写入 `logs/usage.jsonl.pending` 并持久化。正常处理中断时，会记录为 `interrupted`，费用和 token 用量均为未知；如果进程被强杀或崩溃，下一次启动会在调用任何提供方之前恢复该标识。如果完整记录已在崩溃前写入磁盘，恢复时会保留该记录，并删除过期的待完成标识。中断期间丢失的提供方用量无法重建。恢复记录以 `cycle_recovery` / `unknown_usage` 标明来源，不会从未完成的日志中推测提供方元数据。

## Cycle 记录契约

```json
{
  "schema_version": 1,
  "kind": "cycle_usage",
  "cycle_id": "cycle-0001-20260902-120000-a1b2c3d4e5f6",
  "cycle_number": 1,
  "started_at": "2026-09-02T12:00:00+0800",
  "ended_at": "2026-09-02T12:05:00+0800",
  "status": "completed",
  "exit_code": 0,
  "engine": "claude",
  "model": "config-default",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 300,
    "total_tokens": 1500,
    "status": "reported"
  },
  "cost_usd": 0.42,
  "cost_usd_status": "reported",
  "source": {
    "type": "engine_metadata",
    "adapter": "cycle_sidecar_v1"
  },
  "budget": {
    "state": "ok",
    "period": "day",
    "start_date": "2026-09-02",
    "end_date": "2026-09-02",
    "limits": {
      "warning_usd": 5.0,
      "hard_usd": 10.0,
      "warning_tokens": null,
      "hard_tokens": null
    },
    "alerts": []
  }
}
```

`engine`、`model`、`usage.input_tokens`、`usage.output_tokens`、`usage.total_tokens` 和 `cost_usd` 来自标准的引擎适配器伴随文件 `logs/cycle-<id>.json`。Claude、Codex、Cursor 和 OpenAI-compatible 提供方的输出格式会在进入该边界之前完成统一；用量、预算和 Dashboard 不会再次解析各提供方的专用输出。

无法获取的值写为 JSON `null`，并附带 `unavailable` 或 `partial` 状态，绝不会记作零。仅当引擎元数据报告美元费用时才接受该值；项目不维护或推测模型价格表。

Cycle ID 包含每次运行的随机后缀，因此同一秒内重置计数器也不会发生冲突。账本追加使用本地文件锁，并将已完成记录刷新到磁盘。重复提交相同标识和内容是幂等的；内容冲突则被拒绝。报表对完全相同的重复行只计数一次，并将无效或冲突的行报告为诊断信息。账本数据无效时，在修复之前会阻止新记账和启动，不会静默丢弃数据。

## 报表与 API

```bash
make usage-day
make usage-week
make usage-date DATE=2026-09-01
python3 scripts/core/usage.py summary --period week --date 2026-09-01 --format json
```

每周从周一至周日。Cycle 归属于其 `ended_at` 时间戳中的日历日期，使历史查询和跨午夜报表具有确定的结果。

宿主机或虚拟机的时钟同步可能在某轮 Cycle 内或中断恢复前将系统时钟拨回。记账会保留实际观察到的 `started_at` 和 `ended_at`，即使结束时间早于开始时间；同时记录 `clock_anomaly` 对象，其类型为 `wall_clock_rollback`，`wall_clock_delta_seconds` 为负数。追加该记录时会发出警告。这一差值不表示实际经过的时长。用量仍归属于观察到的完成或恢复日期，即使时钟退回到了前一天；不会被丢弃，也不会被重新归入较晚的开始日期。中断用量仍为未知，已配置的硬预算检查仍会正常触发暂停。

Dashboard 接口为 `GET /api/usage?period=day|week&date=YYYY-MM-DD`，返回结构化汇总及持久化的预算暂停详情。

## 预算策略

在 `.auto-loop.env` 中按需组合配置：

```dotenv
USAGE_BUDGET_PERIOD=day
USAGE_WARNING_USD=5
USAGE_HARD_LIMIT_USD=10
USAGE_WARNING_TOKENS=500000
USAGE_HARD_LIMIT_TOKENS=1000000
```

预警阈值只产生 `BUDGET` 告警。达到硬阈值时，会先让当前 Cycle 结束并写入账本，再创建 `.auto-loop-budget-paused`，阻止下一轮开始。暂停标记会持久保留，只有显式执行 `make resume` 或 `python3 scripts/core/usage.py resume` 才会清除。启动时会校验配置并重新评估已有账本；如果硬预算暂停标记缺失，会在提供方运行前重新创建。

| 预算情况 | 状态 | 下一轮 Cycle |
| --- | --- | --- |
| 未配置阈值 | `disabled` | 允许 |
| 已知用量低于配置上限，或统计周期内尚无 Cycle | `ok` | 允许 |
| 达到预警阈值 | `warning` | 允许，同时告警 |
| 只有预警指标未知 | `indeterminate` | 允许，同时报告诊断信息 |
| 统计周期内任意 Cycle 缺失硬限制指标 | `unverifiable` | 暂停，原因为 `budget_unverifiable` |
| 已知指标达到硬限制 | `hard_limit` | 暂停，原因为 `usage_hard_limit` |

只检查已配置的指标：如果仅设置 token 硬预算且 token 总量已知，美元费用未知不会阻止运行。未知用量既不会被当成零，也不会被视为已超出硬阈值的证据。预警阈值不得超过对应的硬阈值；token 阈值必须为正整数。无效预算设置会在调用提供方前拒绝启动。

手动恢复表示确认当前确切的账本和预算限制，并允许下一轮 Cycle 运行。它不会清零总量，也不会永久豁免预算：该轮结束时会再次评估。一个被 Git 忽略的小型检查点 `.auto-loop-budget-paused.resume` 会让这次确认在重启后仍然有效，但只能使用一次；账本一旦变化，就不能复用该确认。跨过午夜也不会自动清除持久化的暂停状态。
