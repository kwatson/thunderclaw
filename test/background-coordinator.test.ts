import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionBinding, ThunderClawDirectClient } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { installFeatureBackground } from "../packages/thunderbird-extension/src/background-coordinator.js";
import type { BackgroundFeatureLease, ConnectionController, FeatureRetirementHandler } from "../packages/thunderbird-extension/src/connection-controller.js";

const binding: ConnectionBinding = {
  apiBase: "https://gateway.example/thunderclaw/v1",
  origin: "https://gateway.example",
  permissionId: "https://gateway.example/*",
  epoch: 7,
  credential: { mode: "device_credential", credentialId: "device-a" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (accept(value)) return value;
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return read();
}

function harness() {
  const runtimeListeners: Array<(message: any) => unknown> = [];
  const removedListeners: Array<(tabId: number) => unknown> = [];
  const displayedListeners: Array<(tab: { id: number }) => unknown> = [];
  const calls: any[] = [];
  const cancels: any[] = [];
  const closes: any[] = [];
  const storage: Record<string, unknown> = {};
  let current = true;
  let retirement: FeatureRetirementHandler | undefined;
  let displayed = { id: 41, subject: "Subject", author: "sender@example.test" };
  let displayInstanceId = "display-a";
  let messageText = "Bonjour";
  let composeText = "Draft";
  let composeSelection: any = { selectionShape: "text-range" };
  let flatListCapability: any = undefined;
  let richBlockCapability: any = undefined;
  let composeDetails: any = { subject: "Subject", to: [], cc: [], bcc: [], replyTo: [], deliveryFormat: null, isPlainText: false };
  let attachments: any[] = [];
  let composeInspectError: string | undefined;
  let transformMessageImpl: ThunderClawDirectClient["transformMessage"] = async () => { throw new Error("unexpected message transform"); };
  let transformComposeImpl: ThunderClawDirectClient["transformCompose"] = async () => { throw new Error("unexpected compose transform"); };

  const client = {
    binding,
    async hello() { return { binding, value: { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "test",
      capabilities: { ...(flatListCapability === undefined ? {} : { flatListItemReplacement: flatListCapability }),
        ...(richBlockCapability === undefined ? {} : { richBlockReplacement: richBlockCapability }) } } }; },
    async status() { throw new Error("unexpected status"); },
    async listAgents(requestId: string) { calls.push(["list-agents"]); return { binding, value: { protocolVersion: 1, requestId, agents: [{
      agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider", model: "model",
      reasoning: { defaultLevel: null, levels: [] }, compatibility: { state: "verified" },
    }] } } as any; },
    async probeAgent() { throw new Error("unexpected agent probe"); },
    async cancelAgentProbe() { throw new Error("unexpected agent probe cancellation"); },
    async openCompose(request: any) { calls.push(["open", structuredClone(request)]); return { binding, value: { ...request, sessionId: "session-a" } }; },
    transformCompose(request: any, options?: any) { calls.push(["compose-transform", structuredClone(request), options]); return transformComposeImpl(request, options); },
    async cancelComposeRun(request: any) { cancels.push(structuredClone(request)); return { binding, value: { protocolVersion: 1, requestId: request.requestId, runId: request.runId, cancelled: true } }; },
    async closeCompose(request: any) { closes.push(structuredClone(request)); return { binding, value: { protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, closed: true } }; },
    transformMessage(request: any, options?: any) { calls.push(["message-transform", structuredClone(request), options]); return transformMessageImpl(request, options); },
    async cancelMessageTransform(request: any) { cancels.push(structuredClone(request)); return { binding, value: { ...request, cancelled: true } }; },
  } as ThunderClawDirectClient;
  const lease: BackgroundFeatureLease = { client, binding };
  const controller = {
    async acquireFeatureLease() { calls.push(["acquire"]); return lease; },
    isFeatureBindingCurrent(candidate: ConnectionBinding) { return current && candidate.epoch === binding.epoch; },
    addFeatureRetirementHandler(handler: FeatureRetirementHandler) { retirement = handler; return () => undefined; },
  } as unknown as ConnectionController;

  const browser = {
    runtime: { onMessage: { addListener(listener: any) { runtimeListeners.push(listener); } } },
    tabs: {
      async sendMessage(_tabId: number, message: any) {
        calls.push(["tab-message", structuredClone(message)]);
        if (message.type === "thunderclaw.inspect" && composeInspectError) return { ok: false, error: composeInspectError };
        if (message.type === "thunderclaw.capture" || message.type === "thunderclaw.inspect") {
          return { ok: true, value: { targetId: "target-a", text: composeText, authoredText: composeText, ...composeSelection } };
        }
        if (message.type === "thunderclaw.apply") {
          if (message.expectedText !== composeText) return { ok: false, error: "stale" };
          composeText = message.replacement;
          return { ok: true, value: { undoId: "undo-a" } };
        }
        if (message.type === "thunderclaw.undo") return { ok: true, value: { undone: true } };
        if (message.type === "thunderclaw.message.capture") return { ok: true, value: {
          displayInstanceId, segments: [{ id: "segment-0", text: messageText }], text: messageText,
        } };
        return { ok: true, value: { accepted: true } };
      },
      onRemoved: { addListener(listener: any) { removedListeners.push(listener); } },
    },
    compose: {
      async getComposeDetails() { return structuredClone(composeDetails); },
      async listAttachments() { return structuredClone(attachments); },
    },
    messageDisplay: {
      async getDisplayedMessage() { return displayed; },
      onMessageDisplayed: { addListener(listener: any) { displayedListeners.push(listener); } },
    },
    storage: { local: {
      async get(keys: string | string[]) { const list = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(list.filter((key) => Object.hasOwn(storage, key)).map((key) => [key, storage[key]])); },
      async set(values: Record<string, unknown>) { Object.assign(storage, values); },
    } },
    i18n: {
      async getAcceptLanguages() { return ["en-US"]; }, async getUILanguage() { return "en-US"; },
      async detectLanguage() { return { languages: [{ language: "fr", percentage: 100 }], isReliable: true }; },
    },
    scripting: {
      async executeScript() {},
      messageDisplay: { async getRegisteredScripts() { return [{ id: "thunderclaw-message-display" }]; }, async registerScripts() {} },
    },
  };

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "browser");
  Object.defineProperty(globalThis, "browser", { configurable: true, value: browser });
  installFeatureBackground(controller);
  return {
    calls, cancels, closes, storage, binding, client,
    setCurrent(value: boolean) { current = value; },
    setDisplayed(value: typeof displayed) { displayed = value; },
    setDisplayInstanceId(value: string) { displayInstanceId = value; },
    setMessageText(value: string) { messageText = value; },
    setComposeText(value: string) { composeText = value; },
    setComposeSelection(value: any) { composeSelection = value; },
    setFlatListCapability(value: any) { flatListCapability = value; },
    setRichBlockCapability(value: any) { richBlockCapability = value; },
    setComposeDetails(value: any) { composeDetails = value; },
    setAttachments(value: any[]) { attachments = value; },
    setComposeInspectError(value: string | undefined) { composeInspectError = value; },
    setTransformMessage(value: typeof transformMessageImpl) { transformMessageImpl = value; },
    setTransformCompose(value: typeof transformComposeImpl) { transformComposeImpl = value; },
    async send(message: any): Promise<any> {
      for (const listener of runtimeListeners) {
        const result = listener(message);
        if (result !== undefined) return await result;
      }
      return undefined;
    },
    emitDisplayed(tabId: number) { for (const listener of displayedListeners) listener({ id: tabId }); },
    emitRemoved(tabId: number) { for (const listener of removedListeners) listener(tabId); },
    async retire() { current = false; await retirement?.(lease); },
    restore() { if (descriptor) Object.defineProperty(globalThis, "browser", descriptor); else Reflect.deleteProperty(globalThis, "browser"); },
  };
}

