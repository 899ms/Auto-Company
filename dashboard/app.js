const els = {
  deck: document.getElementById("deck"),
  pulseDot: document.getElementById("pulseDot"),
  pulseText: document.getElementById("pulseText"),
  lastUpdate: document.getElementById("lastUpdate"),
  latency: document.getElementById("latency"),

  guardianState: document.getElementById("guardianState"),
  guardianMeta: document.getElementById("guardianMeta"),
  daemonState: document.getElementById("daemonState"),
  daemonMeta: document.getElementById("daemonMeta"),
  loopState: document.getElementById("loopState"),
  loopMeta: document.getElementById("loopMeta"),
  autostartState: document.getElementById("autostartState"),
  autostartMeta: document.getElementById("autostartMeta"),

  cardGuardian: document.getElementById("cardGuardian"),
  cardDaemon: document.getElementById("cardDaemon"),
  cardLoop: document.getElementById("cardLoop"),
  cardAutostart: document.getElementById("cardAutostart"),
  cardUsage: document.getElementById("cardUsage"),
  usagePeriod: document.getElementById("usagePeriod"),
  usageWindow: document.getElementById("usageWindow"),
  usageMetrics: document.getElementById("usageMetrics"),
  usageRecordedBudget: document.getElementById("usageRecordedBudget"),
  usageCurrentPause: document.getElementById("usageCurrentPause"),
  usageAlerts: document.getElementById("usageAlerts"),

  stateList: document.getElementById("stateList"),
  consensusText: document.getElementById("consensusText"),
  logText: document.getElementById("logText"),
  rawText: document.getElementById("rawText"),

  btnRefresh: document.getElementById("btnRefresh"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnTail: document.getElementById("btnTail"),
  btnRaw: document.getElementById("btnRaw"),
  autoToggle: document.getElementById("autoToggle"),
  refreshInterval: document.getElementById("refreshInterval"),
  languageSelect: document.getElementById("languageSelect"),
  languageHint: document.getElementById("languageHint"),
  languageStatus: document.getElementById("languageStatus"),
};

const { t } = DashboardI18n;
let timer = null;
let rawVisible = false;
let refreshSequence = 0;
let lastStatus = null;
let lastUsage = null;
let statusError = null;
let usageError = null;
let lastElapsed = 0;
let languageState = null;
let languageError = null;
let languageSaving = false;
let languageSequence = 0;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return html;
}

function renderMarkdown(md) {
  const lines = String(md || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let inList = false;
  let inCode = false;
  let inParagraph = false;

  const closeParagraph = () => {
    if (inParagraph) {
      out.push("</p>");
      inParagraph = false;
    }
  };
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      closeParagraph();
      closeList();
      if (!inCode) {
        out.push("<pre><code>");
        inCode = true;
      } else {
        out.push("</code></pre>");
        inCode = false;
      }
      continue;
    }

    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }

    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeParagraph();
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(h[2].trim())}</h${level}>`);
      continue;
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      closeParagraph();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInlineMarkdown(li[1].trim())}</li>`);
      continue;
    }

    closeList();
    if (!inParagraph) {
      out.push("<p>");
      inParagraph = true;
    } else {
      out.push("<br />");
    }
    out.push(renderInlineMarkdown(line.trim()));
  }

  closeParagraph();
  closeList();
  if (inCode) {
    out.push("</code></pre>");
  }

  return out.join("");
}

const STATE_CLASS = Object.freeze({
  mismatched: "bad",
  active: "good",
  configured: "good",
  running: "good",
  idle: "good",
  paused: "warn",
  waiting_limit: "warn",
  circuit_break: "warn",
  activating: "warn",
  deactivating: "warn",
  inactive: "warn",
  not_configured: "warn",
  not_installed: "warn",
  reloading: "warn",
  stopped: "warn",
  unavailable: "warn",
  unsupported: "warn",
  failed: "bad",
  unknown: "bad",
});

function applyCardState(card, state) {
  card.classList.remove("good", "warn", "bad");
  card.classList.add(STATE_CLASS[state] || STATE_CLASS.unknown);
}

