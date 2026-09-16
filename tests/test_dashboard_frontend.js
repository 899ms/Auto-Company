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
    dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
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
const translatedElements = [...html.matchAll(/<[^>]+data-i18n="([^"]+)"[^>]*>/g)].map(([tag, key]) => {
  const id = tag.match(/id="([^"]+)"/)?.[1];
  const node = id ? element(id) : { textContent: "", dataset: {} };
  node.dataset.i18n = key;
  return node;
});
const document = {
  getElementById: element, documentElement: { lang: "en" }, title: "",
  querySelectorAll: () => translatedElements,
};
const savedSettings = new Map();
const localStorage = {
  getItem: (key) => savedSettings.get(key) || null,
  setItem: (key, value) => savedSettings.set(key, value),
};
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
const actionRequests = [];
const alerts = [];
let actionResponse = { ok: true, json: async () => ({ ok: true }) };
const context = vm.createContext({
  document, localStorage, navigator: { languages: ["en-US"] },
  performance: { now: () => Date.now() },
  setInterval: () => 1, clearInterval: () => {}, alert: (message) => alerts.push(message), console,
  fetch: async (url, options) => {
    requests.push(url);
    if (url.startsWith("/api/action/")) {
      actionRequests.push({ url, options });
      return actionResponse;
    }
    if (url.startsWith("/api/usage")) {
      if (usageFailure) throw new Error("usage offline");
      return { ok: true, json: async () => usage };
    }
    if (statusFailure) throw new Error("status offline");
    return { ok: true, json: async () => status };
  },
});