test("feature selectors expose only verified agents and explicitly label partial verification", async () => {
  const h = harness();
  try {
    (h.client as any).listAgents = async (requestId: string) => ({ binding, value: {
      protocolVersion: 1, requestId,
      agents: ["verified", "partially_verified", "unverified", "incompatible", "unsupported"].map((state, index) => ({
        agentId: `agent-${index}`, displayName: `Agent ${index}`, isDefault: index === 2, provider: "provider", model: "model",
        reasoning: { defaultLevel: null, levels: [] }, compatibility: { state },
      })),
    } });
    const compose = await h.send({ type: "popup.initialize", tabId: 1 });
    assert.deepEqual(compose.agents.map((agent: any) => agent.agentId), ["agent-0", "agent-1"]);
    assert.equal(compose.agents[1].displayName, "Agent 1 (partially verified)");
    assert.equal(compose.selectedAgentId, "agent-0", "an unavailable default cannot be selected");
    const message = await h.send({ type: "messagePopup.initialize", tabId: 2 });
    assert.deepEqual(message.agents.map((agent: any) => agent.agentId), ["agent-0", "agent-1"]);
    assert.equal(message.agents[1].displayName, "Agent 1 (partially verified)");
  } finally { h.restore(); }
});

test("compose rechecks authoritative eligibility and rejects stale or forged agent selections before session start", async () => {
  const h = harness();
  const stale = deferred<any>();
  const record = (agentId: string, state: string) => ({
    agentId, displayName: agentId, isDefault: true, provider: "provider", model: "model",
    reasoning: { defaultLevel: null, levels: [] }, compatibility: { state },
  });
  try {
    await h.send({ type: "popup.initialize", tabId: 20 });
    (h.client as any).listAgents = async () => stale.promise;
    const running = await h.send({ type: "popup.transform", tabId: 20, agentId: "agent-a", action: "improve", instruction: "" });
    assert.equal(running.state, "running");
    await settle();
    stale.resolve({ binding, value: { protocolVersion: 1, requestId: "fresh-list", agents: [record("agent-a", "unverified")] } });
    const failed = await eventually(() => h.send({ type: "popup.job", tabId: 20 }), (job) => job?.state === "error");
    assert.match(failed.error, /not verified for the current configuration/u);
    assert.equal(h.calls.some(([kind]) => kind === "open" || kind === "compose-transform"), false);

    await h.send({ type: "popup.initialize", tabId: 21 });
    (h.client as any).listAgents = async (requestId: string) => ({ binding, value: {
      protocolVersion: 1, requestId, agents: [record("agent-a", "verified")],
    } });
    const forged = await h.send({ type: "popup.transform", tabId: 21, agentId: "forged-agent", action: "improve", instruction: "" });
    const forgedFailure = await eventually(() => h.send({ type: "popup.job", tabId: 21 }), (job) => job?.state === "error");
    assert.equal(forgedFailure.jobId, forged.jobId);
    assert.match(forgedFailure.error, /not verified for the current configuration/u);
    assert.equal(h.calls.some(([kind, request]) => kind === "open" && request.agentId === "forged-agent"), false);
  } finally { h.restore(); }
});