function formatTime(value, dateOnly = false) {
  if (!value) return "--";
  // Ledger dates represent calendar days, not UTC instants.
  const text = String(value).replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/, "$1T$2");
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00` : text);
  if (Number.isNaN(date.getTime())) return String(value);
  return dateOnly ? date.toLocaleDateString(DashboardI18n.locale) : date.toLocaleString(DashboardI18n.locale);
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString(DashboardI18n.locale) : String(value);
}

function stateLabel(value) {
  const state = String(value || "unknown");
  return t(`state.${state.toLowerCase().replaceAll(" ", "_")}`, {}, state);
}

function pauseReason(value) {
  return value ? t(`reason.${value}`, {}, value) : "-";
}

function daemonSummary(value) {
  const match = String(value || "unknown").match(/^(.*?)(?: \((.*)\))?$/);
  const enabled = match[1].match(/^ENABLED but (.+)$/);
  const state = enabled ? t("daemon.enabledInactive", { state: stateLabel(enabled[1]) }) : stateLabel(match[1]);
  const details = {
    ".auto-loop-paused present": "daemon.pauseMarker",
    "launchd is macOS-only": "daemon.macosOnly",
    "launchd is macOS-only; pause flag present": "daemon.macosPaused",
  };
  const detail = Object.hasOwn(details, match[2]) ? t(details[match[2]]) : match[2];
  return detail ? `${state} (${detail})` : state;
}

function renderStateList(parsed, stateFile) {
  const loop = parsed.loop || {};
  const daemon = parsed.daemon || {};
  const rows = [
    [t("field.engine"), loop.engine || "-"],
    [t("field.model"), loop.model || "-"],
    [t("field.loopCount"), formatNumber(loop.loopCount === "" ? stateFile.LOOP_COUNT : loop.loopCount ?? stateFile.LOOP_COUNT)],
    [t("field.errorCount"), formatNumber(loop.errorCount === "" ? stateFile.ERROR_COUNT : loop.errorCount ?? stateFile.ERROR_COUNT)],
    [t("field.lastRun"), formatTime(loop.lastRun || stateFile.LAST_RUN)],
    [t("field.pauseReason"), pauseReason(loop.pauseReason || stateFile.PAUSE_REASON)],
    [t("field.daemonSummary"), daemonSummary(loop.daemonSummary)],
    [t("field.activeState"), stateLabel(daemon.activeState)],
    [t("field.subState"), stateLabel(daemon.subState)],
  ];

  els.stateList.innerHTML = rows
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join("");
}

function effectiveLoopState(loop, stateFile) {
  const phases = ["running", "idle", "paused", "waiting_limit", "circuit_break"];
  if ((loop.processState || loop.state) === "running" && phases.includes(stateFile.STATUS)) {
    return stateFile.STATUS;
  }
  return loop.state || "unknown";
}

function usageValue(value, currency = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) return t("usage.unknown");
  return value.toLocaleString(DashboardI18n.locale, {
    ...(currency ? { style: "currency", currency: "USD" } : {}),
    minimumFractionDigits: currency ? 2 : 0, maximumFractionDigits: 6,
  });
}

function renderUsage(data) {
  const summary = data.summary || {};
  const metrics = [
    [t("usage.cost"), summary.cost_usd, true],
    [t("usage.input"), summary.usage?.input_tokens],
    [t("usage.output"), summary.usage?.output_tokens],
    [t("usage.total"), summary.usage?.total_tokens],
  ];
  els.usageWindow.textContent = t("usage.range", {
    period: t(`period.${summary.period || "unknown"}`, {}, summary.period),
    start: formatTime(summary.start_date, true), end: formatTime(summary.end_date, true),
    cycles: formatNumber(summary.cycles ?? 0), invalid: formatNumber(summary.invalid_records ?? 0),
  });
  els.usageMetrics.innerHTML = metrics.map(([label, metric, currency]) => {
    const coverage = metric || {};
    const value = usageValue(coverage.value, currency);
    const status = coverage.status || "unavailable";
    const description = t("usage.coverage", {
      status: stateLabel(status), known: formatNumber(coverage.known_cycles ?? 0),
      unknown: formatNumber(coverage.unknown_cycles ?? 0),
    });
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}<span class="coverage">${escapeHtml(description)}</span></dd></div>`;
  }).join("");

  const budget = typeof summary.latest_budget === "object" ? summary.latest_budget : null;
  const budgetState = typeof budget?.state === "string" ? budget.state : "unknown";
  const budgetWindow = budget ? t("budget.window", {
    period: t(`period.${budget.period || "unknown"}`, {}, budget.period),
    start: formatTime(budget.start_date, true), end: formatTime(budget.end_date, true),
  }) : "";
  els.usageRecordedBudget.textContent = t("budget.recorded", { state: stateLabel(budgetState), window: budgetWindow });
  const pause = data.budgetPause;
  els.usageCurrentPause.textContent = pause
    ? t("budget.pause.active", { reason: pause.reason ? pauseReason(pause.reason) : t("budget.review") })
    : t("budget.pause.inactive");
  const recordedAlerts = Array.isArray(budget?.alerts) ? budget.alerts : [];
  const alerts = recordedAlerts.filter((alert) => alert && typeof alert === "object").map((alert) => {
    const label = t(alert.level === "warning" ? "budget.soft" : "budget.hard");
    const currency = alert.metric === "cost_usd";
    return t("budget.alert", {
      level: label, metric: t(currency ? "usage.cost" : "usage.total"),
      actual: usageValue(alert.actual, currency), limit: usageValue(alert.limit, currency),
      coverage: stateLabel(alert.coverage),
    });
  });
  if (budgetState === "unverifiable") alerts.push(t("budget.unverifiable"));
  if (summary.invalid_records) alerts.push(t("budget.invalid"));
  els.usageAlerts.innerHTML = alerts.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
  const healthy = summary.cycles > 0 && !summary.invalid_records && !pause
    && metrics.every(([, metric]) => metric?.status === "complete")
    && ["ok", "disabled"].includes(budgetState);
  applyCardState(els.cardUsage, healthy ? "active" : "paused");
  return healthy;
}

