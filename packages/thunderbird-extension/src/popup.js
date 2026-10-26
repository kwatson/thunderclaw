const elements = {
  status: document.querySelector("#status"),
  agent: document.querySelector("#agent"),
  connection: document.querySelector("#connection"),
  action: document.querySelector("#action"),
  instruction: document.querySelector("#instruction"),
  instructionLabel: document.querySelector("#instruction-label"),
  run: document.querySelector("#run"),
  progress: document.querySelector("#run-progress"),
  elapsed: document.querySelector("#elapsed"),
  cancel: document.querySelector("#cancel"),
  preview: document.querySelector("#preview"),
  replacement: document.querySelector("#replacement"),
  tabs: [...document.querySelectorAll("#view-tabs [role=tab]")],
  expand: document.querySelector("#expand"),
  summary: document.querySelector("#summary"),
  apply: document.querySelector("#apply"),
  discard: document.querySelector("#discard"),
  error: document.querySelector("#error"),
};

let tabId;
let suggestionId;
let applied = false;
let activeJobId;
let pollTimer;
let pollGeneration = 0;
let elapsedTimer;
let view = "changes";
let lastRendered = "";
let currentResult;
let actionPending = false;

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
  elements.status.textContent = "Unavailable";
  setBusy(false);
}

function setBusy(busy, label) {
  elements.run.disabled = busy || !elements.agent.value;
  elements.apply.disabled = busy || applied || !suggestionId;
  elements.discard.disabled = busy || !activeJobId;
  elements.expand.disabled = busy || !suggestionId;
  if (label) elements.status.textContent = label;
}

function instructionRequirement() {
  const requirements = {
    tone: { label: "Desired tone (required)", placeholder: "For example: warm and professional", error: "Describe the tone you want before generating a preview." },
    translate: { label: "Target language (required)", placeholder: "For example: translate to Spanish", error: "Enter a target language before generating a preview." },
    ask: { label: "Instruction (required)", placeholder: "Describe how to revise the selected text", error: "Enter an instruction before generating a preview." },
  };
  return requirements[elements.action.value];
}

function updateAction() {
  const requirement = instructionRequirement();
  elements.instructionLabel.textContent = requirement?.label || "Instruction (optional)";
  elements.instruction.placeholder = requirement?.placeholder || "For example: make this warmer";
  elements.instruction.required = Boolean(requirement);
  elements.instruction.removeAttribute("aria-invalid");
  elements.error.hidden = true;
}

function renderReplacement(result) {
  const key = `${result.suggestionId}:${view}`;
  if (lastRendered === key) return;
  ThunderClawPreview.render(elements.replacement, result, view);
  lastRendered = key;
  for (const tab of elements.tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === view));
}

function renderJob(job) {
  if (!job || (activeJobId && job.jobId !== activeJobId)) {
    activeJobId = undefined; suggestionId = undefined; currentResult = undefined; lastRendered = "";
    elements.preview.hidden = true; elements.progress.hidden = true; stopElapsed();
    setBusy(false, "Preview unavailable. Generate again."); return;
  }
  activeJobId = job.jobId;
  if (job.state === "running") {
    suggestionId = undefined;
    applied = false;
    elements.preview.hidden = true;
    elements.progress.hidden = false;
    startElapsed(job.startedAt);
    setBusy(true, "Generating preview…");
    return;
  }
  stopElapsed(); elements.progress.hidden = true;
  setBusy(false);
  if (job.state === "cancelled") { suggestionId = undefined; elements.preview.hidden = true; elements.status.textContent = "Cancelled. No suggestion was used; your provider may still process the request."; return; }
  if (job.state === "error") {
    showError(new Error(job.error || "Preview generation failed."));
    return;
  }
  if (job.state === "ready" && job.result) {
    applied = false;
    suggestionId = job.result.suggestionId;
    currentResult = job.result;
    renderReplacement(job.result);
    elements.summary.textContent = job.result.summary;
    elements.preview.hidden = false;
    elements.apply.textContent = "Apply to draft";
    elements.apply.disabled = Boolean(job.mutation);
    elements.discard.textContent = "Start over";
    elements.discard.disabled = Boolean(job.mutation);
    elements.expand.disabled = Boolean(job.mutation);
    elements.status.textContent = "Preview ready";
  }
  if (job.state === "applied" && job.result) {
    applied = true;
    suggestionId = job.result.suggestionId;
    currentResult = job.result;
    renderReplacement(job.result);
    elements.summary.textContent = job.result.summary;
    elements.preview.hidden = false;
    elements.apply.textContent = "Applied";
    elements.apply.disabled = true;
    elements.discard.textContent = "Undo change";
    elements.discard.disabled = Boolean(job.mutation);
    elements.expand.disabled = Boolean(job.mutation);
    elements.status.textContent = "Applied — Thunderbird still controls Send";
  }
}

function stopElapsed() { if (elapsedTimer) clearInterval(elapsedTimer); elapsedTimer = undefined; }
function startElapsed(startedAt) {
  stopElapsed();
  const update = () => { elements.elapsed.textContent = `Elapsed: ${Math.max(0, Math.floor((Date.now() - startedAt) / 1000))}s`; };
  update(); elapsedTimer = setInterval(update, 1000);
}
function schedulePoll() { if (pollTimer) clearTimeout(pollTimer); pollTimer = setTimeout(() => void pollJob().catch(showError), 750); }