test("compose capture and inspect reject unsupported current selections before any feature lease or network call", async () => {
  for (const initialized of [false, true]) {
    const h = harness();
    try {
      if (initialized) await h.send({ type: "popup.initialize", tabId: 120 });
      h.calls.splice(0);
      h.setComposeInspectError(initialized
        ? "The original list selection changed. Run ThunderClaw again."
        : "Whole-list editing currently requires plain text list items.");
      await assert.rejects(
        h.send({ type: "popup.transform", tabId: 120, agentId: "agent-a", action: "improve", instruction: "" }),
        /list selection changed|plain text list items/u,
      );
      assert.equal(h.calls.some(([kind]) => ["acquire", "list-agents", "open", "compose-transform"].includes(kind)), false,
        `network-capable work started before ${initialized ? "stale inspect" : "direct capture"} rejection`);
    } finally { h.restore(); }
  }
});

test("flat-list transforms require the exact current connection capability before session or model work", async () => {
  for (const capability of [undefined, false, "true"]) {
    const h = harness();
    try {
      h.setComposeText("One\nTwo");
      h.setComposeSelection({ selectionShape: "flat-list-items", listKind: "ul", items: ["One", "Two"] });
      h.setFlatListCapability(capability);
      const running = await h.send({ type: "popup.transform", tabId: 121, agentId: "agent-a", action: "improve", instruction: "" });
      const failed = await eventually(() => h.send({ type: "popup.job", tabId: 121 }), (job) => job?.state === "error");
      assert.equal(failed.jobId, running.jobId);
      assert.match(failed.error, /does not support flat-list item replacement/u);
      assert.equal(h.calls.some(([kind]) => ["list-agents", "open", "compose-transform"].includes(kind)), false);
    } finally { h.restore(); }
  }
});