function renderUsageUnavailable(error) {
  renderUsage({});
  els.usageWindow.textContent = t("usage.unavailable", { error: errorText(error) });
  els.usageCurrentPause.textContent = t("budget.pause.unknown");
  applyCardState(els.cardUsage, "unavailable");
}

async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store", ...options });
  } catch (error) {
    throw { messageKey: "error.network", detail: error.message || String(error) };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw { messageKey: "error.response" };
  }
  if (!response.ok) throw { messageKey: "error.request", status: response.status, detail: payload.error };
  return payload;
}

function errorText(error) {
  const message = t(error.messageKey || "error.network", { status: error.status ?? "--" });
  const detail = error.detail || error.message;
  return detail ? `${message}: ${detail}` : message;
}

function renderLanguage() {
  const language = languageState?.nextLanguage || languageState?.language || "en";
  els.languageSelect.value = language;
  els.languageSelect.disabled = languageSaving;
  els.languageHint.textContent = languageState?.locked
    ? t("language.locked", {
      current: languageState.language === "zh-CN" ? "中文" : "English",
      next: language === "zh-CN" ? "中文" : "English",
    }) : t("language.hint");
  els.languageStatus.textContent = languageSaving ? t("language.saving")
    : languageError ? t(languageError) : languageState?.pending ? t("language.pending") : "";
}

function applyLanguageState(state) {
  if (!state || !["en", "zh-CN"].includes(state.language)
      || (state.nextLanguage && !["en", "zh-CN"].includes(state.nextLanguage))) {
    throw new Error("Invalid language response");
  }
  languageState = state;
  languageError = null;
  DashboardI18n.setLanguage(state.language);
  DashboardI18n.apply();
  renderDashboard();
}

async function refreshLanguage() {
  if (languageSaving) return;
  const sequence = ++languageSequence;
  try {
    const state = await fetchJson("/api/language", { signal: AbortSignal.timeout(5000) });
    if (sequence === languageSequence) applyLanguageState(state);
  } catch {
    if (sequence !== languageSequence) return;
    languageError = "language.unavailable";
    DashboardI18n.apply();
    renderDashboard();
  }
}

async function saveLanguage() {
  const language = els.languageSelect.value;
  languageSaving = true;
  ++languageSequence;
  renderLanguage();
  try {
    const response = await fetch("/api/language", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language }), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      languageError = data.errorCode === "language_invalid" ? "language.invalid" : "language.saveFailed";
    } else {
      applyLanguageState(data);
    }
  } catch {
    languageError = "language.saveFailed";
  } finally {
    languageSaving = false;
    renderLanguage();
  }
}

async function fetchStatus(includeLanguage = true) {
  const sequence = ++refreshSequence;
  const started = performance.now();
  const [statusResult, usageResult] = await Promise.allSettled([
    fetchJson("/api/status"),
    fetchJson(`/api/usage?period=${encodeURIComponent(els.usagePeriod.value)}`),
    includeLanguage ? refreshLanguage() : Promise.resolve(),
  ]);
  if (sequence !== refreshSequence) return;
  usageError = usageResult.status === "rejected" ? usageResult.reason : null;
  statusError = statusResult.status === "rejected" ? statusResult.reason : null;
  if (!usageError) lastUsage = usageResult.value;
  if (!statusError) {
    lastStatus = statusResult.value;
    lastElapsed = Math.round(performance.now() - started);
  }
  renderDashboard();
}

