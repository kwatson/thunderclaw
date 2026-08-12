const elements = {
  status: document.querySelector("#status"),
  agent: document.querySelector("#agent"),
  action: document.querySelector("#action"),
  sourceLabel: document.querySelector("#source-label"),
  sourceLanguage: document.querySelector("#source-language"),
  targetLabel: document.querySelector("#target-label"),
  targetCaption: document.querySelector("#target-caption"),
  targetLanguage: document.querySelector("#target-language"),
  run: document.querySelector("#run"),
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

function setBusy(busy, label) {
  elements.run.disabled = busy || !elements.agent.value;
  elements.action.disabled = busy;
  elements.agent.disabled = busy;
  if (label) elements.status.textContent = label;
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
  setBusy(false, "Unavailable");
}

function updateAction() {
  const translating = elements.action.value === "translate";
  elements.sourceLabel.hidden = !translating;
  elements.targetLabel.hidden = false;
  elements.targetCaption.textContent = translating ? "Translate to" : "Summary language";
  elements.run.textContent = translating ? "Translate message" : "Summarize message";
}

function renderJob(job) {
  if (!job) return;
  activeJobId = job.jobId;
  if (job.state === "running") {
    elements.result.hidden = true;
    setBusy(true, job.action === "translate" ? "Translating message…" : "Summarizing message…");
    return;
  }
  setBusy(false);
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
  const job = await browser.runtime.sendMessage({ type: "messagePopup.job", tabId });
  if (!job || job.jobId !== activeJobId) return;
  renderJob(job);
  if (job.state === "running") pollTimer = setTimeout(() => void pollJob().catch(showError), 500);
}

async function initialize() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("Open ThunderClaw while viewing a message.");
  tabId = tabs[0].id;
  const state = await browser.runtime.sendMessage({ type: "messagePopup.initialize", tabId });
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.agentId;
    option.textContent = agent.model ? `${agent.displayName} — ${agent.model}` : agent.displayName;
    option.selected = agent.agentId === state.selectedAgentId;
    elements.agent.append(option);
  }
  if (!state.agents.length) throw new Error("No compatible OpenClaw agents are available.");
  elements.targetLanguage.value = state.preferredLanguage;
  const detected = state.detected?.languages?.[0];
  elements.sourceLanguage.placeholder = detected ? `Auto-detect (${detected.language})` : "Auto-detect";
  elements.agent.disabled = false;
  elements.run.disabled = false;
  elements.status.textContent = `${state.capture.characters} message characters`;
  if (state.job) {
    renderJob(state.job);
    if (state.job.state === "running") void pollJob().catch(showError);
  }
}

elements.action.addEventListener("change", updateAction);
elements.run.addEventListener("click", async () => {
  elements.error.hidden = true;
  elements.result.hidden = true;
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
    if (job.state === "running") void pollJob().catch(showError);
  } catch (error) {
    showError(error);
  }
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
window.addEventListener("unload", () => { if (pollTimer) clearTimeout(pollTimer); });

updateAction();
void initialize().catch(showError);
