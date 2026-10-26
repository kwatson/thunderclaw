const elements = {
  status: document.querySelector("#status"),
  agent: document.querySelector("#agent"),
  connection: document.querySelector("#connection"),
  action: document.querySelector("#action"),
  sourceLabel: document.querySelector("#source-label"),
  sourceLanguage: document.querySelector("#source-language"),
  targetLabel: document.querySelector("#target-label"),
  targetCaption: document.querySelector("#target-caption"),
  targetLanguage: document.querySelector("#target-language"),
  run: document.querySelector("#run"),
  progress: document.querySelector("#run-progress"),
  elapsed: document.querySelector("#elapsed"),
  cancel: document.querySelector("#cancel"),
  result: document.querySelector("#message-result"),
  description: document.querySelector("#result-description"),
  translationActions: document.querySelector("#translation-actions"),
  showOriginal: document.querySelector("#show-original"),
  showTranslation: document.querySelector("#show-translation"),
  dismiss: document.querySelector("#dismiss"),
  error: document.querySelector("#error"),
};

let tabId;
let activeJobId;
let pollTimer;
let pollGeneration = 0;
let elapsedTimer;
let actionPending = false;

function stopElapsed() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = undefined; }
function startElapsed(startedAt) {
  stopElapsed();
  const update = () => { elements.elapsed.textContent = `Elapsed: ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s`; };
  update(); elapsedTimer = setInterval(update, 1000);
}
function schedulePoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = setTimeout(() => void pollJob().catch(showError), 750); }

function setBusy(busy, label) {
  elements.run.disabled = busy || !elements.agent.value;
  elements.action.disabled = busy;
  elements.agent.disabled = true;
  if (label) elements.status.textContent = label;
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
  setBusy(false, "Unavailable");
  stopElapsed(); elements.progress.hidden = true;
}

function updateAction() {
  const translating = elements.action.value === "translate";
  elements.sourceLabel.hidden = !translating;
  elements.targetLabel.hidden = false;
  elements.targetCaption.textContent = translating ? "Translate to" : "Summary language";
  elements.run.textContent = translating ? "Translate message" : "Summarize message";
}

function renderJob(job) {
  if (!job || (activeJobId && job.jobId !== activeJobId)) {
    activeJobId = undefined; elements.result.hidden = true; elements.progress.hidden = true; stopElapsed();
    setBusy(false, "Result unavailable. Run again."); return;
  }
  activeJobId = job.jobId;
  if (job.state === "running") {
    elements.result.hidden = true;
    elements.progress.hidden = false; elements.cancel.hidden = false;
    startElapsed(job.startedAt);
    setBusy(true, job.action === "translate" ? "Translating message…" : "Summarizing message…");
    return;
  }
  if (job.state === "finishing") {
    stopElapsed(); elements.progress.hidden = false; elements.cancel.hidden = true;
    setBusy(true, "Displaying result…"); return;
  }
  stopElapsed(); elements.progress.hidden = true;
  setBusy(false);
  if (job.state === "cancelled") { elements.result.hidden = true; elements.status.textContent = "Cancelled. No result was used; your provider may still process the request."; return; }
  if (job.state === "error") return showError(new Error(job.error || "Message operation failed."));
  if (job.state !== "ready" || !job.result) return;
  elements.result.hidden = false;
  if (job.action === "translate") {
    elements.description.textContent = `Translation displayed${job.result.detectedLanguage ? ` · detected ${job.result.detectedLanguage}` : ""}`;
    elements.translationActions.hidden = false;
    elements.status.textContent = `Translated to ${job.result.targetLanguage || elements.targetLanguage.value}`;
  } else {
    elements.description.textContent = "Summary displayed above the original message.";
    elements.translationActions.hidden = true;
    elements.status.textContent = "Summary ready";
  }
}