function renderStatus(data, usageHealthy) {
  const parsed = data.parsed || {};
  const guardian = parsed.guardian || {};
  const daemon = parsed.daemon || {};
  const loop = parsed.loop || {};
  const autostart = parsed.autostart || {};
  const loopState = effectiveLoopState(loop, data.stateFile || {});

  els.guardianState.textContent = stateLabel(guardian.state);
  els.guardianMeta.textContent = guardian.pid ? `PID ${guardian.pid}` : "PID --";
  applyCardState(els.cardGuardian, guardian.state);

  els.daemonState.textContent = stateLabel(daemon.state);
  els.daemonMeta.textContent = ["mismatched", "not_installed", "unavailable"].includes(daemon.state)
    ? t(`daemon.${daemon.state}`) : (daemon.mainPid ? `MainPID ${daemon.mainPid}` : "MainPID --");
  applyCardState(els.cardDaemon, daemon.state);

  els.loopState.textContent = stateLabel(loopState);
  const loopCycle = t("cycle", { value: formatNumber(loop.loopCount) });
  const loopPid = loop.pid ? `PID ${loop.pid}` : "PID --";
  els.loopMeta.textContent = `${loopCycle} | ${loopPid}`;
  applyCardState(els.cardLoop, loopState);

  els.autostartState.textContent = stateLabel(autostart.state);
  els.autostartMeta.textContent = stateLabel(autostart.enabledState || autostart.state);
  applyCardState(els.cardAutostart, autostart.state);

  renderStateList(parsed, data.stateFile || {});

  const consensusRaw = (data.consensusHead || parsed.consensusPreview || "").trim();
  els.consensusText.innerHTML = renderMarkdown(!consensusRaw || consensusRaw === "(no consensus file)"
    ? t("empty.consensus") : consensusRaw);
  const logRaw = (data.logTail || parsed.recentLog || "").trim();
  els.logText.textContent = !logRaw || logRaw === "(no log file)" ? t("empty.logs") : logRaw;
  els.rawText.textContent = data.raw || "";

  const healthy = data.ok && ["running", "idle"].includes(loopState) && daemon.state === "active" && usageHealthy;
  els.pulseText.textContent = t(healthy ? "live.stable" : "live.attention");
  els.pulseDot.style.background = healthy ? "var(--good)" : "var(--warn)";

  els.lastUpdate.textContent = t("lastUpdate", { time: formatTime(data.timestamp) });
  els.latency.textContent = t("latency", { value: formatNumber(lastElapsed) });
}

function renderButtons() {
  els.btnStart.textContent = t(els.btnStart.disabled ? "button.starting" : "button.start");
  els.btnStop.textContent = t(els.btnStop.disabled ? "button.stopping" : "button.stop");
  els.btnRaw.textContent = t(rawVisible ? "button.hideRaw" : "button.showRaw");
  els.btnRaw.setAttribute("aria-expanded", String(rawVisible));
}

function renderDashboard() {
  let usageHealthy = false;
  if (usageError) renderUsageUnavailable(usageError);
  else if (lastUsage) usageHealthy = renderUsage(lastUsage);
  if (lastStatus) renderStatus(lastStatus, usageHealthy);
  if (statusError) {
    els.pulseText.textContent = t("live.unavailable");
    els.pulseDot.style.background = "var(--warn)";
    els.loopState.textContent = stateLabel("unavailable");
    applyCardState(els.cardLoop, "unavailable");
    els.rawText.textContent = errorText(statusError);
  }
  renderButtons();
  renderLanguage();
}

async function runAction(action) {
  const btn = action === "start" ? els.btnStart : els.btnStop;
  btn.disabled = true;
  renderButtons();
  try {
    const res = await fetch(`/api/action/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.output || data.error || "");
    }
    await fetchStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const label = t("error.action", { action: t(`button.${action}`) });
    alert(msg ? `${label}\n${msg}` : label);
  } finally {
    btn.disabled = false;
    renderButtons();
  }
}

function resetAutoTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (els.autoToggle.checked) {
    timer = setInterval(() => {
      fetchStatus().catch(() => {});
    }, Number(els.refreshInterval.value));
  }
}

els.btnRefresh.addEventListener("click", () => fetchStatus().catch(() => {}));
els.btnStart.addEventListener("click", () => runAction("start"));
els.btnStop.addEventListener("click", () => runAction("stop"));
els.btnTail.addEventListener("click", () => fetchStatus().catch(() => {}));
els.btnRaw.addEventListener("click", () => {
  rawVisible = !rawVisible;
  els.rawText.classList.toggle("hidden", !rawVisible);
  renderButtons();
});
els.autoToggle.addEventListener("change", resetAutoTimer);
els.refreshInterval.addEventListener("change", resetAutoTimer);
els.usagePeriod.addEventListener("change", () => fetchStatus().catch(() => {}));
els.languageSelect.addEventListener("change", saveLanguage);

async function bootstrap() {
  await refreshLanguage();
  els.deck.hidden = false;
  resetAutoTimer();
  await fetchStatus(false);
}

bootstrap();
