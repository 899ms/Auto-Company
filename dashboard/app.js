(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = { data: null, language: 'zh-CN', tab: 'work', expanded: new Set(), older: false, selectedLog: 'runtime', logText: '', logLoadedId: '', logRequest: 0, logPending: null, refreshPending: null, signature: '', statusFailed: true, action: '', languageState: null, languageSaving: false, languageLoading: false, languageRevision: 0, languageError: '', languageSaved: false, timer: null, autoChanged: false, currentCycle: null };
  const message = (key, values = {}) => {
    const dictionary = window.JOURNAL_MESSAGES[state.language] || window.JOURNAL_MESSAGES.en;
    return Object.entries(values).reduce((result, [name, value]) => result.replaceAll(`{${name}}`, String(value)), dictionary[key] || key);
  };
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function clear(node) { node.replaceChildren(); return node; }
  function clean(value) {
    return String(value || '').replace(/!?\[([^\[\]\r\n]*)\]\([^()\r\n]*\)/g, '$1').replace(/^\s*#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '').replace(/^\s*[-*]\s+/gm, '').trim();
  }
  function shortText(value, length = 86) {
    const text = clean(value).replace(/\s+/g, ' ');
    return text.length > length ? `${text.slice(0, length).trim()}…` : text;
  }
  function statusLabel(status) {
    return ['stopping', 'stop_failed', 'completed', 'completed_with_timeout', 'failed', 'interrupted', 'stopped_status', 'running', 'idle', 'paused', 'waiting_limit', 'circuit_break', 'stopped', 'active', 'inactive', 'configured', 'not_configured', 'not_installed', 'mismatched', 'activating', 'deactivating', 'reloading', 'unsupported'].includes(status) ? message(status) : status === 'unavailable' ? message('statusUnavailable') : message('unknown');
  }
  function readOnly() { return state.data?.readOnly !== false; }
  function liveProcess() { return !readOnly() && !state.statusFailed && state.data?.runtime?.processState === 'running'; }
  function runtimeLabel() { return statusLabel(state.action === 'stop' ? 'stopping' : state.data?.control?.stopUnconfirmed ? (state.data?.control?.action === 'stop' ? 'stopping' : 'stop_failed') : state.statusFailed ? 'unavailable' : state.data?.runtime?.state); }
  function pauseLabel(value) { return message(`pause_${value}`) === `pause_${value}` ? String(value || '') : message(`pause_${value}`); }
  async function fetchJSON(url, options = {}, timeout = 100000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
      const result = await response.json();
      if (!response.ok || result.ok === false) throw new Error(result.error || result.output || `HTTP ${response.status}`);
      return result;
    } finally { clearTimeout(timer); }
  }
  function formatTime(value, withDate = false) {
    if (!value || !Number.isFinite(Date.parse(value))) return message('unknownTime');
    const date = new Date(value);
    return new Intl.DateTimeFormat(state.language, { ...(withDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function formatDate(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return message('unknownTime');
    return new Intl.DateTimeFormat(state.language, { month: 'long', day: 'numeric' }).format(new Date(value));
  }
  function datePart(value) { return /^\d{4}-\d{2}-\d{2}/.test(value || '') ? value.slice(0, 10) : ''; }
  function knownNumber(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
  function number(value) { return knownNumber(value) ? new Intl.NumberFormat(state.language).format(value) : '—'; }
  function compactNumber(value) { return knownNumber(value) ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : message('unknown'); }
  function duration(cycle) {
    if (cycle.durationReliable === false || cycle.status === 'interrupted') return '';
    const seconds = Math.round((Date.parse(cycle.endedAt) - Date.parse(cycle.startedAt)) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) return '';
    return seconds < 60 ? message('seconds', { seconds }) : message('minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  }
  function cycleTitle(cycle) {
    if (cycle.workReport) return cycle.workReport.title;
    if (cycle.status === 'interrupted' && cycle.events?.length) return message('interruptedSummary');
    if (cycle.synthetic && cycle.status !== 'running') return statusLabel(cycle.status);
    let title = clean(cycle.summary || cycle.report || '').split('\n').find((line) => line.trim()) || '';
    if (/^[\[{]/.test(title)) title = '';
    title = title.replace(/^Cycle\s*\d+\s*(?:完成)?\s*[:：·—-]?\s*/i, '').replace(/^[，,：:\s]+/, '');
    const firstClause = title.split(/[，,。\n]/)[0];
    title = firstClause && firstClause.length >= 7 ? firstClause : title;
    if (!title) return message(cycle.active ? 'runningSummary' : cycle.status === 'failed' ? 'failedSummary' : cycle.status === 'interrupted' ? 'interruptedSummary' : cycle.status === 'unknown' ? 'unknownSummary' : 'finishedSummary');
    return shortText(title, 68);
  }
  function metadata(cycle) {
    const row = element('div', 'cycle-meta');
    row.append(element('span', cycle.status === 'failed' ? 'status-failed' : '', statusLabel(cycle.status)));
    row.append(element('span', '', message('startAt', { time: formatTime(cycle.startedAt) })));
    const elapsed = duration(cycle);
    if (elapsed) row.append(element('span', '', elapsed));
    if (cycle.durationReliable === false || cycle.status === 'interrupted') row.title = message('recoveredEnd');
    return row;
  }
  function bindDisclosure(details, key) {
    details.open = state.expanded.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) state.expanded.add(key);
      else state.expanded.delete(key);
    });
    return details;
  }
  function logButton(cycle) {
    if (cycle.synthetic) {
      const button = element('button', 'text-button cycle-log-link', message('viewRuntimeLog'));
      button.type = 'button';
      button.addEventListener('click', () => { state.selectedLog = 'runtime'; $('logSelect').value = 'runtime'; selectTab('logs', true); loadLog(); });
      return button;
    }
    if (!cycle.logAvailable) return element('p', 'sidebar-note cycle-log-link', message('noLog'));
    const button = element('button', 'text-button cycle-log-link', message('viewLog'));
    button.type = 'button';
    button.addEventListener('click', () => {
      state.selectedLog = cycle.id;
      $('logSelect').value = cycle.id;
      selectTab('logs', true);
      loadLog();
    });
    return button;
  }
  function reportRows(cycle, limit = 4) {
    const rows = [];
    for (const line of String(cycle.report || '').split('\n')) {
      if (!line.trim().startsWith('|')) continue;
      const parts = line.trim().split('|').slice(1, -1).map(clean);
      if (parts.length < 2 || parts.every((part) => /^[-: ]+$/.test(part)) || /^(项目|item|aspect|category)$/i.test(parts[0])) continue;
      if (parts[0] && parts[1]) rows.push({ label: parts[0], text: parts.slice(1).join(' · ') });
    }
    return rows.slice(0, limit);
  }
  function resultList(rows) {
    const list = element('ul', 'result-list');
    for (const row of rows) {
      const item = element('li', 'result-item');
      item.append(element('span', 'result-label', row.label), element('p', 'result-text', row.text));
      list.append(item);
    }
    return list;
  }
  function fullReport(cycle) {
    if (!cycle.report) return null;
    const details = bindDisclosure(element('details', 'report-disclosure'), `report:${cycle.id}`);
    const summary = element('summary', '', message('fullReport'));
    const body = element('div', 'full-report');
    for (const block of String(cycle.report).split(/\n\s*\n/)) {
      if (!block.trim()) continue;
      if (block.trim().startsWith('```')) {
        body.append(element('pre', 'report-code', block.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')));
      } else if (block.trim().startsWith('|')) {
        const rows = reportRows({ report: block }, Infinity);
        if (rows.length) body.append(resultList(rows));
      } else if (/^\s*[-*]\s/.test(block)) {
        const list = element('ul');
        block.split('\n').filter((line) => line.trim()).forEach((line) => list.append(element('li', '', clean(line))));
        body.append(list);
      } else {
        body.append(element('p', '', clean(block)));
      }
    }
    details.append(summary, body);
    return details;
  }
  function eventList(cycle) {
    const events = (cycle.events || []).filter((event) => event.kind !== 'report');
    if (!events.length) return null;
    const section = bindDisclosure(element('details', 'observed-events report-disclosure'), `events:${cycle.id}`);
    section.append(element('summary', '', message('observedEvents')));
    section.append(element('p', 'sidebar-note', message('eventTimeNote')));
    const list = element('ol', 'event-list');
    for (const event of events.slice(-12)) {
      const row = element('li');
      let label = message(`event_${event.kind}`);
      if (event.kind === 'command') {
        const ended = event.phase === 'completed';
        label = `${message(ended ? 'commandEnded' : 'commandStarted')} ${event.command || ''}`;
        if (ended) label += ` · ${message('exitCode')}: ${Number.isInteger(event.exitCode) ? event.exitCode : message('unknown')}`;
      } else if (event.kind === 'files') label = `${message('fileChanges')}: ${(event.paths || []).join(', ')}`;
      row.append(element('time', '', formatTime(event.observedAt)), element('span', '', label));
      list.append(row);
    }
    section.append(list);
    if (cycle.eventStatus === 'partial') section.append(element('p', 'sidebar-note', message('partialEvents')));
    return section;
  }
  function workReportDetails(cycle) {
    const work = cycle.workReport;
    if (!work && !['invalid', 'missing'].includes(cycle.workReportStatus)) return null;
    const section = element('div', 'work-report-details');
    if (!work) {
      section.append(element('p', 'sidebar-note', message(cycle.workReportStatus === 'invalid' ? 'invalidWorkReport' : 'missingWorkReport')));
      return section;
    }
    section.append(element('p', 'report-source', `${message('reportedPhase')} · ${message(`workPhase_${work.phase}`)}`));
    if (work.blocker) section.append(element('p', 'work-blocker', `${message('workBlocker')}：${work.blocker}`));
    section.append(element('p', 'report-source', message('structuredReportSource')));
    if (!cycle.active && !work.final) section.append(element('p', 'sidebar-note', message('unfinishedWorkReport')));
    return section;
  }
  function renderCurrent(cycle) {
    const container = clear($('currentCycle'));
    if (!cycle) {
      const empty = element('div', 'empty-state');
      empty.append(element('h2', '', message('noCycles')), element('p', '', message(readOnly() ? 'noCyclesBody' : 'noCyclesLive')));
      container.append(empty);
      return;
    }
    const article = element('article', 'current-cycle');
    const gutter = element('div', 'cycle-gutter');
    gutter.append(element('span', 'cycle-word', 'CYCLE'));
    const cycleNumber = element('span', 'cycle-number', String(cycle.number ?? '—').padStart(2, '0'));
    cycleNumber.id = 'cycleNumber';
    gutter.append(cycleNumber);
    const body = element('div', 'cycle-body');
    const title = element('h2', 'cycle-title', cycleTitle(cycle));
    title.id = 'cycleTitle';
    body.append(title, metadata(cycle));
    const report = element('section', 'report-section');
    const heading = element('div', 'section-heading-row');
    heading.append(element('h3', '', message('latestReport')));
    const timestamp = cycle.workReport?.recorded_at || cycle.reportObservedAt || (cycle.durationReliable !== false && cycle.endedAtKind !== 'recovered' && cycle.status !== 'interrupted' ? cycle.endedAt : null);
    if (timestamp) {
      const time = element('time', '', message('recordedAt', { time: formatTime(timestamp) }));
      time.dateTime = timestamp;
      heading.append(time);
    }
    const liveReport = cycle.active ? [...(cycle.events || [])].reverse().find((event) => event.kind === 'report') : null;
    let intro = cycle.workReport?.summary || clean(cycle.summary || liveReport?.text || '');
    if (/^[\[{]/.test(intro)) intro = cycleTitle(cycle);
    if (!intro) intro = message(cycle.active ? 'runningNoReport' : 'noReport');
    report.append(heading, element('p', 'report-intro', intro));
    const workDetails = workReportDetails(cycle);
    if (workDetails) report.append(workDetails);
    body.append(report);
    const observed = eventList(cycle);
    if (observed) body.append(observed);
    const rows = cycle.workReport ? [] : reportRows(cycle);
    if (rows.length) {
      const results = element('section', 'results-section');
      const resultHeading = element('div', 'section-heading-row');
      resultHeading.append(element('h3', '', message('cycleResults')));
      results.append(resultHeading, resultList(rows));
      body.append(results);
    }
    if (cycle.report && !cycle.workReport) body.append(element('p', 'report-source', message('reportSource')));
    const disclosure = fullReport(cycle);
    if (disclosure) body.append(disclosure);
    body.append(logButton(cycle));
    article.append(gutter, body);
    container.append(article);
  }
  function renderHistory() {
    const history = clear($('historyList'));
    const older = state.data.cycles.filter((cycle) => cycle.id !== state.currentCycle?.id);
    const visible = state.older ? older : older.slice(0, 2);
    for (const cycle of visible) {
      const row = bindDisclosure(element('details', 'history-row'), `cycle:${cycle.id}`);
      row.dataset.cycleId = cycle.id;
      const summary = element('summary');
      const timing = `${statusLabel(cycle.status)} · ${formatTime(cycle.startedAt)}`;
      summary.append(element('span', 'history-number', String(cycle.number ?? '—').padStart(2, '0')), element('span', 'history-title', cycleTitle(cycle)), element('span', `history-meta${cycle.status === 'failed' ? ' status-failed' : ''}`, timing));
      const arrow = element('span', 'history-chevron', '›');
      arrow.setAttribute('aria-hidden', 'true');
      summary.append(arrow);
      const content = element('div', 'history-content');
      content.append(metadata(cycle));
      const observed = eventList(cycle);
      if (observed) content.append(observed);
      let report = cycle.workReport?.summary || clean(cycle.summary || '');
      if (/^[\[{]/.test(report)) report = cycleTitle(cycle);
      content.append(element('p', '', report || message('noSummary')));
      const workDetails = workReportDetails(cycle);
      if (workDetails) content.append(workDetails);
      const results = cycle.workReport ? [] : reportRows(cycle);
      if (results.length) content.append(resultList(results));
      const disclosure = fullReport(cycle);
      if (disclosure) content.append(disclosure);
      content.append(logButton(cycle));
      row.append(summary, content);
      history.append(row);
    }
    $('olderButton').hidden = older.length <= 2;
    $('olderButton').textContent = state.older ? message('fewer') : message('older', { count: older.length - 2 });
    document.querySelector('.history-section').hidden = !older.length;
  }
  function aggregate(cycles) {
    const result = { inputTokens: null, outputTokens: null, totalTokens: null, known: 0, count: cycles.length, partial: false };
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
      const values = cycles.map((cycle) => cycle.usage?.[key]).filter(knownNumber);
      result[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    }
    result.known = cycles.filter((cycle) => knownNumber(cycle.usage?.totalTokens)).length;
    result.partial = result.known < cycles.length || cycles.some((cycle) => cycle.usage?.status === 'partial');
    return result;
  }
  function fileIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 24');
    svg.setAttribute('class', 'artifact-icon');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 2h8l5 5v15H4zM12 2v6h5M7 12h7M7 16h7');
    svg.append(path);
    return svg;
  }
  function runtimeRows(entries) {
    const list = element('dl', 'runtime-details');
    for (const [label, value] of entries) list.append(element('dt', '', label), element('dd', '', !value || value === 'unknown' ? message('unknown') : value));
    return list;
  }
  function languageLabel(value) { return value === 'zh-CN' || value === 'zh' ? '简体中文' : value === 'en' ? 'English' : value || message('unknown'); }
  function actionMessage(key, values = {}, error = false) {
    const node = $('actionStatus');
    node.hidden = false;
    node.textContent = message(key, values);
    node.classList.toggle('status-failed', error);
  }
  function renderRuntime() {
    const data = state.data;
    const runtime = data?.runtime || {};
    const unavailable = state.statusFailed || runtime.available === false;
    const process = runtime.processState || runtime.state;
    const action = state.action || data?.control?.action;
    const retryStop = data?.control?.stopUnconfirmed === true;
    const locked = !data || readOnly() || (unavailable && !retryStop) || Boolean(action);
    $('runtimeState').textContent = runtimeLabel();
    $('runtimeState').dataset.state = unavailable ? 'unavailable' : runtime.state || 'unknown';
    $('startButton').disabled = locked || retryStop || !['stopped', 'inactive'].includes(process);
    $('stopButton').disabled = locked || (!retryStop && process !== 'running');
    $('startButton').textContent = message(action === 'start' ? 'starting' : 'start');
    $('stopButton').textContent = message(action === 'stop' ? 'stopping' : 'stop');
    $('startButton').title = $('stopButton').title = readOnly() ? message('readOnly') : unavailable ? message('statusUnavailable') : '';
    $('refreshButton').disabled = Boolean(state.refreshPending || state.action);
    $('modeNote').textContent = data ? message(readOnly() ? 'preview' : 'live') : '';
    $('autoRefresh').disabled = Boolean(data && readOnly());
    document.querySelectorAll('.legacy-link').forEach((node) => { node.hidden = data?.legacyAvailable !== true; });
    document.querySelectorAll('.dialog-links a[href^="/docs/"]').forEach((node) => { node.hidden = readOnly(); });
    const reason = runtime.pauseReason || data?.budgetPause?.reason;
    const paused = ['paused', 'waiting_limit', 'circuit_break'].includes(runtime.state);
    $('runtimeNotice').hidden = unavailable || (!reason && !paused && !data?.budgetPause);
    $('runtimeNotice').textContent = reason ? message('pauseReason', { reason: pauseLabel(reason) }) : paused ? message('pauseReview') : data?.budgetPause ? message('budgetPause') : '';
    renderDiagnostics();
  }
  function renderDiagnostics() {
    const data = state.data;
    const runtime = data?.runtime || {};
    const status = data?.status || {};
    const parsed = status.parsed || {};
    const fields = status.stateFile || {};
    const loop = parsed.loop || {};
    const entries = [[message('state'), runtimeLabel()], [message('processState'), statusLabel(state.statusFailed ? 'unavailable' : runtime.processState)], ['PID', String(runtime.pid ?? '—')], [message('currentCycle'), String(runtime.currentCycleNumber ?? '—')], [message('errorCount'), String(runtime.errorCount ?? loop.errorCount ?? fields.ERROR_COUNT ?? '—')], [message('lastRun'), formatTime(runtime.lastRun || loop.lastRun || fields.LAST_RUN, true)], [message('pauseReasonLabel'), pauseLabel(runtime.pauseReason || data?.budgetPause?.reason || fields.PAUSE_REASON) || '—']];
    for (const [name, value] of [['guardian', parsed.guardian], ['daemon', parsed.daemon], ['autostart', parsed.autostart]]) {
      entries.push([message(name), statusLabel(value?.state)]);
      const details = Object.entries(value || {}).filter(([key]) => key !== 'state' && value[key] !== null && value[key] !== '').map(([key, item]) => `${key}: ${String(item)}`).join(' · ');
      if (details) entries.push([message(`${name}Details`), details]);
    }
    if (loop.daemonSummary) entries.push([message('daemonDetails'), String(loop.daemonSummary)]);
    const summary = clear($('diagnosticSummary'));
    if (state.statusFailed && data) summary.append(element('p', 'fine-print', message('diagnosticsStale')));
    summary.append(runtimeRows(entries));
    if (data?.budgetPause) summary.append(element('p', 'fine-print', `${message('budgetPause')}: ${JSON.stringify(data.budgetPause)}`));
    $('rawText').textContent = status.raw || runtime.error || message('noDiagnostics');
    if (state.statusFailed && status.raw) $('rawText').textContent = `${message('diagnosticsStale')}\n\n${status.raw}`;
  }
  function renderLanguage() {
    const current = state.languageState;
    const next = current?.nextLanguage || current?.language || state.language;
    $('settingsLanguage').textContent = languageLabel(current?.language || state.data?.runtime?.language || state.language);
    $('settingsMode').textContent = message(readOnly() ? 'preview' : 'live');
    $('settingsDescription').textContent = message(readOnly() ? 'settingsDescription' : 'settingsLive');
    $('languageSelect').value = next;
    $('languageSelect').disabled = readOnly() || state.languageSaving || state.languageLoading || !current;
    $('languageHint').textContent = message(readOnly() ? 'languageExplanation' : current?.locked ? 'languageLocked' : 'languageUnlocked', { current: languageLabel(current?.language), next: languageLabel(next) });
    $('languageStatus').textContent = state.languageSaving ? message('languageSaving') : state.languageLoading ? message('languageLoading') : state.languageError ? message(state.languageError) : current?.pending ? message('languagePending') : state.languageSaved ? message('languageSaved') : '';
    $('languageStatus').classList.toggle('status-failed', Boolean(state.languageError));
  }
  function applyLanguageState(value) {
    if (!value || !['en', 'zh-CN'].includes(value.language) || (value.nextLanguage && !['en', 'zh-CN'].includes(value.nextLanguage))) throw new Error('Invalid language response');
    state.languageState = value;
    state.language = value.language;
    state.languageError = '';
    if (state.data) {
      state.data.languageState = value;
      state.data.language = value.language;
      render();
    } else { applyLanguage(); renderLanguage(); }
  }
  async function refreshLanguage() {
    if (readOnly() || state.languageLoading || state.languageSaving) return;
    state.languageLoading = true;
    renderLanguage();
    try { applyLanguageState(await fetchJSON('/api/language', {}, 10000)); }
    catch (_) { state.languageError = 'languageUnavailable'; }
    finally { state.languageLoading = false; renderLanguage(); }
  }
  async function saveLanguage() {
    if (readOnly() || state.languageSaving || state.languageLoading) return;
    const language = $('languageSelect').value;
    ++state.languageRevision;
    state.languageSaving = true;
    state.languageSaved = false;
    state.languageError = '';
    renderLanguage();
    try {
      const result = await fetchJSON('/api/language', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language }) }, 10000);
      if (result.ok !== true) throw new Error('Language save not confirmed');
      applyLanguageState(result);
      state.languageSaved = true;
      state.signature = '';
    } catch (_) { state.languageError = 'languageSaveFailed'; }
    finally { state.languageSaving = false; renderLanguage(); }
  }
  function renderSidebar() {
    const sidebar = clear($('projectSidebar'));
    const data = state.data;
    const next = element('section', 'sidebar-block');
    const heading = element('div', 'section-heading-row');
    heading.append(element('h2', '', message('nextAction')));
    next.append(heading);
    const work = state.currentCycle?.workReport;
    const nextTime = work?.recorded_at || data.consensus?.updatedAt;
    if (nextTime) heading.append(element('span', 'sidebar-update', message('updated', { time: formatTime(nextTime) })));
    next.append(element('p', 'next-action', work ? (work.next_action || message('noPlannedAction')) : clean(data.consensus?.nextAction) || message('noNextAction')));
    if (work?.next_action_kind === 'human_input') next.append(element('p', 'sidebar-note', message('humanInput')));
    next.append(element('p', 'sidebar-note', message(readOnly() || (!state.statusFailed && data.runtime?.processState === 'stopped') ? 'stoppedNotice' : work ? 'workPlanNotice' : 'planNotice')));
    const artifacts = element('section', 'sidebar-block');
    artifacts.append(element('h2', '', message('artifacts')));
    if (data.artifacts?.length) {
      const list = element('ul', 'artifact-list');
      for (const artifact of data.artifacts) {
        const item = element('li');
        const label = artifact.kind === 'preview' ? message('productPreview') : artifact.label || artifact.path;
        if (artifact.available === false || (!artifact.path && !artifact.url)) {
          item.append(element('span', '', `${label} · ${message('artifactUnavailable')}`));
        } else {
          const link = element('a', 'artifact-link');
          link.href = artifact.url || `/api/journal/document?path=${encodeURIComponent(artifact.path)}`;
          link.target = '_blank';
          link.rel = 'noopener';
          link.title = artifact.path || artifact.url;
          link.append(fileIcon(), element('span', '', label));
          const arrow = element('span', 'artifact-arrow', '↗');
          arrow.setAttribute('aria-hidden', 'true');
          link.append(arrow);
          item.append(link);
        }
        if (artifact.kind === 'check') {
          const tests = artifact.tests;
          const result = `${message('exitCode')}: ${Number.isInteger(artifact.exitCode) ? artifact.exitCode : message('unknown')}`;
          item.append(element('p', 'sidebar-note', tests ? `${result} · ${message('testCounts', { tests: tests.tests, failures: tests.failures + tests.errors, skipped: tests.skipped })}` : result));
        }
        if (artifact.recordedAt) item.append(element('p', 'sidebar-note', message('recordedAt', { time: formatTime(artifact.recordedAt) })));
        list.append(item);
      }
      artifacts.append(list);
    } else artifacts.append(element('p', 'sidebar-note', message('noArtifacts')));
    const runtime = element('section', 'sidebar-block');
    runtime.append(element('h2', '', message('runtime')));
    const sum = aggregate(data.cycles.filter((cycle) => !cycle.active));
    const usage = `${compactNumber(sum.totalTokens)}${knownNumber(sum.totalTokens) ? ' tokens' : ''}${sum.partial && sum.known ? message('usagePartialShort') : ''}`;
    const config = data.runtime || {};
    runtime.append(runtimeRows([[message('engine'), config.engine], [message('model'), config.model], [message('reasoning'), config.reasoning === 'unknown' ? message('unknown') : config.reasoning], [message('language'), languageLabel(config.language || data.language)], [message('recordedUsage'), usage]]));
    runtime.append(element('p', 'sidebar-note', message(config.configSource === 'session_context' ? 'observedSession' : 'unconfirmedSession')));
    const details = bindDisclosure(element('details', 'runtime-disclosure'), 'runtime');
    details.append(element('summary', '', message('moreRuntime')), runtimeRows([[message('state'), runtimeLabel()], [message('phase'), clean(data.consensus?.phase) || message('phaseUnknown')], [message('source'), data.sourceName]]));
    runtime.append(details);
    sidebar.append(next, artifacts, runtime);
  }
  function applyLanguage() {
    document.documentElement.lang = state.language;
    document.title = `${state.data?.project?.name || 'Auto Company'} · ${message('work')}`;
    document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = message(node.dataset.i18n); });
    $('refreshButton').title = message('refresh');
    $('refreshButton').setAttribute('aria-label', message('refresh'));
    $('closeSettingsButton').setAttribute('aria-label', message('close'));
    document.querySelector('.tabs').setAttribute('aria-label', message('work'));
    document.querySelector('.table-scroll').setAttribute('aria-label', message('usageDetail'));
    $('projectSidebar').setAttribute('aria-label', message('artifacts'));
  }
  function render() {
    const data = state.data;
    applyLanguage();
    $('projectName').textContent = data.project?.name || message('noProject');
    const fullDescription = clean(data.project?.description);
    let description = fullDescription;
    if (data.project?.name && description.startsWith(data.project.name)) {
      description = description.slice(data.project.name.length).replace(/^[\s，,:：·—-]+/, '');
    }
    $('projectDescription').textContent = description.split(/[；;]/)[0];
    $('projectDescription').title = fullDescription;
    let latest = data.cycles.find((cycle) => cycle.active) || (liveProcess() ? { id: '__current__', number: data.runtime?.currentCycleNumber, startedAt: data.runtime?.lastRun, status: data.runtime?.state || 'running', active: true, synthetic: true } : data.cycles[0]);
    if (latest?.active && state.statusFailed) latest = { ...latest, active: false, status: 'unknown' };
    state.currentCycle = latest;
    $('runHeading').textContent = latest?.active ? message('currentRun') : latest ? message('latestRun', { date: formatDate(latest.startedAt) }) : message(readOnly() ? 'archived' : 'ready');
    renderCurrent(latest);
    renderHistory();
    renderSidebar();
    renderRuntime();
    renderLanguage();
    const notes = clear($('sourceNotes'));
    if (data.warnings?.length) {
      const disclosure = bindDisclosure(element('details'), 'warnings');
      const list = element('ul');
      data.warnings.forEach((warning) => list.append(element('li', '', clean(warning))));
      disclosure.append(element('summary', '', `${message('warning')} · ${data.warnings.length}`), list);
      notes.append(disclosure);
    }
    $('sourceName').textContent = message('sourceLabel', { name: data.sourceName || 'Auto Company' });
    if (!$('usageDate').value) $('usageDate').value = datePart(data.cycles.find((cycle) => !cycle.active)?.endedAt) || new Date().toISOString().slice(0, 10);
    renderUsage();
    renderLogOptions();
    selectTab(state.tab);
  }
  function filterUsage() {
    const period = $('usagePeriod').value;
    const selected = $('usageDate').value;
    $('usageDate').hidden = period === 'all';
    $('usageDateLabel').hidden = period === 'all';
    $('usageRange').textContent = '';
    const recorded = state.data.cycles.filter((cycle) => !cycle.active);
    if (period === 'all') return recorded;
    if (!selected) return [];
    let start = selected;
    let end = selected;
    if (period === 'week') {
      const date = new Date(`${selected}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      start = date.toISOString().slice(0, 10);
      date.setUTCDate(date.getUTCDate() + 6);
      end = date.toISOString().slice(0, 10);
      $('usageRange').textContent = `${start} – ${end}`;
    }
    return recorded.filter((cycle) => {
      const date = datePart(cycle.endedAt);
      return date && date >= start && date <= end;
    });
  }
  function renderUsage() {
    if (!state.data) return;
    const cycles = filterUsage();
    const summary = clear($('usageSummary'));
    const rows = clear($('usageRows'));
    renderBudget(cycles);
    if (!cycles.length) {
      summary.append(element('p', 'muted', message('noUsage')));
      return;
    }
    const total = aggregate(cycles);
    summary.append(element('span', 'usage-total', number(total.totalTokens)), element('span', 'usage-summary-label', message('knownTotal')));
    summary.append(element('p', 'usage-coverage', message('coverageDescription', total)));
    const amounts = element('p', 'usage-coverage', `${message('input')} ${number(total.inputTokens)} · ${message('output')} ${number(total.outputTokens)}`);
    summary.append(amounts);
    if (!total.known) summary.append(element('p', 'usage-warning', message('noUsageKnown')));
    else if (total.known < total.count) summary.append(element('p', 'usage-warning', message('partialWarning', { count: total.count - total.known })));
    else if (total.partial) summary.append(element('p', 'usage-warning', message('partial')));
    for (const cycle of cycles) {
      const row = element('tr');
      row.append(element('td', '', `Cycle ${String(cycle.number ?? '—').padStart(2, '0')}`), element('td', '', formatTime(cycle.startedAt, true)), element('td', '', statusLabel(cycle.status)));
      for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
        const cell = element('td', 'numeric', number(cycle.usage?.[field]));
        if (!knownNumber(cycle.usage?.[field])) cell.title = message('unknown');
        row.append(cell);
      }
      const status = knownNumber(cycle.usage?.totalTokens) ? (cycle.usage?.status === 'partial' ? 'partial' : 'reported') : 'unavailable';
      row.append(element('td', '', message(status)));
      rows.append(row);
    }
  }
  function renderBudget(cycles) {
    const container = clear($('budgetSummary'));
    const costs = cycles.map((cycle) => cycle.costUsd).filter(knownNumber);
    const cost = costs.length ? new Intl.NumberFormat(state.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(costs.reduce((sum, value) => sum + value, 0)) : message('unknown');
    container.append(element('p', '', message('recordedCost', { cost, known: costs.length, count: cycles.length })));
    const budget = cycles.find((cycle) => cycle.budget)?.budget || ($('usagePeriod').value === 'all' ? state.data?.recordedBudget : null);
    if (budget) {
      const key = `budget_${budget.state || 'unknown'}`;
      container.append(element('p', '', message('recordedBudget', { state: message(key) === key ? String(budget.state || message('unknown')) : message(key), start: budget.start_date || '—', end: budget.end_date || '—' })));
      if (Array.isArray(budget.alerts)) {
        const list = element('ul');
        for (const alert of budget.alerts) {
          if (!alert || typeof alert !== 'object') continue;
          list.append(element('li', '', message('budgetAlert', { level: message(alert.level === 'warning' ? 'budgetWarning' : 'budgetLimit'), metric: alert.metric === 'cost_usd' ? 'USD' : message('total'), actual: number(alert.actual), limit: number(alert.limit), coverage: ['complete', 'partial', 'unavailable'].includes(alert.coverage) ? message(`budget_${alert.coverage}`) : message('unknown') })));
        }
        container.append(list);
      }
    }
    if (state.data?.budgetPause) container.append(element('p', 'status-failed', message('budgetPauseReason', { reason: pauseLabel(state.data.budgetPause.reason) || message('pauseReview') })));
  }
  function renderLogOptions() {
    const select = clear($('logSelect'));
    const cycles = state.data.cycles;
    if (state.selectedLog !== 'runtime' && !cycles.some((cycle) => cycle.id === state.selectedLog)) state.selectedLog = 'runtime';
    const global = element('option', '', message('runtimeLog'));
    global.value = 'runtime';
    select.append(global);
    for (const cycle of cycles) {
      const option = element('option', '', `Cycle ${String(cycle.number ?? '—').padStart(2, '0')} · ${formatTime(cycle.startedAt, true)} · ${statusLabel(cycle.status)}`);
      option.value = cycle.id;
      select.append(option);
    }
    select.value = state.selectedLog;
    select.disabled = false;
    $('refreshLogButton').disabled = Boolean(state.logPending);
  }
  async function loadLog() {
    if (state.logPending) {
      if (state.logPending.id !== state.selectedLog) {
        ++state.logRequest;
        await state.logPending.promise;
        return loadLog();
      }
      return state.logPending.promise;
    }
    const request = ++state.logRequest;
    const id = state.selectedLog;
    const previous = state.logLoadedId === id ? state.logText : '';
    if (state.logLoadedId !== id) $('logText').textContent = '';
    state.logText = '';
    $('copyLogButton').disabled = true;
    $('copyLogButton').textContent = message('copy');
    $('refreshLogButton').disabled = true;
    $('logStatus').textContent = message('loadingLog');
    const promise = (async () => { try {
      const result = await fetchJSON(id === 'runtime' ? '/api/log-tail?lines=180' : `/api/journal/log?id=${encodeURIComponent(id)}`, {}, 15000);
      if (request !== state.logRequest) return;
      if (id !== 'runtime' && !result.available) { $('logText').textContent = ''; $('logStatus').textContent = message('noLog'); return; }
      if (id === 'runtime' && typeof result.logTail !== 'string') throw new Error('Invalid runtime log');
      state.logText = String(id === 'runtime' ? result.logTail : result.text || '');
      state.logLoadedId = id;
      $('logText').textContent = state.logText;
      $('logStatus').textContent = result.truncated ? message('logTruncated') : state.logText ? message('logAvailable', { count: number(state.logText.length) }) : message('logEmpty');
      $('copyLogButton').disabled = !state.logText;
    } catch (_) {
      if (request !== state.logRequest) return;
      state.logText = previous;
      $('logStatus').textContent = message('logFailed');
    } finally { state.logPending = null; $('refreshLogButton').disabled = false; } })();
    state.logPending = { id, promise };
    return promise;
  }
  function selectTab(tab, focus = false) {
    state.tab = tab;
    for (const button of document.querySelectorAll('[data-tab]')) {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      $(`panel-${button.dataset.tab}`).hidden = !active || !state.data;
    }
    if (focus) $(`tab-${tab}`).focus();
  }
  function scheduleRefresh() {
    clearTimeout(state.timer);
    state.timer = null;
    if (!$('autoRefresh').checked || document.hidden || state.action || state.refreshPending || readOnly()) return;
    state.timer = setTimeout(refresh, state.statusFailed ? 15000 : 5000);
  }
  function refresh() {
    if (state.refreshPending) return state.refreshPending;
    clearTimeout(state.timer);
    $('refreshButton').disabled = true;
    $('refreshStatus').textContent = message('refreshing');
    const languageRevision = state.languageRevision;
    const promise = (async () => { try {
      const data = await fetchJSON('/api/journal');
      if (!data.ok || !Array.isArray(data.cycles)) throw new Error('invalid journal response');
      const signature = JSON.stringify({ ...data, generatedAt: undefined, status: data.status ? { ...data.status, timestamp: undefined, elapsedMs: undefined } : undefined });
      state.data = data;
      state.statusFailed = data.runtime?.available === false || data.status?.ok === false || !data.runtime || ['unknown', 'unavailable'].includes(data.runtime.state);
      if (languageRevision === state.languageRevision && !state.languageSaving && !state.languageLoading) {
        if (data.languageState) {
          const language = data.languageState;
          if (['en', 'zh-CN'].includes(language.language) && (!language.nextLanguage || ['en', 'zh-CN'].includes(language.nextLanguage))) state.languageState = language;
        }
        state.language = state.languageState?.language || (data.language === 'zh-CN' ? 'zh-CN' : 'en');
      }
      if (!state.autoChanged) $('autoRefresh').checked = !readOnly();
      $('connectionError').hidden = !state.statusFailed;
      $('connectionError').textContent = message('runtimeUnavailable');
      $('loadingState').hidden = true;
      if (signature !== state.signature) {
        const scrollPosition = window.scrollY;
        state.signature = signature;
        render();
        requestAnimationFrame(() => window.scrollTo({ top: scrollPosition, behavior: 'instant' }));
      }
      renderRuntime();
      $('refreshStatus').textContent = message('refreshed', { time: formatTime(data.generatedAt || new Date().toISOString()) });
      if (state.tab === 'logs') await loadLog();
    } catch (_) {
      state.statusFailed = true;
      state.signature = '';
      $('loadingState').hidden = true;
      $('connectionError').hidden = false;
      $('connectionError').textContent = message(state.data ? 'stale' : 'readFailed');
      $('refreshStatus').textContent = '';
      if (state.data) render();
      else renderRuntime();
    } finally {
      state.refreshPending = null;
      $('refreshButton').disabled = Boolean(state.action);
      scheduleRefresh();
    } })();
    state.refreshPending = promise;
    return promise;
  }
  async function runAction(action) {
    if ($(action === 'start' ? 'startButton' : 'stopButton').disabled || state.action) return;
    state.action = action;
    clearTimeout(state.timer);
    renderRuntime();
    actionMessage('actionPending', { action: message(action) });
    if (action === 'start' && state.refreshPending) await state.refreshPending;
    try {
      // Recheck after any in-flight status read before mutating the runtime.
      const process = state.data?.runtime?.processState || state.data?.runtime?.state;
      const retryStop = action === 'stop' && state.data?.control?.stopUnconfirmed === true;
      if (readOnly() || (!retryStop && (state.statusFailed || (action === 'start' ? !['stopped', 'inactive'].includes(process) : process !== 'running')))) throw new Error(message('stateChanged'));
      const result = await fetchJSON(`/api/action/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, 120000);
      if (result.ok !== true) throw new Error('Action not confirmed');
      actionMessage('actionComplete', { action: message(action) });
    } catch (error) {
      actionMessage('actionFailed', { action: message(action), detail: error.name === 'AbortError' ? message('actionUnconfirmed') : error.message || message('actionUnconfirmed') }, true);
    } finally {
      if (state.refreshPending) await state.refreshPending;
      await refresh();
      state.action = '';
      renderRuntime();
      scheduleRefresh();
    }
  }

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => { selectTab(button.dataset.tab); if (button.dataset.tab === 'logs') loadLog(); });
    button.addEventListener('keydown', (event) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const tabs = ['work', 'usage', 'logs'];
      const index = tabs.indexOf(state.tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      selectTab(tabs[next], true);
      if (tabs[next] === 'logs') loadLog();
    });
  });
  $('refreshButton').addEventListener('click', refresh);
  $('startButton').addEventListener('click', () => runAction('start'));
  $('stopButton').addEventListener('click', () => runAction('stop'));
  $('autoRefresh').addEventListener('change', () => { state.autoChanged = true; scheduleRefresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && $('autoRefresh').checked && !readOnly() && !state.action) refresh(); else scheduleRefresh(); });
  $('olderButton').addEventListener('click', () => { state.older = !state.older; renderHistory(); });
  $('usagePeriod').addEventListener('change', renderUsage);
  $('usageDate').addEventListener('change', renderUsage);
  $('logSelect').addEventListener('change', () => { state.selectedLog = $('logSelect').value; loadLog(); });
  $('refreshLogButton').addEventListener('click', loadLog);
  $('copyLogButton').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.logText);
      $('copyLogButton').textContent = message('copied');
    } catch (_) { $('logStatus').textContent = message('copyFailed'); }
  });
  $('settingsButton').addEventListener('click', () => { $('settingsDialog').showModal(); refreshLanguage(); });
  $('languageSelect').addEventListener('change', saveLanguage);
  $('closeSettingsButton').addEventListener('click', () => $('settingsDialog').close());
  $('settingsDialog').addEventListener('click', (event) => {
    if (event.target !== $('settingsDialog')) return;
    const box = $('settingsDialog').getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('settingsDialog').close();
  });
  applyLanguage();
  renderLanguage();
  refresh();
})();