async function pollJob() {
  const expectedJobId = activeJobId; const generation = pollGeneration;
  const job = await browser.runtime.sendMessage({ type: "messagePopup.job", tabId });
  if (generation !== pollGeneration || activeJobId !== expectedJobId) return;
  if (!job || job.jobId !== activeJobId) { renderJob(null); return; }
  renderJob(job);
  if (["running", "finishing"].includes(job.state)) schedulePoll();
}

async function initialize() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("Open ThunderClaw while viewing a message.");
  tabId = tabs[0].id;
  const state = await browser.runtime.sendMessage({ type: "messagePopup.initialize", tabId });
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.agentId;
    const label = agent.model || agent.displayName;
    const fireworksPrefix = "accounts/fireworks/models/";
    option.textContent = typeof label === "string" && label.startsWith(fireworksPrefix) && label.length > fireworksPrefix.length
      ? label.slice(fireworksPrefix.length) : label;
    option.selected = agent.agentId === state.selectedAgentId;
    elements.agent.append(option);
  }
  if (!state.agents.length) throw new Error("Choose a model in ThunderClaw connection settings.");
  elements.targetLanguage.value = state.preferredLanguage;
  const detected = state.detected?.languages?.[0];
  elements.sourceLanguage.placeholder = detected ? `Auto-detect (${detected.language})` : "Auto-detect";
  elements.agent.disabled = true;
  const selected = state.agents.find((agent) => agent.agentId === state.selectedAgentId);
  elements.connection.textContent = selected?.provider ? `Connected to ${selected.provider}` : "Configured model";
  elements.run.disabled = false;
  elements.status.textContent = `${state.capture.characters} message characters`;
  if (state.job) {
    renderJob(state.job);
    if (["running", "finishing"].includes(state.job.state)) schedulePoll();
  }
}

elements.action.addEventListener("change", updateAction);
elements.run.addEventListener("click", async () => {
  if (actionPending) return;
  elements.error.hidden = true;
  elements.result.hidden = true;
  activeJobId = undefined;
  pollGeneration += 1;
  if (pollTimer) clearTimeout(pollTimer);
  const action = elements.action.value;
  if (action === "translate" && !elements.targetLanguage.value.trim()) return showError(new Error("Choose a target language."));
  setBusy(true, action === "translate" ? "Translating message…" : "Summarizing message…");
  try {
    const source = elements.sourceLanguage.value.trim();
    const job = await browser.runtime.sendMessage({
      type: "messagePopup.transform",
      tabId,
      agentId: elements.agent.value,
      action,
      sourceLanguage: !source || source.toLowerCase() === "auto-detect" ? null : source,
      targetLanguage: elements.targetLanguage.value.trim(),
    });
    renderJob(job);
    if (["running", "finishing"].includes(job.state)) schedulePoll();
  } catch (error) {
    showError(error);
  }
});

elements.cancel.addEventListener("click", async () => {
  if (!activeJobId || actionPending) return;
  pollGeneration += 1;
  actionPending = true; elements.cancel.disabled = true;
  try {
    const job = await browser.runtime.sendMessage({ type: "messagePopup.cancel", tabId, jobId: activeJobId });
    renderJob(job);
    if (["running", "finishing"].includes(job?.state)) schedulePoll();
  }
  catch (error) { showError(error); }
  finally { actionPending = false; elements.cancel.disabled = false; }
});

elements.showOriginal.addEventListener("click", () => void browser.runtime.sendMessage({ type: "messagePopup.original", tabId, jobId: activeJobId }).catch(showError));
elements.showTranslation.addEventListener("click", () => void browser.runtime.sendMessage({ type: "messagePopup.translation", tabId, jobId: activeJobId }).catch(showError));
elements.dismiss.addEventListener("click", async () => {
  try {
    await browser.runtime.sendMessage({ type: "messagePopup.dismiss", tabId, jobId: activeJobId });
    window.close();
  } catch (error) {
    showError(error);
  }
});
window.addEventListener("unload", () => { pollGeneration += 1; if (pollTimer) clearTimeout(pollTimer); stopElapsed(); });

updateAction();
void initialize().catch(showError);
