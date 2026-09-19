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
  vm.runInContext(app.slice(0, binding) + "\n globalThis.journal = { state, message, aggregate, duration, cycleTitle, statusLabel, formatTime, filterUsage, reportRows, liveDuration, checkCounts, checkPresentation, progressState, latestCycle, unavailableArtifact, mediaURL, mediaRetryError, iconPublicationWarning };\n})();", context);
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

test("media links must belong to the exact managed product", () => {
  const { mediaURL } = helpers();
  const id = 'a'.repeat(32);
  const url = `/api/product-media/${id}/${'b'.repeat(64)}.png`;
  assert.equal(mediaURL(url, id), url);
  for (const value of [url.replace(id, 'c'.repeat(32)), 'https://example.com/image.png', 'javascript:alert(1)', `/api/product-media/${id}/../private.svg`, `${url}?path=private`]) assert.equal(mediaURL(value, id), null);
});

test("unconfirmed starts never become completed cycles", () => {
  const { cycleTitle, progressState, messages } = helpers();
  assert.equal(cycleTitle({status: 'startup_unconfirmed'}), messages.en.startup_unconfirmed);
  assert.equal(progressState('startup_unconfirmed'), 'unknown');
  assert.equal(progressState('not_started'), 'pending');
});

test("media retry errors expire after a new success or product change", () => {
  const { state, mediaRetryError } = helpers();
  state.mediaError = {productId: 'a', previousSuccess: 'old'};
  assert.equal(mediaRetryError({productId: 'a', screenshot: {state: 'failed'}}), true);
  assert.equal(mediaRetryError({productId: 'a', screenshot: {state: 'success', latestSuccess: {capturedAt: 'new'}}}), false);
  assert.equal(state.mediaError, null);
  state.mediaError = {productId: 'a', previousSuccess: null};
  assert.equal(mediaRetryError({productId: 'b', screenshot: {state: 'failed'}}), false);
});

