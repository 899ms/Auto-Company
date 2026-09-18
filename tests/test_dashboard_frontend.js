// Fast semantic checks for the actual journal helpers. Browser tests exercise
// the real DOM, HTTP routes, controls, escaping and language persistence.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const dashboard = path.resolve(__dirname, "../dashboard");
const html = fs.readFileSync(path.join(dashboard, "index.html"), "utf8");
const app = fs.readFileSync(path.join(dashboard, "app.js"), "utf8");
const i18n = fs.readFileSync(path.join(dashboard, "i18n.js"), "utf8");

function helpers() {
  const fields = new Map(["usagePeriod", "usageDate", "usageDateLabel", "usageRange"].map((id) => [id, {}]));
  const context = vm.createContext({ window: {}, document: {
    getElementById: (id) => { assert.ok(fields.has(id), `Unexpected DOM dependency: ${id}`); return fields.get(id); },
  } });
  vm.runInContext(i18n, context);
  // Expose existing closures before event wiring. There is no simulated DOM,
  // copied application logic, network request or production testing hook.
  const binding = app.indexOf("\n  document.querySelectorAll('[data-tab]').forEach");
  assert.ok(binding > 0, "Journal event wiring must follow its helper declarations");
  vm.runInContext(app.slice(0, binding) + "\n globalThis.journal = { state, message, aggregate, duration, cycleTitle, statusLabel, formatTime, filterUsage, reportRows };\n})();", context);
  context.journal.state.language = "en";
  return { ...context.journal, messages: context.window.JOURNAL_MESSAGES, fields };
}

test("both languages cover rendered keys and preserve interpolation fields", () => {
  const { messages } = helpers();
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages["zh-CN"]).sort());
  const placeholders = (value) => [...value.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(messages.en)) {
    assert.equal(typeof messages.en[key], "string");
    assert.ok(messages.en[key] && messages["zh-CN"][key], `Empty translation: ${key}`);
    assert.deepEqual(placeholders(messages.en[key]), placeholders(messages["zh-CN"][key]), key);
  }
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g), ...app.matchAll(/message\('([^']+)'/g)];
  for (const [, key] of keys) assert.ok(messages.en[key], `Missing rendered translation: ${key}`);
});

test("usage totals keep unknown values and coverage separate from measured zero", () => {
  const { aggregate } = helpers();
  const totals = aggregate([
    { usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } },
    { usage: { inputTokens: null, outputTokens: null, totalTokens: null } },
    { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
  ]);
  assert.equal(totals.totalTokens, 100);
  assert.equal(totals.known, 2);
  assert.equal(totals.count, 3);
  assert.equal(totals.partial, true);
  const unknown = aggregate([{ usage: {} }, { usage: { totalTokens: -1 } }]);
  assert.equal(unknown.totalTokens, null);
  assert.equal(unknown.known, 0);
  assert.equal(aggregate([{ usage: { totalTokens: 10, status: "partial" } }]).partial, true);
  assert.equal(aggregate([]).totalTokens, null);
});

test("cycle summaries distinguish active, failed and unknown work without inventing reports", () => {
  const { cycleTitle, messages } = helpers();
  assert.equal(cycleTitle({ status: "running", active: true }), messages.en.runningSummary);
  assert.equal(cycleTitle({ status: "failed" }), messages.en.failedSummary);
  assert.equal(cycleTitle({ status: "interrupted" }), messages.en.interruptedSummary);
  assert.equal(cycleTitle({ status: "unknown" }), messages.en.unknownSummary);
  assert.equal(cycleTitle({ status: "failed", report: '{"private":"raw structure"}' }), messages.en.failedSummary);
  assert.equal(cycleTitle({ summary: "**Verified browser fixture**" }), "Verified browser fixture");
});

test("full report tables retain rows that the summary intentionally abbreviates", () => {
  const { reportRows } = helpers();
  const report = ["| Item | Result |", "| --- | --- |", ...Array.from({ length: 6 }, (_, index) => `| Check ${index + 1} | Passed ${index + 1} |`)].join("\n");
  assert.equal(reportRows({ report }).length, 4);
  const complete = reportRows({ report }, Infinity);
  assert.equal(complete.length, 6);
  assert.equal(complete[5].label, "Check 6");
  assert.equal(complete[5].text, "Passed 6");
});

test("duration and timestamps never imply a reliable end to interrupted work", () => {
  const { duration, formatTime, messages } = helpers();
  const cycle = { startedAt: "2026-09-18T12:00:00Z", endedAt: "2026-09-18T12:01:30Z", status: "completed" };
  assert.equal(duration(cycle), "1m 30s");
  assert.equal(duration({ ...cycle, durationReliable: false }), "");
  assert.equal(duration({ ...cycle, status: "interrupted" }), "");
  assert.equal(duration({ ...cycle, endedAt: null, status: "running" }), "");
  assert.equal(duration({ ...cycle, endedAt: "2026-09-18T11:59:59Z" }), "");
  assert.equal(formatTime("invalid"), messages.en.unknownTime);
});

test("runtime status labels distinguish unavailable services from unrecorded usage", () => {
  const { state, statusLabel, messages } = helpers();
  const states = ["active", "activating", "configured", "deactivating", "failed", "inactive", "idle", "mismatched", "paused", "waiting_limit", "circuit_break", "not_configured", "not_installed", "reloading", "running", "stopped", "unavailable", "unknown", "unsupported"];
  for (const language of ["en", "zh-CN"]) {
    state.language = language;
    for (const value of states) {
      assert.equal(statusLabel(value), messages[language][value === "unavailable" ? "statusUnavailable" : value]);
    }
    assert.equal(statusLabel("future_unknown_state"), messages[language].unknown);
    assert.notEqual(statusLabel("unavailable"), messages[language].unavailable);
  }
});

test("day and week usage filters use ledger end dates and exclude active work", () => {
  const { state, filterUsage, fields } = helpers();
  state.data = { cycles: ["2026-09-13", "2026-09-14", "2026-09-18", "2026-09-20", "2026-09-21"].map((date) => ({ startedAt: `${date}T12:00:00Z`, endedAt: `${date}T12:00:30Z` })) };
  state.data.cycles.push({ startedAt: "2026-09-17T23:59:30Z", endedAt: "2026-09-18T00:00:30Z" });
  state.data.cycles.push({ startedAt: "2026-09-20T23:59:30Z", endedAt: "2026-09-21T00:00:30Z" });
  state.data.cycles.push({ startedAt: "2026-09-18T13:00:00Z", endedAt: null, active: true, usage: {} });
  fields.get("usageDate").value = "2026-09-18";
  fields.get("usagePeriod").value = "day";
  assert.equal(filterUsage().length, 2);
  fields.get("usagePeriod").value = "week";
  assert.deepEqual(Array.from(filterUsage(), (cycle) => cycle.endedAt.slice(0, 10)), ["2026-09-14", "2026-09-18", "2026-09-20", "2026-09-18"]);
  assert.equal(fields.get("usageRange").textContent, "2026-09-14 – 2026-09-20");
  fields.get("usagePeriod").value = "all";
  assert.equal(filterUsage().length, 7);
  assert.equal(filterUsage().some((cycle) => cycle.active), false);
  assert.equal(fields.get("usageDate").hidden, true);
});
