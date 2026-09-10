const els = {
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
};

let timer = null;
let rawVisible = false;
let refreshSequence = 0;

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

function formatTime(isoText) {
  try {
    return new Date(isoText).toLocaleString();
  } catch {
    return isoText;
  }
}

function renderStateList(parsed, stateFile) {
  const rows = [
    ["Engine", parsed.loop.engine || "-"],
    ["Model", parsed.loop.model || "-"],
    ["Loop Count", parsed.loop.loopCount || stateFile.LOOP_COUNT || "-"],
    ["Error Count", parsed.loop.errorCount || stateFile.ERROR_COUNT || "-"],
    ["Last Run", parsed.loop.lastRun || stateFile.LAST_RUN || "-"],
    ["Pause Reason", parsed.loop.pauseReason || stateFile.PAUSE_REASON || "-"],
    ["Loop Daemon Summary", parsed.loop.daemonSummary || "-"],
    ["Daemon ActiveState", parsed.daemon.activeState || "-"],
    ["Daemon SubState", parsed.daemon.subState || "-"],
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
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unknown";
  return (currency ? "$" : "") + value.toLocaleString("en-US", {
    minimumFractionDigits: currency ? 2 : 0, maximumFractionDigits: 6,
  });
}

function renderUsage(data) {
  const summary = data.summary || {};
  const metrics = [
    ["Cost USD", summary.cost_usd, true],
    ["Input tokens", summary.usage?.input_tokens],
    ["Output tokens", summary.usage?.output_tokens],
    ["Total tokens", summary.usage?.total_tokens],
  ];
  els.usageWindow.textContent = `${summary.period || "unknown"}: ${summary.start_date || "--"} to ${summary.end_date || "--"} | ${summary.cycles ?? 0} cycles | ${summary.invalid_records ?? 0} invalid records`;
  els.usageMetrics.innerHTML = metrics.map(([label, metric, currency]) => {
    const coverage = metric || {};
    const value = usageValue(coverage.value, currency);
    const status = coverage.status || "unavailable";
    return `<div><dt>${label}</dt><dd>${escapeHtml(value)}<span class="coverage">${escapeHtml(status.toUpperCase())} · ${coverage.known_cycles ?? 0} known / ${coverage.unknown_cycles ?? 0} unknown cycles</span></dd></div>`;
  }).join("");

  const budget = typeof summary.latest_budget === "object" ? summary.latest_budget : null;
  const budgetState = typeof budget?.state === "string" ? budget.state : "unknown";
  const budgetWindow = budget ? ` (${budget.period}: ${budget.start_date} to ${budget.end_date})` : "";
  els.usageRecordedBudget.textContent = `Last recorded budget: ${budgetState.toUpperCase()}${budgetWindow}. Current service configuration is not inferred.`;
  const pause = data.budgetPause;
  const pauseLabels = {
    usage_hard_limit: "hard budget limit reached",
    budget_unverifiable: "hard budget cannot be verified because usage is incomplete",
    invalid_pause_marker: "pause marker is unreadable; review required",
  };
  els.usageCurrentPause.textContent = pause
    ? `Current budget pause: PAUSED — ${pauseLabels[pause.reason] || pause.reason || "review required"}. Manual resume required.`
    : "Current budget pause: inactive.";
  const recordedAlerts = Array.isArray(budget?.alerts) ? budget.alerts : [];
  const alerts = recordedAlerts.filter((alert) => alert && typeof alert === "object").map((alert) => {
    const label = alert.level === "warning" ? "Soft warning" : "Hard limit";
    const currency = alert.metric === "cost_usd";
    const metric = currency ? "Cost USD" : "Total tokens";
    return `${label}: ${metric} ${usageValue(alert.actual, currency)} / ${usageValue(alert.limit, currency)} (${alert.coverage || "unknown"} coverage).`;
  });
  if (budgetState === "unverifiable") alerts.push("Last recorded hard budget check could not be verified; usage is incomplete.");
  if (summary.invalid_records) alerts.push("Some ledger records are invalid; totals may be incomplete.");
  els.usageAlerts.innerHTML = alerts.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
  const healthy = summary.cycles > 0 && !summary.invalid_records && !pause
    && metrics.every(([, metric]) => metric?.status === "complete")
    && ["ok", "disabled"].includes(budgetState);
  applyCardState(els.cardUsage, healthy ? "active" : "paused");
  return healthy;
}

function renderUsageUnavailable(error) {
  renderUsage({});
  els.usageWindow.textContent = `Usage: UNAVAILABLE — ${error.message || error}`;
  els.usageCurrentPause.textContent = "Current budget pause: UNKNOWN (usage request failed).";
  applyCardState(els.cardUsage, "unavailable");
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function fetchStatus() {
  const sequence = ++refreshSequence;
  const started = performance.now();
  const [statusResult, usageResult] = await Promise.allSettled([
    fetchJson("/api/status"),
    fetchJson(`/api/usage?period=${encodeURIComponent(els.usagePeriod.value)}`),
  ]);
  if (sequence !== refreshSequence) return;
  let usageHealthy = false;
  if (usageResult.status === "fulfilled") usageHealthy = renderUsage(usageResult.value);
  else renderUsageUnavailable(usageResult.reason);
  if (statusResult.status === "rejected") {
    els.pulseText.textContent = "Live Link: UNAVAILABLE";
    els.pulseDot.style.background = "var(--warn)";
    els.loopState.textContent = "UNAVAILABLE";
    applyCardState(els.cardLoop, "unavailable");
    els.rawText.textContent = statusResult.reason.message || String(statusResult.reason);
    return;
  }
  const data = statusResult.value;
  const elapsed = Math.round(performance.now() - started);

  const parsed = data.parsed || {};
  const guardian = parsed.guardian || {};
  const daemon = parsed.daemon || {};
  const loop = parsed.loop || {};
  const autostart = parsed.autostart || {};
  const loopState = effectiveLoopState(loop, data.stateFile || {});

  els.guardianState.textContent = (guardian.state || "unknown").toUpperCase();
  els.guardianMeta.textContent = guardian.pid ? `PID ${guardian.pid}` : "PID --";
  applyCardState(els.cardGuardian, guardian.state);

  els.daemonState.textContent = (daemon.state || "unknown").toUpperCase();
  els.daemonMeta.textContent = ["mismatched", "not_installed", "unavailable"].includes(daemon.state)
    ? daemon.raw : (daemon.mainPid ? `MainPID ${daemon.mainPid}` : "MainPID --");
  applyCardState(els.cardDaemon, daemon.state);

  els.loopState.textContent = loopState.toUpperCase().replaceAll("_", " ");
  const loopCycle = loop.loopCount ? `Cycle ${loop.loopCount}` : "Cycle --";
  const loopPid = loop.pid ? `PID ${loop.pid}` : "PID --";
  els.loopMeta.textContent = `${loopCycle} | ${loopPid}`;
  applyCardState(els.cardLoop, loopState);

  els.autostartState.textContent = (autostart.state || "unknown").toUpperCase();
  els.autostartMeta.textContent = autostart.raw || "Autostart";
  applyCardState(els.cardAutostart, autostart.state);

  renderStateList(parsed, data.stateFile || {});

  const consensusRaw = (data.consensusHead || parsed.consensusPreview || "(no consensus)").trim();
  els.consensusText.innerHTML = renderMarkdown(consensusRaw);
  els.logText.textContent = (data.logTail || parsed.recentLog || "(no logs yet)").trim();
  els.rawText.textContent = data.raw || "";

  const healthy = data.ok && ["running", "idle"].includes(loopState) && daemon.state === "active" && usageHealthy;
  els.pulseText.textContent = healthy ? "Live Link: STABLE" : "Live Link: ATTENTION";
  els.pulseDot.style.background = healthy ? "var(--good)" : "var(--warn)";

  els.lastUpdate.textContent = `Last update: ${formatTime(data.timestamp)}`;
  els.latency.textContent = `Roundtrip: ${elapsed}ms`;
}

async function runAction(action) {
  const btn = action === "start" ? els.btnStart : els.btnStop;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = `${label}...`;
  try {
    const res = await fetch(`/api/action/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.output || `Action ${action} failed`);
    }
    await fetchStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    alert(msg);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
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
});
els.autoToggle.addEventListener("change", resetAutoTimer);
els.refreshInterval.addEventListener("change", resetAutoTimer);
els.usagePeriod.addEventListener("change", () => fetchStatus().catch(() => {}));

fetchStatus().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  els.rawText.textContent = msg;
});
resetAutoTimer();
