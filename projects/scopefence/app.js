import { SAMPLE_RECEIPT, formatDays, formatPrice, makeReceipt, receiptFromHash, validateReceipt, encodeReceipt } from "./scopefence-core.js";

const app = document.querySelector("#app");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const linkFor = (receipt) => `${location.href.split("#")[0]}#r=${encodeReceipt(receipt)}`;
const formattedTime = (time) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(time)) + " UTC";

function wordmark() {
  return `<header class="site-header"><a class="brand" href="${location.href.split("#")[0]}" aria-label="ScopeFence home"><img src="auto-company-icon.svg" alt="" onerror="this.hidden=true"><span>ScopeFence</span></a><span class="draft-state">NO LOGIN · SHAREABLE RECEIPT</span></header>`;
}

function fence() { return `<div class="fence-rule" aria-hidden="true"><span>BOUNDARY</span></div>`; }

function receiptDetail(receipt) {
  return `<div class="receipt-details">
    <section class="territory inside"><p class="eyebrow">INSIDE THE FENCE</p><h2>${escapeHtml(receipt.project)}</h2><p>${escapeHtml(receipt.change)}</p>${receipt.context ? `<p class="context">${escapeHtml(receipt.context)}</p>` : ""}</section>
    ${fence()}
    <section class="territory outside"><p class="eyebrow">THE NEW WORK CHANGES</p><dl><div><dt>Price impact</dt><dd>${formatPrice(receipt.price)}</dd></div><div><dt>Timeline impact</dt><dd>${formatDays(receipt.days)}</dd></div></dl></section>
  </div>`;
}

function createView(values = {}, errors = {}) {
  app.innerHTML = `${wordmark()}<section class="hero create-hero"><p class="eyebrow">SCOPE DECISION / 01</p><h1>Make the boundary visible<br>before the work begins.</h1><p class="lede">Turn a post-call change into one plain-English decision your client can open without an account.</p></section>
  <section class="creator-grid"><form id="receipt-form" novalidate><div class="form-heading"><p class="eyebrow">DRAW THE RECEIPT</p><p>State the changed work and its consequence. Nothing more.</p></div>
    <label>Project name<input name="project" maxlength="80" value="${escapeHtml(values.project)}" autocomplete="off" aria-describedby="project-error" required></label><p id="project-error" class="error">${errors.project || ""}</p>
    <label>What changed?<textarea name="change" maxlength="500" rows="5" aria-describedby="change-help change-error" required placeholder="Add a pricing calculator to the existing landing page.">${escapeHtml(values.change)}</textarea></label><p id="change-help" class="help">Use the words your client used on the call.</p><p id="change-error" class="error">${errors.change || ""}</p>
    <div class="impact-row"><label>Price impact (USD)<input name="price" type="number" min="0" step="1" inputmode="numeric" value="${escapeHtml(values.price)}" aria-describedby="price-error" required></label><label>Timeline impact (days)<input name="days" type="number" min="0" max="365" step="1" inputmode="numeric" value="${escapeHtml(values.days)}" aria-describedby="days-error" required></label></div><p id="price-error" class="error">${errors.price || ""}</p><p id="days-error" class="error">${errors.days || ""}</p>
    <label>Optional context<textarea name="context" maxlength="300" rows="3" aria-describedby="context-error" placeholder="What does this change cover?">${escapeHtml(values.context)}</textarea></label><p id="context-error" class="error">${errors.context || ""}</p>
    <button class="primary" type="submit">Create decision link <span aria-hidden="true">↗</span></button><button class="text-button" type="button" id="sample-button">Open a sample receipt</button>
  </form><aside class="draft-note"><p class="eyebrow">A SMALL PROMISE</p><p>ScopeFence makes the trade-off clear. It does not send email, collect payment, or pretend to be a contract.</p><div class="corner-mark" aria-hidden="true"></div></aside></section>`;
  document.querySelector("#receipt-form").addEventListener("submit", submitReceipt);
  document.querySelector("#sample-button").addEventListener("click", () => showReceipt(SAMPLE_RECEIPT));
}

function submitReceipt(event) {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const errors = validateReceipt(values);
  if (Object.keys(errors).length) { createView(values, errors); document.querySelector(".error:not(:empty)")?.previousElementSibling?.focus(); return; }
  showReceipt(makeReceipt(values), true);
}

function showReceipt(receipt, maker = false) {
  const publicLink = linkFor(receipt);
  app.innerHTML = `${wordmark()}<section class="hero receipt-hero"><p class="eyebrow">${receipt.sample ? "SAMPLE — NOT A LIVE CLIENT DECISION" : "SCOPE RECEIPT / READY TO DECIDE"}</p><h1>Does this request belong<br>in the agreed work?</h1><p class="lede">Read the change and its impact. Then make one clear choice.</p></section><section class="receipt-wrap">${receiptDetail(receipt)}<section class="decision-panel" aria-labelledby="decision-heading"><p class="eyebrow">THE DECISION</p><h2 id="decision-heading">Choose what happens next.</h2><p>Your selection can be carried in an updated link and returned to the freelancer. The link is editable and is not a signed or independently verified approval record.</p><div class="decision-actions"><button class="decision approve" data-decision="approved">Approve this change <span>→</span></button><button class="decision decline" data-decision="declined">Decline this change <span>→</span></button></div></section>${maker ? makerPanel(publicLink, receipt) : ""}</section>`;
  document.querySelectorAll("[data-decision]").forEach((button) => button.addEventListener("click", () => confirmDecision(receipt, button.dataset.decision)));
  bindCopies();
}

