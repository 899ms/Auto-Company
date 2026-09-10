// Execute the actual page script with a minimal DOM and mocked HTTP responses.
// No browser, network, service manager, or model is invoked.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dashboard = path.resolve(__dirname, "../dashboard");
const html = fs.readFileSync(path.join(dashboard, "index.html"), "utf8");
const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => {
  const classes = new Set();
  return [id, {
    textContent: "", innerHTML: "", style: {}, disabled: false, checked: true,
    value: id === "usagePeriod" ? "day" : "5000", listeners: {},
    classList: {
      add: (...items) => items.forEach((item) => classes.add(item)),
      remove: (...items) => items.forEach((item) => classes.delete(item)),
      toggle: (item, active) => active ? classes.add(item) : classes.delete(item),
      contains: (item) => classes.has(item),
    },
    addEventListener(event, listener) { this.listeners[event] = listener; },
  }];
}));
const element = (id) => { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); };
const metric = (value, status = "complete", known = 1, unknown = 0) => ({
  value, status, known_cycles: known, unknown_cycles: unknown,
});
const budget = (state = "ok", alerts = []) => ({
  state, alerts, period: "day", start_date: "2026-09-09", end_date: "2026-09-09",
});
const fullUsage = () => ({
  summary: {
    period: "day", start_date: "2026-09-09", end_date: "2026-09-09", cycles: 1, invalid_records: 0,
    cost_usd: metric(1.25), usage: {
      input_tokens: metric(80), output_tokens: metric(20), total_tokens: metric(100),
    }, latest_budget: budget(),
  }, budgetPause: null,
});
let usage = fullUsage();
let status = {
  ok: true, timestamp: "2026-09-09T12:00:00Z", stateFile: { STATUS: "running" },
  parsed: {
    guardian: { state: "unsupported" }, daemon: { state: "active" },
    loop: { state: "running", pid: 123 }, autostart: { state: "configured" },
  },
};
let usageFailure = false;
let statusFailure = false;
const requests = [];
const context = vm.createContext({
  document: { getElementById: element },
  performance: { now: () => Date.now() },
  setInterval: () => 1, clearInterval: () => {}, alert: () => {}, console,
  fetch: async (url) => {
    requests.push(url);
    if (url.startsWith("/api/usage")) {
      if (usageFailure) throw new Error("usage offline");
      return { ok: true, json: async () => usage };
    }
    if (statusFailure) throw new Error("status offline");
    return { ok: true, json: async () => status };
  },
});