async function run() {
  const i18nSource = fs.readFileSync(path.join(dashboard, "i18n.js"), "utf8");
  for (const [stored, languages, expected] of [
    [null, ["zh-CN", "en-US"], "zh"], ["en", ["zh-TW"], "en"],
    ["zh", ["en-GB"], "zh"], ["invalid", ["fr-FR", "zh-HK"], "zh"],
    [null, ["fr-FR"], "en"], ["__proto__", ["en-US"], "en"],
  ]) {
    const selection = vm.createContext({
      navigator: { languages }, localStorage: { getItem: () => stored, setItem: () => {} },
    });
    vm.runInContext(i18nSource, selection);
    assert.equal(vm.runInContext("DashboardI18n.language", selection), expected);
  }
  const blockedStorage = vm.createContext({
    navigator: { language: "zh-CN" }, localStorage: {
      getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); },
    },
  });
  vm.runInContext(i18nSource, blockedStorage);
  assert.equal(vm.runInContext("DashboardI18n.language", blockedStorage), "zh");
  vm.runInContext("DashboardI18n.setLanguage('en')", blockedStorage);
  assert.equal(vm.runInContext("DashboardI18n.t('page.heading')", blockedStorage), "Control Deck");

  vm.runInContext(i18nSource, context);
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
  assert.match(element("usageRecordedBudget").textContent, /HARD LIMIT/);
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

  // A language switch renders cached data immediately, even when the service is offline.
  const switchLanguage = (language) => {
    element("languageSelect").value = language;
    element("languageSelect").listeners.change();
  };
  const offlineRequests = requests.length;
  switchLanguage("zh");
  assert.equal(requests.length, offlineRequests);
  assert.equal(document.documentElement.lang, "zh-CN");
  assert.equal(document.title, "Auto Company 控制台");
  assert.equal(element("btnStart").textContent, "启动");
  assert.equal(element("usageHeading").textContent, "用量与预算");
  assert.equal(element("pulseText").textContent, "实时连接：不可用");
  assert.equal(element("loopState").textContent, "不可用");
  assert.match(element("rawText").textContent, /无法连接到控制台服务: status offline/);
  assert.equal(savedSettings.get("auto-company.dashboard.language"), "zh");
  assert.equal(savedSettings.size, 1);
  assert.ok(translatedElements.every((node) => node.textContent !== node.dataset.i18n));

  statusFailure = false;
  status.logTail = "Actual log: RUNNING 中文日志";
  status.consensusHead = "# Keep original consensus\n原始共识";
  status.raw = "State=running\nMODEL=model-x\nRaw=/original/path";
  status.parsed.loop.engine = "codex";
  status.parsed.loop.model = "model-x";
  status.parsed.loop.loopCount = "1234";
  status.parsed.loop.errorCount = 0;
  status.parsed.loop.pauseReason = "language_invalid";
  status.parsed.daemon.activeState = "active";
  usage = fullUsage();
  usage.budgetPause = { reason: "budget_unverifiable" };
  usage.summary.usage.total_tokens = metric(null, "unavailable");
  await context.fetchStatus();
  assert.match(element("stateList").innerHTML, /引擎<\/dt><dd>codex/);
  assert.match(element("stateList").innerHTML, /model-x/);
  assert.match(element("stateList").innerHTML, /运行轮数<\/dt><dd>1,234/);
  assert.match(element("stateList").innerHTML, /错误次数<\/dt><dd>0/);
  assert.match(element("stateList").innerHTML, /输出语言配置无效/);
  assert.match(element("usageCurrentPause").textContent, /用量数据不完整，无法核实硬预算/);
  assert.match(element("usageMetrics").innerHTML, /未知/);
  assert.match(element("usageWindow").textContent, /2026\/9\/9 至 2026\/9\/9/);
  assert.match(element("lastUpdate").textContent, /^最近更新：/);
  assert.equal(element("loopState").textContent, "运行中");
  const renderedConsensus = element("consensusText").innerHTML;
  const beforeSwitch = requests.length;
  switchLanguage("en");
  assert.equal(element("logText").textContent, status.logTail);
  assert.equal(element("rawText").textContent, status.raw);
  assert.equal(element("consensusText").innerHTML, renderedConsensus);
  assert.equal(status.parsed.loop.pauseReason, "language_invalid");
  assert.equal(requests.length, beforeSwitch);
  assert.match(element("usageWindow").textContent, /9\/9\/2026 to 9\/9\/2026/);
  assert.equal(context.formatTime("not a date"), "not a date");
  assert.equal(context.formatTime("2026-09-09", true), "9/9/2026");
  assert.equal(context.stateLabel("future_state"), "future_state");

  element("btnRaw").listeners.click();
  switchLanguage("zh");
  assert.equal(element("btnRaw").textContent, "收起");
  assert.equal(element("btnRaw").attributes["aria-expanded"], "true");
  assert.equal(element("rawText").classList.contains("hidden"), false);
  element("btnRaw").listeners.click();
  assert.equal(element("btnRaw").textContent, "展开");

  // Start/stop requests keep the same protocol, and in-flight labels follow the current locale.
  let finishAction;
  actionResponse = new Promise((resolve) => { finishAction = resolve; });
  const pendingAction = element("btnStart").listeners.click();
  assert.equal(element("btnStart").disabled, true);
  assert.equal(element("btnStart").textContent, "正在启动…");
  switchLanguage("en");
  assert.equal(element("btnStart").textContent, "Starting...");
  finishAction({ ok: true, json: async () => ({ ok: true }) });
  await pendingAction;
  assert.equal(element("btnStart").disabled, false);
  assert.equal(element("btnStart").textContent, "Start");
  assert.equal(actionRequests[0].url, "/api/action/start");
  assert.equal(actionRequests[0].options.method, "POST");
  assert.equal(actionRequests[0].options.body, "{}");
  switchLanguage("zh");
  actionResponse = { ok: false, json: async () => ({ ok: false, output: "service failure /keep/path" }) };
  await element("btnStop").listeners.click();
  assert.equal(alerts.at(-1), "停止失败\nservice failure /keep/path");
  assert.equal(element("btnStop").textContent, "停止");
  usageFailure = true;
  await context.fetchStatus();
  assert.match(element("usageWindow").textContent, /用量：不可用 — 无法连接到控制台服务/);
  assert.equal(element("usageCurrentPause").textContent, "当前预算暂停状态：未知（用量请求失败）。");
  status.consensusHead = "";
  status.parsed.consensusPreview = "(no consensus file)";
  status.logTail = "";
  status.parsed.recentLog = "(no log file)";
  status.parsed.loop.daemonSummary = "ACTIVE (systemd --user auto-company.service)";
  await context.fetchStatus();
  assert.equal(element("logText").textContent, "（暂无日志）");
  assert.equal(element("consensusText").innerHTML, "<p>（暂无共识）</p>");
  assert.match(element("stateList").innerHTML, /已激活 \(systemd --user auto-company.service\)/);
  switchLanguage("en");
  assert.match(element("usageWindow").textContent, /Usage: UNAVAILABLE/);
  console.log("PASS: dashboard refresh, usage, budget, states, errors, escaping, locale negotiation/storage, live switching, formatting, preserved content, and in-flight actions");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