test("flat-list preview preserves trusted local kind and independently validated item structure", async () => {
  const h = harness();
  try {
    h.setComposeText("One\nTwo");
    h.setComposeSelection({ selectionShape: "flat-list-items", listKind: "ol", items: ["One", "Two"] });
    h.setFlatListCapability(true);
    h.setTransformCompose(async (request: any) => ({ binding, value: {
      protocolVersion: 1, runId: request.runId,
      result: { version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration,
        contextHash: request.contextHash, targetHash: request.targetHash,
        operations: [{ type: "replace_flat_list_items", targetId: request.target.targetId, items: ["First", "Second", "Third"] }],
        summary: "Expanded" }, evidence: { runtimeSessionMarker: null, repairAttempted: false },
    } } as any));
    await h.send({ type: "popup.transform", tabId: 122, agentId: "agent-a", action: "improve", instruction: "" });
    const ready = await eventually(() => h.send({ type: "popup.job", tabId: 122 }), (job) => job?.state === "ready");
    assert.deepEqual({ shape: ready.result.selectionShape, kind: ready.result.listKind, items: ready.result.replacementItems },
      { shape: "flat-list-items", kind: "ol", items: ["First", "Second", "Third"] });
  } finally { h.restore(); }
});

test("rich-block preview preserves only the independently validated typed document", async () => {
  const h = harness();
  try {
    h.setComposeText("Original paragraphs");
    h.setComposeSelection({ selectionShape: "rich-blocks" });
    h.setRichBlockCapability(true);
    const blocks = [{ type: "unordered_list", items: [
      { spans: [{ text: "First" }] }, { spans: [{ text: "Second", marks: ["bold"] }] },
    ] }];
    h.setTransformCompose(async (request: any) => ({ binding, value: {
      protocolVersion: 1, runId: request.runId,
      result: { version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration,
        contextHash: request.contextHash, targetHash: request.targetHash,
        operations: [{ type: "replace_rich_blocks", targetId: request.target.targetId, blocks }], summary: "Structured" },
      evidence: { runtimeSessionMarker: null, repairAttempted: false },
    } } as any));
    await h.send({ type: "popup.transform", tabId: 222, agentId: "agent-a", action: "improve", instruction: "three bullets" });
    const ready = await eventually(() => h.send({ type: "popup.job", tabId: 222 }), (job) => job?.state === "ready");
    assert.equal(ready.result.selectionShape, "rich-blocks");
    assert.deepEqual(ready.result.replacementBlocks, blocks);
    await h.send({ type: "popup.apply", tabId: 222, suggestionId: ready.result.suggestionId, jobId: ready.jobId });
    const apply = h.calls.findLast(([kind, message]) => kind === "tab-message" && message.type === "thunderclaw.apply")?.[1];
    assert.deepEqual(apply.replacementBlocks, blocks);
    assert.equal("replacement" in apply, false);
  } finally { h.restore(); }
});