async function pollJob() {
  const expectedJobId = activeJobId; const generation = pollGeneration;
  const job = await browser.runtime.sendMessage({ type: "popup.job", tabId });
  if (generation !== pollGeneration || activeJobId !== expectedJobId) return;
  if (!job || job.jobId !== activeJobId) { renderJob(null); return; }
  renderJob(job);
  if (["running", "ready", "applied"].includes(job.state)) schedulePoll();
}

async function initialize() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("Open ThunderClaw from a message compose window.");
  tabId = tabs[0].id;
  const state = await browser.runtime.sendMessage({ type: "popup.initialize", tabId });
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
  elements.agent.disabled = true;
  const selected = state.agents.find((agent) => agent.agentId === state.selectedAgentId);
  elements.connection.textContent = selected?.provider ? `Connected to ${selected.provider}` : "Configured model";
  elements.run.disabled = false;
  elements.status.textContent = `${state.selection.text.length} characters selected`;
  if (state.job) {
    renderJob(state.job);
    if (["running", "ready", "applied"].includes(state.job.state)) schedulePoll();
  }
}

elements.action.addEventListener("change", updateAction);
for (const tab of elements.tabs) tab.addEventListener("click", () => {
  view = tab.dataset.view;
  lastRendered = "";
  if (currentResult) renderReplacement(currentResult);
});
elements.instruction.addEventListener("input", () => elements.instruction.removeAttribute("aria-invalid"));
elements.run.addEventListener("click", async () => {
  if (actionPending) return;
  elements.error.hidden = true;
  const requirement = instructionRequirement();
  if (requirement && !elements.instruction.value.trim()) {
    elements.instruction.setAttribute("aria-invalid", "true");
    elements.instruction.focus();
    return showError(new Error(requirement.error));
  }
  elements.preview.hidden = true;
  suggestionId = undefined;
  activeJobId = undefined;
  currentResult = undefined; lastRendered = ""; view = "changes";
  pollGeneration += 1;
  applied = false;
  if (pollTimer) clearTimeout(pollTimer);
  setBusy(true, "Generating preview…");
  try {
    const job = await browser.runtime.sendMessage({
      type: "popup.transform",
      tabId,
      agentId: elements.agent.value,
      action: elements.action.value,
      instruction: elements.instruction.value.trim(),
    });
    renderJob(job);
    if (["running", "ready", "applied"].includes(job.state)) schedulePoll();
  } catch (error) {
    showError(error);
  }
});

elements.cancel.addEventListener("click", async () => {
  if (!activeJobId || actionPending) return;
  pollGeneration += 1;
  actionPending = true; elements.cancel.disabled = true;
  try {
    const job = await browser.runtime.sendMessage({ type: "popup.cancel", tabId, jobId: activeJobId });
    renderJob(job);
    if (["running", "ready", "applied"].includes(job?.state)) schedulePoll();
  }
  catch (error) { showError(error); }
  finally { actionPending = false; elements.cancel.disabled = false; }
});

elements.expand.addEventListener("click", async () => {
  if (!activeJobId || !suggestionId || actionPending) return;
  actionPending = true; elements.expand.disabled = true;
  try { await browser.runtime.sendMessage({ type: "popup.expand", tabId, jobId: activeJobId }); }
  catch (error) { showError(error); }
  finally { actionPending = false; elements.expand.disabled = false; }
});

elements.apply.addEventListener("click", async () => {
  if (!suggestionId || actionPending) return;
  actionPending = true;
  elements.error.hidden = true;
  setBusy(true, "Applying…");
  try {
    const job = await browser.runtime.sendMessage({ type: "popup.apply", tabId, suggestionId, jobId: activeJobId });
    renderJob(job);
  } catch (error) {
    showError(error);
  } finally {
    actionPending = false;
    setBusy(false);
  }
});

elements.discard.addEventListener("click", async () => {
  if (!activeJobId || actionPending) return;
  actionPending = true;
  elements.error.hidden = true;
  setBusy(true, applied ? "Undoing change…" : "Discarding suggestion…");
  try {
    if (applied) {
      await browser.runtime.sendMessage({ type: "popup.undo", tabId, suggestionId, jobId: activeJobId });
      elements.status.textContent = "Change undone";
    } else {
      await browser.runtime.sendMessage({ type: "popup.discard", tabId, jobId: activeJobId });
      window.close();
      return;
    }
    suggestionId = undefined;
    activeJobId = undefined;
    currentResult = undefined; lastRendered = "";
    if (pollTimer) clearTimeout(pollTimer);
    applied = false;
    elements.preview.hidden = true;
  } catch (error) {
    showError(error);
  } finally {
    actionPending = false;
    setBusy(false);
  }
});

window.addEventListener("unload", () => {
  pollGeneration += 1;
  if (pollTimer) clearTimeout(pollTimer);
  stopElapsed();
});

updateAction();
void initialize().catch(showError);