test("canonical icon publication failures stay visible independently of source", () => {
  const { iconPublicationWarning } = helpers();
  assert.equal(iconPublicationWarning({source: 'default', publicationStatus: 'published'}), null);
  assert.equal(iconPublicationWarning({source: 'product', publicationStatus: 'existing_valid'}), null);
  assert.equal(iconPublicationWarning({source: 'product', publicationStatus: 'conflict'}), 'iconPublicationConflict');
  assert.equal(iconPublicationWarning({source: 'default', publicationStatus: 'failed'}), 'iconPublicationFailed');
  for (const publicationStatus of ['stale', 'unavailable']) assert.equal(iconPublicationWarning({source: 'product', publicationStatus}), 'iconPublicationChanged');
  assert.equal(iconPublicationWarning({reference: {state: 'preserved'}}), 'iconReferencePreserved');
  for (const state of ['missing', 'unsupported', 'unconfirmed', 'conflict', 'failed']) assert.equal(iconPublicationWarning({reference: {state}}), 'iconReferenceUnconfirmed');
  for (const state of ['inserted', 'linked', 'not_applicable']) assert.equal(iconPublicationWarning({reference: {state}}), null);
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

test("structured task titles preserve meaning while interruption remains a runtime fact", () => {
  const { cycleTitle, statusLabel, messages } = helpers();
  const cycle = { status: "interrupted", events: [{}], summary: "Unrelated legacy sentence",
    workReport: { title: "修复重复键匹配，补齐验证" } };
  assert.equal(cycleTitle(cycle), "修复重复键匹配，补齐验证");
  assert.equal(statusLabel(cycle.status), messages.en.interrupted);
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


test("live elapsed time advances only with fresh verified runtime identity", () => {
  const { state, liveDuration } = helpers();
  state.statusFailed = false;
  state.receivedAt = 1000;
  state.data = { runtime: { processState: "running", elapsedReliable: true, elapsedSeconds: 60 } };
  const cycle = { active: true, status: "running" };
  assert.equal(liveDuration(cycle, 4000), "Running for 1m 3s");
  assert.equal(liveDuration(cycle, 17000), "Elapsed time unconfirmed");
  assert.equal(liveDuration(cycle, 999), "Elapsed time unconfirmed");
  state.action = "stop";
  assert.equal(liveDuration(cycle, 4000), "Elapsed time unconfirmed");
  state.action = "";
  state.statusFailed = true;
  assert.equal(liveDuration(cycle, 4000), "Elapsed time unconfirmed");
  state.statusFailed = false;
  state.data.runtime.elapsedReliable = false;
  assert.equal(liveDuration(cycle, 4000), "Elapsed time unconfirmed");
});

test("check pass counts require a complete internally consistent machine summary", () => {
  const { checkCounts } = helpers();
  assert.equal(checkCounts({ tests: 12, failures: 2, errors: 1, skipped: 3 }).passed, 6);
  assert.equal(checkCounts({ tests: 0, failures: 0, errors: 0, skipped: 0 }).passed, 0);
  assert.equal(checkCounts({ tests: 12, failures: 0 }).passed, undefined);
  assert.equal(checkCounts({ tests: 1, failures: 2, errors: 0, skipped: 0 }).passed, undefined);
  assert.equal(checkCounts(null).passed, undefined);
});


test("project selection never promotes unrelated or unknown history into current work", () => {
  const { latestCycle } = helpers();
  const old = { id: "old", projectStatus: "other", active: false };
  const unknown = { id: "unknown", projectStatus: "unknown", active: false };
  const current = { id: "current", projectStatus: "current", active: false };
  const project = { id: "projects/current" };
  assert.equal(latestCycle({ project, cycles: [old, unknown], latestProjectCycleId: null }), undefined);
  assert.equal(latestCycle({ project, cycles: [old, unknown, current], latestProjectCycleId: "current" }), current);
  assert.equal(latestCycle({ project: { id: null }, cycles: [unknown], latestProjectCycleId: null }), unknown);
  assert.equal(latestCycle({ cycles: [old] }), old);
});


test("compact checks never promote stale, incomplete or failed evidence to success", () => {
  const { checkPresentation } = helpers();
  const check = { state: "completed", evidenceStatus: "completed", exitCode: 0, tests: { tests: 7, failures: 0, errors: 0, skipped: 0 } };
  const show = (changes) => checkPresentation({ latestCheck: { ...check, ...changes } });
  assert.equal(show({}).status, "completed");
  assert.equal(show({}).detail, "7 passed");
  for (const changes of [{ evidenceStatus: "missing" }, { freshness: "stale" }, { tests: null }, { exitCode: null }, { evidenceStatus: "unknown" }]) {
    assert.equal(show(changes).status, "unknown");
  }
  assert.equal(show({ exitCode: 1 }).status, "failed");
  assert.match(show({ exitCode: 1 }).detail, /failed/i);
  assert.equal(show({ tests: { tests: 7, failures: 1, errors: 0, skipped: 0 } }).status, "failed");
  assert.equal(show({ state: "interrupted" }).status, "interrupted");
  assert.equal(show({ tests: { tests: 7, failures: 0, errors: 0, skipped: 7 } }).status, "unknown");
  assert.equal(checkPresentation({}).status, "unknown");
});

test("cycle progress distinguishes execution completion, pauses and unknown states", () => {
  const { progressState } = helpers();
  assert.equal(progressState("completed"), "completed");
  assert.equal(progressState("running"), "running");
  assert.equal(progressState("pending"), "pending");
  for (const status of ["interrupted", "paused", "completed_with_timeout", "waiting_limit"]) assert.equal(progressState(status), "paused");
  assert.equal(progressState("failed"), "failed");
  assert.equal(progressState("unexpected"), "unknown");
  assert.equal(progressState(undefined), "unknown");
});

test("unavailable previews use lifecycle labels while documents keep file evidence labels", () => {
  const { state, unavailableArtifact, messages } = helpers();
  for (const language of ["en", "zh-CN"]) {
    state.language = language;
    for (const [status, label] of [["stopped", "previewEnded"], ["interrupted", "previewInterrupted"], ["running", "previewUnavailable"], ["launch_failed", "previewUnavailable"]]) {
      assert.equal(unavailableArtifact({ kind: "preview", state: status, evidenceStatus: "stale" }), messages[language][label]);
    }
    assert.equal(unavailableArtifact({ kind: "document", evidenceStatus: "stale" }), messages[language].artifactStale);
  }
});