test("compose non-body fingerprint rejects header changes after generation and settings or attachments before Apply", async () => {
  const base = { subject: "Subject", to: ["to@example.test"], cc: [], bcc: [], replyTo: ["reply@example.test"], deliveryFormat: "auto", isPlainText: false };
  {
    const h = harness();
    try {
      h.setComposeDetails(base);
      h.setTransformCompose(async (request: any) => {
        h.setComposeDetails({ ...base, to: [], cc: ["to@example.test"] });
        return { binding, value: { protocolVersion: 1, runId: request.runId, result: {
          version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration,
          contextHash: request.contextHash, targetHash: request.targetHash,
          operations: [{ type: "replace_text_range", targetId: request.target.targetId, start: 0, end: 5, text: "Clear" }], summary: "ok",
        }, evidence: { runtimeSessionMarker: null, repairAttempted: false } } } as any;
      });
      await h.send({ type: "popup.transform", tabId: 123, agentId: "agent-a", action: "improve", instruction: "" });
      const failed = await eventually(() => h.send({ type: "popup.job", tabId: 123 }), (job) => job?.state === "error");
      assert.match(failed.error, /draft changed while ThunderClaw was generating/u);
    } finally { h.restore(); }
  }

  for (const mutate of [
    (h: ReturnType<typeof harness>) => h.setComposeDetails({ ...base, deliveryFormat: "plaintext" }),
    (h: ReturnType<typeof harness>) => h.setComposeDetails({ ...base, isPlainText: true }),
    (h: ReturnType<typeof harness>) => h.setAttachments([{ id: 7, name: "note.txt", size: 4 }]),
  ]) {
    const h = harness();
    try {
      h.setComposeDetails(base);
      h.setTransformCompose(async (request: any) => ({ binding, value: { protocolVersion: 1, runId: request.runId, result: {
        version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration,
        contextHash: request.contextHash, targetHash: request.targetHash,
        operations: [{ type: "replace_text_range", targetId: request.target.targetId, start: 0, end: 5, text: "Clear" }], summary: "ok",
      }, evidence: { runtimeSessionMarker: null, repairAttempted: false } } } as any));
      const started = await h.send({ type: "popup.transform", tabId: 124, agentId: "agent-a", action: "improve", instruction: "" });
      const ready = await eventually(() => h.send({ type: "popup.job", tabId: 124 }), (job) => job?.state === "ready");
      mutate(h);
      await assert.rejects(h.send({ type: "popup.apply", tabId: 124, suggestionId: ready.result.suggestionId, jobId: started.jobId }), /draft changed/u);
      assert.equal(h.calls.some(([kind, message]) => kind === "tab-message" && message.type === "thunderclaw.apply"), false);
    } finally { h.restore(); }
  }
});

test("post-generation exact inspect suppresses stale body, list-topology, and selection-direction previews", async () => {
  for (const error of [
    "The original selected text changed.",
    "The original list selection changed. Run ThunderClaw again.",
    "The original selection direction changed. Run ThunderClaw again.",
  ]) {
    const h = harness();
    try {
      h.setTransformCompose(async (request: any) => {
        h.setComposeInspectError(error);
        return { binding, value: { protocolVersion: 1, runId: request.runId, result: {
          version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration,
          contextHash: request.contextHash, targetHash: request.targetHash,
          operations: [{ type: "replace_text_range", targetId: request.target.targetId, start: 0, end: 5, text: "Clear" }], summary: "ok",
        }, evidence: { runtimeSessionMarker: null, repairAttempted: false } } } as any;
      });
      const started = await h.send({ type: "popup.transform", tabId: 125, agentId: "agent-a", action: "improve", instruction: "" });
      const failed = await eventually(() => h.send({ type: "popup.job", tabId: 125 }), (job) => job?.state === "error");
      assert.equal(failed.jobId, started.jobId);
      assert.match(failed.error, /selected text changed|list selection changed|selection direction changed/u);
      assert.notEqual(failed.state, "ready");
    } finally { h.restore(); }
  }
});

