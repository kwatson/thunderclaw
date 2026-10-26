import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function popupHarness(name: "popup" | "message-popup", agent: Record<string, string> = { agentId: "model", model: "model" }, initialJob?: any) {
  const elements = new Map<string, any>();
  const calls: any[] = [];
  const element = (selector: string): any => {
    if (!elements.has(selector)) {
      const attributes = new Map<string, string>();
      elements.set(selector, {
        value: "", textContent: "", hidden: false, disabled: false, children: [] as any[],
        listeners: new Map<string, (event?: unknown) => unknown>(), attributes,
        addEventListener(type: string, listener: (event?: unknown) => unknown) { this.listeners.set(type, listener); },
        setAttribute(key: string, value: string) { attributes.set(key, value); },
        removeAttribute(key: string) { attributes.delete(key); },
        focus() { this.focused = true; },
        append(child: any) { if (selector === "#agent") { this.value = child.value; this.children.push(child); } },
        replaceChildren() {},
      });
    }
    return elements.get(selector);
  };
  element("#action").value = name === "popup" ? "improve" : "summarize";
  const tabs = ["changes", "original", "proposed"].map((view) => ({ dataset: { view }, attributes: new Map<string, string>(), listeners: new Map<string, () => void>(), addEventListener(key: string, listener: () => void) { this.listeners.set(key, listener); }, setAttribute(key: string, value: string) { this.attributes.set(key, value); } }));
  const windowListeners = new Map<string, () => void>();
  const rendered: string[] = [];
  let currentJob = initialJob;
  let transformResult: any;
  let cancelResult: any;
  let holdNextJob: Promise<void> | undefined;
  const source = await readFile(new URL(`../packages/thunderbird-extension/src/${name}.js`, import.meta.url), "utf8");
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll() { return tabs; }, createElement() { return {}; } },
    window: { addEventListener(type: string, listener: () => void) { windowListeners.set(type, listener); }, close() {} },
    ThunderClawPreview: { render(_root: unknown, _result: unknown, view: string) { rendered.push(view); } },
    browser: {
      tabs: { async query() { return [{ id: 1 }]; } },
      runtime: { async sendMessage(message: any) {
        calls.push(structuredClone(message));
        if (message.type.endsWith(".initialize")) return {
          agents: [agent], selectedAgentId: agent.agentId,
          selection: { text: "Draft" }, preferredLanguage: "English", capture: { characters: 5 },
          detected: { languages: [{ language: "fr" }] },
          job: currentJob,
        };
        if (message.type.endsWith(".job")) { const answer = currentJob; const hold = holdNextJob; holdNextJob = undefined; if (hold) await hold; return answer; }
        if (message.type.endsWith(".cancel")) { currentJob = cancelResult ?? { ...currentJob, state: "cancelled" }; return currentJob; }
        if (message.type === "popup.expand") return { opened: true };
        if (message.type.endsWith(".transform") && transformResult) { currentJob = transformResult; return currentJob; }
        return { jobId: "job", state: "error", error: "Synthetic completion" };
      } },
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { calls, element, tabs, rendered, unload() { windowListeners.get("unload")?.(); },
    poll: () => vm.runInContext("pollJob()", context) as Promise<void>,
    holdJobReply(value: Promise<void>) { holdNextJob = value; },
    setTransformResult(value: any) { transformResult = value; },
    setCancelResult(value: any) { cancelResult = value; },
    pollHandle: () => vm.runInContext("pollTimer", context),
    async emit(selector: string, type: string) { await element(selector).listeners.get(type)?.(); },
    emitTab(view: string) { tabs.find((tab) => tab.dataset.view === view)?.listeners.get("click")?.(); } };
}

test("both popups shorten only the full Fireworks model path prefix for display", async () => {
  const prefix = "accounts/fireworks/models/";
  for (const name of ["popup", "message-popup"] as const) {
    for (const [provider, model, label] of [
      ["fireworks", `${prefix}deepseek-v4p1-flash-1017`, "deepseek-v4p1-flash-1017"],
      ["fireworks", "accounts/example/routers/email-router", "accounts/example/routers/email-router"],
      ["fireworks", "accounts/example/deployments/prod", "accounts/example/deployments/prod"],
      ["fireworks", prefix, prefix],
      ["custom", `${prefix}deepseek-v4p1-flash-1017`, "deepseek-v4p1-flash-1017"],
      ["fireworks", `prefix/${prefix}deepseek-v4p1-flash-1017`, `prefix/${prefix}deepseek-v4p1-flash-1017`],
    ]) {
      const h = await popupHarness(name, { agentId: "configured-model", provider, model });
      const option = h.element("#agent").children[0];
      assert.equal(option.textContent, label);
      assert.equal(option.value, "configured-model", "presentation does not change the selected agent identity");
    }
  }
});

test("compose review starts on Changes, switches views, and expands the exact job", async () => {
  const job = { jobId: "job-1", state: "ready", startedAt: Date.now() - 3_000, result: { suggestionId: "suggestion-1", original: "Old", replacement: "New", summary: "Updated.", selectionShape: "text-range" } };
  const h = await popupHarness("popup", { agentId: "configured-model", model: "model" }, job);
  try {
    assert.deepEqual(h.rendered, ["changes"]);
    h.emitTab("proposed");
    assert.deepEqual(h.rendered, ["changes", "proposed"]);
    await h.emit("#expand", "click");
    assert.deepEqual(h.calls.at(-1), { type: "popup.expand", tabId: 1, jobId: "job-1" });
    assert.equal(h.element("#preview").hidden, false);
  } finally { h.unload(); }
});