async function run() {
  vm.runInContext(fs.readFileSync(path.join(dashboard, "app.js"), "utf8"), context);
  await new Promise(setImmediate);
  assert.ok(requests.includes("/api/status"));
  assert.ok(requests.includes("/api/usage?period=day"));
  assert.match(element("usageMetrics").innerHTML, /\$1.25/);
  for (const label of ["Input tokens", "Output tokens", "Total tokens", "1 known / 0 unknown"]) {
    assert.ok(element("usageMetrics").innerHTML.includes(label));
  }
  assert.equal(element("pulseText").textContent, "Live Link: STABLE");

  for (const phase of ["paused", "waiting_limit", "circuit_break"]) {
    status.stateFile.STATUS = phase;
    await element("btnRefresh").listeners.click();
    assert.equal(element("loopState").textContent, phase.toUpperCase().replaceAll("_", " "));
    assert.ok(element("cardLoop").classList.contains("warn"));
    assert.equal(element("pulseText").textContent, "Live Link: ATTENTION");
  }
  status.parsed.loop.state = "stopped";
  for (const stalePhase of ["running", "paused"]) {
    status.stateFile.STATUS = stalePhase;
    await context.fetchStatus();
    assert.equal(element("loopState").textContent, "STOPPED");
    assert.equal(element("pulseText").textContent, "Live Link: ATTENTION");
  }
  status.parsed.loop.state = "running";
  status.stateFile.STATUS = "running";

  usage.summary.cost_usd = metric(null, "unavailable", 0, 2);
  usage.summary.usage.total_tokens = metric(100, "partial", 1, 1);
  usage.summary.latest_budget = budget("warning", [{
    level: "warning", metric: "total_tokens", actual: 100, limit: 80, coverage: "partial",
  }]);
  await context.fetchStatus();
  assert.match(element("usageMetrics").innerHTML, /Unknown/);
  assert.doesNotMatch(element("usageMetrics").innerHTML, /\$0/);
  assert.match(element("usageMetrics").innerHTML, /PARTIAL · 1 known \/ 1 unknown/);
  assert.match(element("usageAlerts").innerHTML, /Soft warning: Total tokens 100 \/ 80/);
  assert.match(element("usageRecordedBudget").textContent, /Last recorded budget: WARNING/);
  assert.match(element("usageCurrentPause").textContent, /inactive/);
  assert.equal(element("pulseText").textContent, "Live Link: ATTENTION");

  for (const [reason, expected] of [
    ["usage_hard_limit", /hard budget limit reached/],
    ["budget_unverifiable", /hard budget cannot be verified/],
    ["invalid_pause_marker", /unreadable/],
  ]) {
    usage.budgetPause = { reason };
    await context.fetchStatus();
    assert.match(element("usageCurrentPause").textContent, expected);
    assert.match(element("usageCurrentPause").textContent, /Manual resume required/);
    assert.notEqual(element("pulseText").textContent, "Live Link: STABLE");
  }
  usage.budgetPause = null;
  usage.summary.latest_budget = budget("unverifiable");
  await context.fetchStatus();
  assert.match(element("usageAlerts").innerHTML, /hard budget check could not be verified/);
  usage.summary.latest_budget = budget("hard_limit");
  await context.fetchStatus();
  assert.match(element("usageRecordedBudget").textContent, /HARD_LIMIT/);
  assert.equal(element("usageCurrentPause").textContent, "Current budget pause: inactive.");

  usage = { summary: { cycles: 0 }, budgetPause: null };
  await context.fetchStatus();
  assert.match(element("usageMetrics").innerHTML, /Unknown/);
  assert.doesNotMatch(element("usageMetrics").innerHTML, /\$0/);
  assert.notEqual(element("pulseText").textContent, "Live Link: STABLE");

  usageFailure = true;
  await context.fetchStatus();
  assert.match(element("usageWindow").textContent, /UNAVAILABLE/);
  assert.match(element("usageCurrentPause").textContent, /UNKNOWN/);
  assert.equal(element("pulseText").textContent, "Live Link: ATTENTION");
  usageFailure = false;
  usage = fullUsage();
  usage.summary.invalid_records = 1;
  await context.fetchStatus();
  assert.match(element("usageAlerts").innerHTML, /ledger records are invalid/);
  assert.notEqual(element("pulseText").textContent, "Live Link: STABLE");
  usage.summary.invalid_records = 0;
  element("usagePeriod").value = "week";
  await element("usagePeriod").listeners.change();
  assert.ok(requests.includes("/api/usage?period=week"));

  usage.summary.latest_budget = budget("warning", [{
    level: "warning", metric: "cost_usd", actual: 1.25, limit: 1, coverage: '<img src=x onerror="bad()">',
  }]);
  await context.fetchStatus();
  assert.doesNotMatch(element("usageAlerts").innerHTML, /<img/);
  assert.match(element("usageAlerts").innerHTML, /&lt;img/);
  statusFailure = true;
  await context.fetchStatus();
  assert.equal(element("pulseText").textContent, "Live Link: UNAVAILABLE");
  assert.equal(element("loopState").textContent, "UNAVAILABLE");
  console.log("PASS: real dashboard initial/manual/window refresh, usage coverage, budget warnings/pauses, waiting states, stale status, failures, and escaping");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
