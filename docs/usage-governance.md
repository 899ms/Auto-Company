# Usage and budget governance

[English](usage-governance.md) | [中文](../i18n/zh-CN/docs/usage-governance.md) · [Documentation and language settings](../i18n/README.md)

Run the commands below from the repository root.

Each finished Cycle appends one JSON object to `logs/usage.jsonl`. Reports and
the Dashboard read this ledger directly; `auto-loop.log` is not parsed for cost
or token accounting.

Before invoking a provider, the loop persists a minimal Cycle identity in
`logs/usage.jsonl.pending`. Graceful interruption records it as `interrupted`
with unknown cost and tokens; after a kill or crash, startup recovers that
identity before starting another provider. If a finished record was flushed
before the crash, recovery keeps that record and removes the stale pending
identity. Provider usage lost during interruption cannot be reconstructed.
Recovered records identify their source as `cycle_recovery` / `unknown_usage`;
they do not infer provider metadata from unfinished logs.

## Cycle record contract

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

`engine`, `model`, `usage.input_tokens`, `usage.output_tokens`,
`usage.total_tokens`, and `cost_usd` are populated from the standard
`logs/cycle-<id>.json` Engine Adapter sidecar. Claude, Codex, Cursor, and
OpenAI-compatible provider formats are normalized before that boundary;
usage, budgets, and the Dashboard never reparse provider-specific output.

An unavailable value is JSON `null`, accompanied by `unavailable` or `partial`
status. It is never recorded as zero. USD cost is accepted only when engine
metadata reports it; the project does not maintain or infer a model price table.

Cycle IDs include a random run suffix so counter resets within the same second
cannot collide. Ledger appends take a local file lock and flush completed
records to disk. Replaying the same identity and payload is idempotent;
conflicting payloads are rejected. Reports count identical duplicate rows once
and report invalid/conflicting rows as diagnostics. Invalid ledger data blocks
new accounting and startup until repaired; it is never silently discarded.

## Reports and API

```bash
make usage-day
make usage-week
make usage-date DATE=2026-09-01
python3 scripts/core/usage.py summary --period week --date 2026-09-01 --format json
```

Weeks run Monday through Sunday. A Cycle belongs to the calendar date encoded
in its `ended_at` timestamp, so historical and cross-midnight reports are
deterministic.

Host or virtual-machine clock synchronization can move wall time backwards
within a Cycle or before interrupted-cycle recovery. Accounting preserves the
observed `started_at` and `ended_at`, including a reversed pair, and records a
`clock_anomaly` object with type `wall_clock_rollback` and a negative
`wall_clock_delta_seconds`. A warning is emitted when that record is appended.
This delta is not an elapsed duration. Usage stays assigned to the observed
completion/recovery date, including when the clock moves into the preceding
day; it is never discarded or reassigned to a future start date. Interrupted
usage remains unknown and configured hard-budget checks still pause normally.

The Dashboard endpoint is `GET /api/usage?period=day|week&date=YYYY-MM-DD`. It
returns the structured summary plus any persistent budget-pause details.

## Budget policy

Configure any combination in `.auto-loop.env`:

```dotenv
USAGE_BUDGET_PERIOD=day
USAGE_WARNING_USD=5
USAGE_HARD_LIMIT_USD=10
USAGE_WARNING_TOKENS=500000
USAGE_HARD_LIMIT_TOKENS=1000000
```

Warning thresholds only emit a `BUDGET` alert. A hard threshold first lets the
current Cycle finish and writes its ledger record, then creates
`.auto-loop-budget-paused` and blocks the next Cycle. The marker is persistent;
only an explicit `make resume` or `python3 scripts/core/usage.py resume` clears
it. Startup validates the configuration and re-evaluates existing ledger data,
recreating a missing hard-budget pause before a provider can run.

| Budget condition | State | Next Cycle |
| --- | --- | --- |
| No threshold configured | `disabled` | Allowed |
| Known usage below configured limits, or no Cycles yet in the window | `ok` | Allowed |
| Warning threshold reached | `warning` | Allowed, with an alert |
| Only a warning metric is unknown | `indeterminate` | Allowed, with a diagnostic |
| Hard-limit metric is missing for any Cycle in the window | `unverifiable` | Paused with reason `budget_unverifiable` |
| A known metric reaches its hard limit | `hard_limit` | Paused with reason `usage_hard_limit` |

Only configured metrics matter: unknown USD cost does not block a token-only
hard budget when total tokens are known. Unknown usage is never interpreted as
zero or as proof that a hard threshold was exceeded. Warning thresholds cannot
exceed their corresponding hard thresholds; token thresholds must be positive
integers. Invalid budget settings reject startup before a provider is invoked.

Manual resume acknowledges the exact ledger and configured limits for the next
Cycle. It does not reset totals or grant a permanent exemption: that Cycle is
evaluated again when it closes. A small ignored
`.auto-loop-budget-paused.resume` checkpoint preserves this acknowledgement
through a restart and is consumed once. A changed ledger cannot reuse it.
Crossing midnight does not automatically clear a persistent pause.
