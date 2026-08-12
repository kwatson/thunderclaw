const elements = {
  status: document.querySelector("#status"),
  agent: document.querySelector("#agent"),
  action: document.querySelector("#action"),
  instruction: document.querySelector("#instruction"),
  run: document.querySelector("#run"),
  preview: document.querySelector("#preview"),
  replacement: document.querySelector("#replacement"),
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

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
  elements.status.textContent = "Unavailable";
  setBusy(false);
}

function setBusy(busy, label) {
  elements.run.disabled = busy || !elements.agent.value;
  elements.apply.disabled = busy || applied;
  elements.discard.disabled = busy;
  if (label) elements.status.textContent = label;
}

function renderReplacement(result) {
  elements.replacement.replaceChildren();
  if (result.selectionShape === "flat-list-items") {
    if ((result.listKind !== "ul" && result.listKind !== "ol") || !Array.isArray(result.replacementItems)) {
      throw new Error("The structured list preview is invalid.");
    }
    const list = document.createElement(result.listKind);
    for (const item of result.replacementItems) {
      if (typeof item !== "string") throw new Error("The structured list preview is invalid.");
      const listItem = document.createElement("li");
      listItem.textContent = item;
      list.append(listItem);
    }
    elements.replacement.append(list);
    return;
  }
  if (result.selectionShape === "rich-blocks") {
    if (!Array.isArray(result.replacementBlocks)) throw new Error("The structured rich preview is invalid.");
    const appendSpans = (parent, spans) => {
      if (!Array.isArray(spans)) throw new Error("The structured rich preview is invalid.");
      for (const span of spans) {
        if (!span || typeof span.text !== "string") throw new Error("The structured rich preview is invalid.");
        let node = document.createTextNode(span.text);
        for (const mark of [...(span.marks ?? [])].reverse()) {
          const element = document.createElement(mark === "bold" ? "b" : mark === "italic" ? "i" : mark === "underline" ? "u" : "invalid");
          if (element.localName === "invalid") throw new Error("The structured rich preview is invalid.");
          element.append(node); node = element;
        }
        parent.append(node);
      }
    };
    for (const block of result.replacementBlocks) {
      if (block.type === "paragraph") {
        const paragraph = document.createElement("p"); appendSpans(paragraph, block.spans); elements.replacement.append(paragraph);
      } else if (block.type === "unordered_list" || block.type === "ordered_list") {
        const list = document.createElement(block.type === "unordered_list" ? "ul" : "ol");
        for (const value of block.items ?? []) {
          const item = document.createElement("li"); appendSpans(item, value.spans); list.append(item);
        }
        elements.replacement.append(list);
      } else throw new Error("The structured rich preview is invalid.");
    }
    return;
  }
  elements.replacement.textContent = result.replacement;
}

function renderJob(job) {
  if (!job) return;
  activeJobId = job.jobId;
  if (job.state === "running") {
    suggestionId = undefined;
    applied = false;
    elements.preview.hidden = true;
    setBusy(true, "Generating preview…");
    return;
  }
  setBusy(false);
  if (job.state === "error") {
    showError(new Error(job.error || "Preview generation failed."));
    return;
  }
  if (job.state === "ready" && job.result) {
    applied = false;
    suggestionId = job.result.suggestionId;
    renderReplacement(job.result);
    elements.summary.textContent = job.result.summary;
    elements.preview.hidden = false;
    elements.apply.textContent = "Apply to draft";
    elements.apply.disabled = false;
    elements.discard.textContent = "Start over";
    elements.status.textContent = "Preview ready";
  }
  if (job.state === "applied" && job.result) {
    applied = true;
    suggestionId = job.result.suggestionId;
    renderReplacement(job.result);
    elements.summary.textContent = job.result.summary;
    elements.preview.hidden = false;
    elements.apply.textContent = "Applied";
    elements.apply.disabled = true;
    elements.discard.textContent = "Undo change";
    elements.discard.disabled = false;
    elements.status.textContent = "Applied — Thunderbird still controls Send";
  }
}

async function pollJob() {
  const job = await browser.runtime.sendMessage({ type: "popup.job", tabId });
  if (!job || job.jobId !== activeJobId) return;
  renderJob(job);
  if (job.state === "running") pollTimer = setTimeout(() => void pollJob().catch(showError), 500);
}

async function initialize() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error("Open ThunderClaw from a message compose window.");
  tabId = tabs[0].id;
  const state = await browser.runtime.sendMessage({ type: "popup.initialize", tabId });
  for (const agent of state.agents) {
    const option = document.createElement("option");
    option.value = agent.agentId;
    const verification = agent.compatibility?.state === "verified" ? "" : ` (${agent.compatibility?.state || "unverified"})`;
    option.textContent = agent.model ? `${agent.displayName} — ${agent.model}${verification}` : `${agent.displayName}${verification}`;
    option.selected = agent.agentId === state.selectedAgentId;
    elements.agent.append(option);
  }
  if (!state.agents.length) throw new Error("No compatible OpenClaw agents are available.");
  elements.agent.disabled = false;
  elements.run.disabled = false;
  elements.status.textContent = `${state.selection.text.length} characters selected`;
  if (state.job) {
    renderJob(state.job);
    if (state.job.state === "running") void pollJob().catch(showError);
  }
}

elements.run.addEventListener("click", async () => {
  elements.error.hidden = true;
  elements.preview.hidden = true;
  suggestionId = undefined;
  applied = false;
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
    if (job.state === "running") void pollJob().catch(showError);
  } catch (error) {
    showError(error);
  }
});

elements.apply.addEventListener("click", async () => {
  if (!suggestionId) return;
  elements.error.hidden = true;
  setBusy(true, "Applying…");
  try {
    const job = await browser.runtime.sendMessage({ type: "popup.apply", tabId, suggestionId, jobId: activeJobId });
    renderJob(job);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

elements.discard.addEventListener("click", async () => {
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
    applied = false;
    elements.preview.hidden = true;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
});

window.addEventListener("unload", () => {
  if (pollTimer) clearTimeout(pollTimer);
});

void initialize().catch(showError);