test("popup reopen never reattaches a ready preview after body, selection, header, or attachment drift", async () => {
  const mutations: Array<(h: ReturnType<typeof harness>) => void> = [
    (h) => h.setComposeInspectError("The original selected text changed."),
    (h) => h.setComposeInspectError("The original list selection changed."),
    (h) => h.setComposeInspectError("The original selection direction changed."),
    (h) => h.setComposeDetails({ subject: "Changed", to: [], cc: [], bcc: [], replyTo: [], deliveryFormat: null, isPlainText: false }),
    (h) => h.setAttachments([{ id: 9, name: "changed.txt", size: 7 }]),
  ];
  for (const mutate of mutations) {
    const h = harness();
    try {
      h.setTransformCompose(async (request: any) => ({ binding, value: { protocolVersion: 1, runId: request.runId, result: {
        version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration,
        contextHash: request.contextHash, targetHash: request.targetHash,
        operations: [{ type: "replace_text_range", targetId: request.target.targetId, start: 0, end: 5, text: "Clear" }], summary: "ok",
      }, evidence: { runtimeSessionMarker: null, repairAttempted: false } } } as any));
      await h.send({ type: "popup.transform", tabId: 126, agentId: "agent-a", action: "improve", instruction: "" });
      const ready = await eventually(() => h.send({ type: "popup.job", tabId: 126 }), (job) => job?.state === "ready");
      assert.equal(ready.state, "ready");
      mutate(h);
      const reopened = await h.send({ type: "popup.initialize", tabId: 126 });
      assert.equal(reopened.job.state, "error");
      assert.match(reopened.job.error, /draft changed after this preview/u);
      assert.equal(reopened.job.result, undefined);
    } finally { h.restore(); }
  }
});

test("message runs recheck authoritative eligibility and reject stale or forged agents before model execution", async () => {
  const h = harness();
  const stale = deferred<any>();
  const record = (agentId: string, state: string) => ({
    agentId, displayName: agentId, isDefault: true, provider: "provider", model: "model",
    reasoning: { defaultLevel: null, levels: [] }, compatibility: { state },
  });
  try {
    await h.send({ type: "messagePopup.initialize", tabId: 22 });
    (h.client as any).listAgents = async () => stale.promise;
    const starting = h.send({ type: "messagePopup.transform", tabId: 22, agentId: "agent-a", action: "translate", sourceLanguage: null, targetLanguage: "English" });
    await settle();
    stale.resolve({ binding, value: { protocolVersion: 1, requestId: "fresh-list", agents: [record("agent-a", "unverified")] } });
    await assert.rejects(starting, /not verified for the current configuration/u);
    assert.equal(h.calls.some(([kind]) => kind === "message-transform"), false);

    (h.client as any).listAgents = async (requestId: string) => ({ binding, value: {
      protocolVersion: 1, requestId, agents: [record("agent-a", "verified")],
    } });
    await assert.rejects(
      h.send({ type: "messagePopup.transform", tabId: 22, agentId: "forged-agent", action: "translate", sourceLanguage: null, targetLanguage: "English" }),
      /not verified for the current configuration/u,
    );
    assert.equal(h.calls.some(([kind]) => kind === "message-transform"), false);
  } finally { h.restore(); }
});

test("compose jobs survive popup closure but stale popup action identities cannot affect the current job", async () => {
  const h = harness();
  const completion = deferred<any>();
  try {
    h.setTransformCompose(async () => completion.promise);
    await h.send({ type: "popup.initialize", tabId: 1 });
    const running = await h.send({ type: "popup.transform", tabId: 1, agentId: "agent-a", action: "improve", instruction: "" });
    assert.equal(running.state, "running");
    assert.deepEqual(await h.send({ type: "popup.job", tabId: 1 }), running, "popup reopening observes the background-owned job");
    await assert.rejects(h.send({ type: "popup.discard", tabId: 1, jobId: "stale-job" }), /no longer current/u);
    assert.equal((await h.send({ type: "popup.job", tabId: 1 })).jobId, running.jobId);
    const missingJobIdWasAccepted = await h.send({ type: "popup.discard", tabId: 1 }).then(() => true, () => false);
    if (await h.send({ type: "popup.job", tabId: 1 })) {
      await h.send({ type: "popup.discard", tabId: 1, jobId: running.jobId });
    }
    assert.equal(await h.send({ type: "popup.job", tabId: 1 }), null);
    assert.equal(missingJobIdWasAccepted, false, "state-changing popup actions require an exact jobId");
  } finally { h.restore(); }
});

