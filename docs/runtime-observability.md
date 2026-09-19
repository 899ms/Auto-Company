# Runtime observations (local prototype)

The Codex adapter projects its JSONL stream into `logs/<cycle-id>.events.jsonl`.
The dashboard reads that stream while the cycle runs. No extra model calls or
AI summaries are used. Original engine output, exit status and supervision
remain authoritative; observation I/O failure does not turn a task into a
success or abort its CLI invocation.

## What is observed

- Command start/end and reported exit code, file-change paths, process/turn events.
- Agent messages, explicitly treated as work reports rather than verified facts.
- Model and reasoning effort from the exact thread's local session context,
  validated against thread ID and framework cwd. No context means unknown.
- Event times are receive times, not reconstructed task timestamps. Only the
  last twelve visible events are shown; original cycle logs remain accessible.

The local session file format is an optional, version-sensitive Codex capability.
The verified CLI version is 0.155.0. Other engines retain the existing dashboard
and report observation data as unavailable. This is not complete child-agent
telemetry, a live token billing feed, or product acceptance.

Limits: event lines 256 KiB, projection 2,000 events / about 2 MiB per cycle;
dashboard reads at most 30 recent cycles, bounded head/tail and 80 events each.
Oversize/invalid output is omitted and interruptions/partial records remain
explicit. Reasoning bodies and command output are not copied into the projection;
known environment credentials and Bearer tokens in projected text are redacted.
This is not a universal secret detector for arbitrary command arguments.

## Tool-owned artifacts

Select a product through the existing project selection command. Then invoke
the following from the framework root (replace `example` with the selected slug):

```sh
python3 scripts/core/runtime_artifacts.py --root . --project projects/example check --report report.xml -- python3 tests.py
python3 scripts/core/runtime_artifacts.py --root . --project projects/example document DELIVERY.md
python3 scripts/core/runtime_artifacts.py --root . --project projects/example preview --directory public --port 8794
```

The check wrapper preserves the command's exit status. It accepts newly written
bounded JUnit XML reports, records actual testcase/failure/error/skip counts and
file hashes, and does not reinterpret arbitrary console output. A zero command
exit with no fresh report is not evidence of passing tests. Changed or missing
files lose their usable link/counts. The dashboard shows only records for the
selected product; artifact timestamps are registration times.

The optional preview runner serves static content from an explicit product
directory on loopback. Its own health response includes a per-run token, so
stopped servers and port reuse do not produce a working preview link. It does
not discover, start or validate arbitrary Vite/Next/backend servers. Those
require separate runner integration. A preview started inside a model cycle is
owned by that cycle and ends during normal supervisor cleanup; keeping a preview
alive is a separate operator action, not an implicit cycle side effect.

Artifact records live in `logs/artifacts/`. The prototype bounds discovery to
501 entries, checks the newest 100 of those, and exposes up to 20 records and
three loopback checks per refresh. It is not an unlimited artifact archive.

## Verification model

`MODEL=gpt-5.6-luna CODEX_REASONING_EFFORT=high ENGINE=codex`.
This is the local experiment's policy in ignored `AGENTS.md`; it is not a new
production default. `CODEX_REASONING_EFFORT` is optional and does not substitute
for observed configuration in the dashboard.