function makerPanel(link, receipt) {
  const email = `Subject: Decision needed — ${receipt.project}\n\nHi,\n\nPlease review this scope receipt and choose approve or decline: ${link}\n\nIt covers: ${receipt.change}\n\nThanks.`;
  return `<section class="share-panel" tabindex="-1"><div><p class="eyebrow">LINK READY</p><h2>Send the decision, not a vague follow-up.</h2><p class="link-value">${escapeHtml(link)}</p></div><div class="copy-actions"><button class="primary copy-button" data-copy="${escapeHtml(link)}" data-copy-label="Copy link">Copy link</button><button class="secondary copy-button" data-copy="${escapeHtml(email)}" data-copy-label="Copy email">Copy email</button></div><p class="share-note">The receipt data lives in the link itself. Anyone with the link can alter that data, so confirm the returned choice in the original conversation.</p></section>`;
}

function finalReturnPanel(link) {
  return `<section class="return-panel" aria-labelledby="return-heading"><p class="eyebrow">RETURN THE LINK COPY</p><h2 id="return-heading">Send this updated link back.</h2><p>Paste it into the same email or message thread. It carries your selected response, but it is editable and is not independently verified.</p><label class="final-link-label" for="final-link">Updated decision link<input id="final-link" class="final-link-input" type="url" readonly value="${escapeHtml(link)}"></label><div class="copy-actions"><button class="primary copy-button" data-copy="${escapeHtml(link)}" data-copy-label="Copy updated link">Copy updated link</button><button class="secondary" type="button" id="select-final-link">Select link</button></div></section>`;
}

function confirmDecision(receipt, decision) {
  const action = decision === "approved" ? "approval" : "decline";
  const panel = document.querySelector(".decision-panel");
  panel.innerHTML = `<p class="eyebrow">CONFIRM ${action.toUpperCase()}</p><h2>${decision === "approved" ? "Approve this changed work?" : "Decline this changed work?"}</h2><p>${decision === "approved" ? `You are confirming ${formatPrice(receipt.price)} and ${formatDays(receipt.days)}.` : "The freelancer will see that this change is not approved."}</p><div class="decision-actions"><button class="primary" id="confirm-decision">Confirm ${action}</button><button class="secondary" id="cancel-decision">Go back</button></div>`;
  document.querySelector("#confirm-decision").focus();
  document.querySelector("#confirm-decision").addEventListener("click", () => finalizeDecision(receipt, decision));
  document.querySelector("#cancel-decision").addEventListener("click", () => showReceipt(receipt));
}

function finalizeDecision(receipt, decision) {
  const finalized = { ...receipt, decision, decidedAt: new Date().toISOString() };
  const link = linkFor(finalized);
  history.replaceState({}, "", `#r=${encodeReceipt(finalized)}`);
  app.innerHTML = `${wordmark()}<section class="final-state ${decision}"><p class="eyebrow">DECISION LINK COPY CREATED</p><h1>${decision === "approved" ? "Approval selected." : "Decline selected."}</h1><p>${escapeHtml(finalized.project)} · ${formattedTime(finalized.decidedAt)}</p><div class="final-stamp">${decision === "approved" ? "✓ APPROVAL SELECTED" : "× DECLINE SELECTED"}</div>${finalReturnPanel(link)}<button class="text-button" id="view-receipt">View receipt</button></section>`;
  bindCopies();
  document.querySelector("#select-final-link").addEventListener("click", () => { const input = document.querySelector("#final-link"); input.focus(); input.select(); });
  document.querySelector("#view-receipt").addEventListener("click", () => showFinalReceipt(finalized));
}

function showFinalReceipt(receipt) {
  app.innerHTML = `${wordmark()}<section class="hero receipt-hero"><p class="eyebrow">DECISION LINK COPY</p><h1>${receipt.decision === "approved" ? "This link says: approved." : "This link says: declined."}</h1><p class="lede">The encoded link includes a selection timestamp of ${formattedTime(receipt.decidedAt)}. It is not signed or independently verified.</p></section><section class="receipt-wrap">${receiptDetail(receipt)}<section class="decision-panel locked"><p class="eyebrow">PORTABLE COPY</p><h2>${receipt.decision === "approved" ? "Approval selected" : "Decline selected"}</h2><p>Anyone with the link can alter its encoded data. Confirm the choice in the original conversation before relying on it.</p></section></section>`;
}

function bindCopies() {
  document.querySelectorAll(".copy-button").forEach((button) => button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = "Copied"; setTimeout(() => { button.textContent = button.dataset.copyLabel || "Copy"; }, 1800); }
    catch { button.textContent = "Copy failed — select the link"; }
  }));
}

function renderFromLocation() {
  const existing = receiptFromHash(location.hash);
  if (existing?.decision && existing.decidedAt) showFinalReceipt(existing);
  else if (existing) showReceipt(existing);
  else createView();
}

window.addEventListener("hashchange", renderFromLocation);
renderFromLocation();