test("late compose success and failure are suppressed after discard and connection retirement", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const h = harness();
    const completion = deferred<any>();
    try {
      h.setTransformCompose(async () => {
        const value = await completion.promise;
        if (outcome === "failure") throw new Error("late private failure");
        return value;
      });
      await h.send({ type: "popup.initialize", tabId: 2 });
      const running = await h.send({ type: "popup.transform", tabId: 2, agentId: "agent-a", action: "improve", instruction: "" });
      await h.send({ type: "popup.discard", tabId: 2, jobId: running.jobId });
      await h.retire();
      completion.resolve({ binding, value: { operations: [{ type: "replace_text_range", targetId: "target-a", start: 0, end: 5, text: "Revised" }], summary: "ok" } });
      await settle();
      assert.equal(await h.send({ type: "popup.job", tabId: 2 }), null);
      assert.equal(h.calls.some(([kind, message]) => kind === "tab-message" && message.type === "thunderclaw.apply"), false);
    } finally { h.restore(); }
  }
});

test("Apply and Undo require the exact current job and suggestion identities", async () => {
  const h = harness();
  try {
    h.setTransformCompose(async (request: any) => ({ binding, value: {
      protocolVersion: 1,
      runId: request.runId,
      result: {
        version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration,
        contextHash: request.contextHash, targetHash: request.targetHash,
        operations: [{ type: "replace_text_range", targetId: request.target.targetId, start: 0, end: 5, text: "Clear" }],
        summary: "Improved",
      },
      evidence: { runtimeSessionMarker: null, repairAttempted: false },
    } } as any));
    await h.send({ type: "popup.initialize", tabId: 5 });
    const started = await h.send({ type: "popup.transform", tabId: 5, agentId: "agent-a", action: "improve", instruction: "" });
    const ready = await eventually(() => h.send({ type: "popup.job", tabId: 5 }), (job) => job?.state === "ready");
    assert.equal(ready.jobId, started.jobId);
    const suggestionId = ready.result.suggestionId;
    await assert.rejects(h.send({ type: "popup.apply", tabId: 5, suggestionId: "wrong-suggestion", jobId: ready.jobId }), /no longer available/u);
    await assert.rejects(h.send({ type: "popup.apply", tabId: 5, suggestionId, jobId: "wrong-job" }), /no longer available/u);
    const missingApplyJobIdWasAccepted = await h.send({ type: "popup.apply", tabId: 5, suggestionId }).then(() => true, () => false);
    const applied = await h.send({ type: "popup.job", tabId: 5 });
    if (applied?.state !== "applied") await h.send({ type: "popup.apply", tabId: 5, suggestionId, jobId: ready.jobId });
    const missingUndoJobIdWasAccepted = await h.send({ type: "popup.undo", tabId: 5, suggestionId }).then(() => true, () => false);
    if (await h.send({ type: "popup.job", tabId: 5 })) await h.send({ type: "popup.undo", tabId: 5, suggestionId, jobId: ready.jobId });
    assert.equal(missingApplyJobIdWasAccepted, false, "Apply requires jobId as well as suggestionId");
    assert.equal(missingUndoJobIdWasAccepted, false, "Undo requires the exact applied jobId");
  } finally { h.restore(); }
});

test("display navigation cancels the exact captured server run and suppresses a late message completion", async () => {
  const h = harness();
  const completion = deferred<any>();
  try {
    h.setTransformMessage(async () => completion.promise);
    await h.send({ type: "messagePopup.initialize", tabId: 3 });
    const running = await h.send({ type: "messagePopup.transform", tabId: 3, agentId: "agent-a", action: "translate", sourceLanguage: null, targetLanguage: "English" });
    const transform = h.calls.find(([kind]) => kind === "message-transform")[1];
    h.emitDisplayed(3);
    await settle();
    assert.equal(h.cancels.length, 1);
    assert.deepEqual({ ...h.cancels[0], requestId: "fresh" }, { protocolVersion: 1, requestId: "fresh", transformRequestId: transform.requestId, runId: transform.runId, messageHash: transform.messageHash });
    assert.notEqual(h.cancels[0].requestId, transform.requestId);
    completion.resolve({ binding, value: { result: { version: 1, requestId: transform.requestId, messageHash: transform.messageHash, action: "translate", detectedLanguage: "fr", targetLanguage: "English", segments: [{ id: "segment-0", text: "Hello" }], summary: null } } });
    await settle();
    assert.equal(await h.send({ type: "messagePopup.job", tabId: 3 }), null);
    assert.equal(h.calls.some(([kind, message]) => kind === "tab-message" && message.type === "thunderclaw.message.translate"), false);
    assert.ok(running.jobId);
  } finally { h.restore(); }
});