test("reopened compose and message runs show elapsed time and cancel their exact job", async () => {
  for (const name of ["popup", "message-popup"] as const) {
    const h = await popupHarness(name, { agentId: "configured-model", model: "model" }, { jobId: "running-job", state: "running", action: "translate", startedAt: Date.now() - 3_000 });
    try {
      assert.match(h.element("#elapsed").textContent, /Elapsed: [34]s/u);
      assert.equal(h.element("#run-progress").hidden, false);
      await h.emit("#cancel", "click");
      assert.deepEqual(h.calls.at(-1), { type: name === "popup" ? "popup.cancel" : "messagePopup.cancel", tabId: 1, jobId: "running-job" });
      assert.equal(h.element("#run-progress").hidden, true);
      assert.match(h.element("#status").textContent, /Cancelled/u);
    } finally { h.unload(); }
  }
});

test("Cancel keeps polling when completion wins the race", async () => {
  for (const [name, state] of [["popup", "ready"], ["message-popup", "finishing"]] as const) {
    const running = { jobId: "job-1", state: "running", action: "summarize", startedAt: Date.now() - 2_000 };
    const h = await popupHarness(name, { agentId: "model", model: "model" }, running);
    try {
      const before = h.pollHandle();
      h.setCancelResult({ ...running, state, result: state === "ready" ? {
        suggestionId: "suggestion-1", original: "Old", replacement: "New", summary: "Updated.", selectionShape: "text-range",
      } : undefined });
      await h.emit("#cancel", "click");
      assert.notEqual(h.pollHandle(), before, `${name} must replace its invalidated poll`);
    } finally { h.unload(); }
  }
});

test("late old-job polls cannot erase a newer compose or received-message run", async () => {
  for (const name of ["popup", "message-popup"] as const) {
    const old = { jobId: "old-job", state: name === "popup" ? "ready" : "running", action: "translate", startedAt: Date.now() - 2_000,
      result: { suggestionId: "old-suggestion", original: "Old", replacement: "New", summary: "Updated.", selectionShape: "text-range" } };
    const h = await popupHarness(name, { agentId: "configured-model", model: "model" }, old);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    try {
      h.holdJobReply(hold);
      const stalePoll = h.poll();
      if (name === "message-popup") await h.emit("#cancel", "click");
      h.setTransformResult({ jobId: "new-job", state: "running", action: "translate", startedAt: Date.now() });
      await h.emit("#run", "click");
      release(); await stalePoll;
      assert.equal(h.element("#run-progress").hidden, false);
      assert.match(h.element("#status").textContent, /Generating preview|Translating message/u);
      await h.emit("#cancel", "click");
      assert.equal(h.calls.at(-1).jobId, "new-job");
    } finally { release(); h.unload(); }
  }
});

test("compose action prompts identify missing tone, language and custom instructions before sending", async () => {
  const h = await popupHarness("popup");
  for (const [action, label, placeholder, error] of [
    ["tone", "Desired tone (required)", "warm and professional", "Describe the tone you want"],
    ["translate", "Target language (required)", "Spanish", "Enter a target language"],
    ["ask", "Instruction (required)", "Describe how to revise", "Enter an instruction"],
  ]) {
    h.element("#action").value = action;
    await h.emit("#action", "change");
    assert.equal(h.element("#instruction-label").textContent, label);
    assert.ok(h.element("#instruction").placeholder.includes(placeholder!));
    assert.equal(h.element("#instruction").required, true);
    h.element("#instruction").value = " \n ";
    await h.emit("#run", "click");
    assert.equal(h.element("#instruction").focused, true);
    assert.equal(h.element("#instruction").attributes.get("aria-invalid"), "true");
    assert.ok(h.element("#error").textContent.includes(error!));
    assert.equal(h.calls.some((message) => message.type === "popup.transform"), false);
  }
});

test("compose action prompts preserve freeform instructions and optional default actions", async () => {
  const h = await popupHarness("popup");
  for (const [action, instruction] of [["tone", "Warm, concise and reassuring"], ["translate", "To French; preserve product names"], ["ask", "Use three paragraphs"], ["improve", ""]]) {
    h.element("#action").value = action;
    await h.emit("#action", "change");
    h.element("#instruction").value = ` ${instruction} `;
    await h.emit("#run", "click");
    const sent = h.calls.at(-1);
    assert.equal(sent.type, "popup.transform");
    assert.equal(sent.action, action);
    assert.equal(sent.instruction, instruction);
  }
  assert.equal(h.element("#instruction").required, false);
  assert.equal(h.element("#instruction-label").textContent, "Instruction (optional)");
});

test("received message translation accepts Auto-detect source without requiring a source language", async () => {
  const h = await popupHarness("message-popup");
  h.element("#action").value = "translate";
  await h.emit("#action", "change");
  assert.equal(h.element("#source-language").placeholder, "Auto-detect (fr)");
  for (const source of ["", "Auto-detect", "AUTO-DETECT", "French"]) {
    h.element("#source-language").value = source;
    await h.emit("#run", "click");
    const sent = h.calls.at(-1);
    assert.equal(sent.type, "messagePopup.transform");
    assert.equal(sent.sourceLanguage, source === "French" ? "French" : null);
    assert.equal(sent.targetLanguage, "English");
  }
  h.element("#target-language").value = " ";
  const count = h.calls.length;
  await h.emit("#run", "click");
  assert.equal(h.calls.length, count);
  assert.equal(h.element("#error").textContent, "Choose a target language.");
});
