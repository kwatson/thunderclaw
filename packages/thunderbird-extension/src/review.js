const elements = {
  status: document.querySelector("#status"), replacement: document.querySelector("#replacement"),
  summary: document.querySelector("#summary"), tabs: [...document.querySelectorAll("#view-tabs [role=tab]")],
  apply: document.querySelector("#apply"), discard: document.querySelector("#discard"),
  close: document.querySelector("#close"), error: document.querySelector("#error"),
};
let jobId; let suggestionId; let applied = false; let result; let view = "changes"; let rendered = "";
let pollTimer; let actionPending = false; let closed = false;

function unavailable(message = "This review is no longer available. Close it and open ThunderClaw again.") {
  jobId = undefined; suggestionId = undefined; result = undefined; rendered = "";
  elements.apply.disabled = true; elements.discard.disabled = true;
  elements.status.textContent = "Review unavailable";
  elements.error.textContent = message; elements.error.hidden = false;
  if (pollTimer) clearTimeout(pollTimer);
}
function render(job) {
  if (!job || (jobId && job.jobId !== jobId) || !["ready", "applied"].includes(job.state) || !job.result) return unavailable();
  jobId = job.jobId; suggestionId = job.result.suggestionId; result = job.result; applied = job.state === "applied";
  const key = `${suggestionId}:${view}`;
  if (rendered !== key) { ThunderClawPreview.render(elements.replacement, result, view); rendered = key; }
  for (const tab of elements.tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  elements.summary.textContent = result.summary;
  elements.status.textContent = applied ? "Applied — Thunderbird still controls Send" : "Preview ready";
  elements.apply.textContent = applied ? "Applied" : "Apply to draft";
  elements.apply.disabled = applied || Boolean(job.mutation) || actionPending;
  elements.discard.textContent = applied ? "Undo change" : "Start over";
  elements.discard.disabled = Boolean(job.mutation) || actionPending;
  elements.error.hidden = true;
}
function schedulePoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = setTimeout(() => void poll().catch(() => unavailable()), 750); }
async function poll() {
  if (!jobId || closed) return;
  const value = await browser.runtime.sendMessage({ type: "review.job", jobId });
  render(value.job);
  if (jobId) schedulePoll();
}
async function initialize() {
  // Thunderbird can run this page before windows.create resolves and binds its tab.
  for (let attempt = 0; attempt < 25 && !closed; attempt += 1) {
    try { const value = await browser.runtime.sendMessage({ type: "review.initialize" }); render(value.job); if (jobId) schedulePoll(); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  unavailable();
}
for (const tab of elements.tabs) tab.addEventListener("click", () => {
  if (!result) return;
  view = tab.dataset.view; rendered = ""; render({ jobId, state: applied ? "applied" : "ready", result });
});
elements.apply.addEventListener("click", async () => {
  if (!jobId || !suggestionId || applied || actionPending) return;
  actionPending = true; elements.apply.disabled = true; elements.discard.disabled = true;
  try { const value = await browser.runtime.sendMessage({ type: "review.apply", jobId, suggestionId }); render(value.job); }
  catch (error) { unavailable(error instanceof Error ? error.message : undefined); }
  finally { actionPending = false; }
});
elements.discard.addEventListener("click", async () => {
  if (!jobId || !suggestionId || actionPending) return;
  actionPending = true; elements.apply.disabled = true; elements.discard.disabled = true;
  try {
    if (applied) await browser.runtime.sendMessage({ type: "review.undo", jobId, suggestionId });
    else await browser.runtime.sendMessage({ type: "review.discard", jobId });
    unavailable(applied ? "Change undone." : "Suggestion discarded.");
  } catch (error) { unavailable(error instanceof Error ? error.message : undefined); }
  finally { actionPending = false; }
});
elements.close.addEventListener("click", () => window.close());
window.addEventListener("unload", () => { closed = true; if (pollTimer) clearTimeout(pollTimer); });
void initialize();