test("message result actions require exact jobId and tab close sends exact server cancel", async () => {
  const h = harness();
  const completion = deferred<any>();
  try {
    h.setTransformMessage(async () => completion.promise);
    await h.send({ type: "messagePopup.initialize", tabId: 6 });
    const running = await h.send({ type: "messagePopup.transform", tabId: 6, agentId: "agent-a", action: "translate", sourceLanguage: null, targetLanguage: "English" });
    await assert.rejects(h.send({ type: "messagePopup.original", tabId: 6, jobId: "wrong-job" }), /no longer current/u);
    const missingJobIdWasAccepted = await h.send({ type: "messagePopup.original", tabId: 6 }).then(() => true, () => false);
    const request = h.calls.find(([kind]) => kind === "message-transform")[1];
    h.emitRemoved(6);
    await settle();
    assert.equal(h.cancels.length, 1);
    assert.deepEqual({ ...h.cancels[0], requestId: "fresh" }, { protocolVersion: 1, requestId: "fresh", transformRequestId: request.requestId, runId: request.runId, messageHash: request.messageHash });
    assert.notEqual(h.cancels[0].requestId, request.requestId);
    assert.equal(await h.send({ type: "messagePopup.job", tabId: 6 }), null);
    assert.equal(missingJobIdWasAccepted, false, "message mutation actions require an exact current jobId");
    assert.ok(running.jobId);
  } finally { h.restore(); }
});

test("message capture rejects metadata-to-DOM-to-metadata races and display instance changes", async () => {
  const h = harness();
  try {
    let reads = 0;
    const browser = (globalThis as any).browser;
    browser.messageDisplay.getDisplayedMessage = async () => (++reads === 1
      ? { id: 41, subject: "A", author: "a@example.test" }
      : { id: 42, subject: "B", author: "b@example.test" });
    await assert.rejects(h.send({ type: "messagePopup.initialize", tabId: 4 }), /changed while ThunderClaw was capturing/u);

    browser.messageDisplay.getDisplayedMessage = async () => ({ id: 41, subject: "A", author: "a@example.test" });
    h.setDisplayInstanceId("display-a");
    await h.send({ type: "messagePopup.initialize", tabId: 4 });
    const completion = deferred<any>();
    h.setTransformMessage(async () => completion.promise);
    const running = await h.send({ type: "messagePopup.transform", tabId: 4, agentId: "agent-a", action: "summarize", sourceLanguage: null, targetLanguage: "English" });
    const request = h.calls.findLast(([kind]) => kind === "message-transform")[1];
    h.setDisplayInstanceId("display-b");
    completion.resolve({ binding, value: { result: { version: 1, requestId: request.requestId, messageHash: request.messageHash, action: "summarize", detectedLanguage: "fr", targetLanguage: "English", segments: [], summary: { title: "Summary", bullets: ["One"] } } } });
    const failed = await eventually(
      () => h.send({ type: "messagePopup.job", tabId: 4 }),
      (job) => job?.state !== "running",
    );
    assert.equal(failed.jobId, running.jobId);
    assert.equal(failed.state, "error");
    assert.match(failed.error, /displayed message changed/u);
    assert.equal(h.calls.some(([kind, message]) => kind === "tab-message" && message.type === "thunderclaw.message.summary"), false);
  } finally { h.restore(); }
});
