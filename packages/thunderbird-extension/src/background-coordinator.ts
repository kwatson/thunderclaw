import { sameConnectionBinding } from "./direct-client-contract.js";
import type { ConnectionBinding, MessageTransformResult, RichBlock } from "./direct-client-contract.js";
import { DirectComposeLifecycleRegistry } from "./direct-client-lifecycle.js";
import type { BackgroundFeatureLease, ConnectionController } from "./connection-controller.js";
import { randomId } from "./random-id.js";

declare const browser: any;

type ComposeSession = {
  tabId: number;
  composeId: string;
  generation: number;
  agentId: string;
  lease: BackgroundFeatureLease;
  lifecycle: DirectComposeLifecycleRegistry;
  activeRunId?: string;
};

type ComposeJob = {
  jobId: string;
  state: "running" | "ready" | "applied" | "error";
  binding: ConnectionBinding;
  abort: AbortController;
  result?: { suggestionId: string; original: string; replacement: string; summary: string; applied?: true;
    selectionShape?: "text-range" | "flat-list-items" | "rich-blocks"; listKind?: "ul" | "ol";
    replacementItems?: string[]; replacementBlocks?: RichBlock[] };
  error?: string;
};

type MessageCapture = {
  displayInstanceId: string;
  messageId: number;
  subject: string;
  author: string;
  messageHash: string;
  segments: Array<{ id: string; text: string }>;
  text: string;
};

type MessageJob = {
  jobId: string;
  state: "running" | "ready" | "error";
  action: "translate" | "summarize";
  requestId: string;
  runId: string;
  messageId: number;
  messageHash: string;
  displayInstanceId: string;
  lease: BackgroundFeatureLease;
  abort: AbortController;
  result?: MessageTransformResult;
  error?: string;
};

export function installFeatureBackground(controller: ConnectionController): void {
  const minimumSameKindListThunderbirdMajor = 153;
  const runtimeCapabilityInstance = randomId();
  const runtimeCapability = Promise.resolve().then(() => browser.runtime.getBrowserInfo()).then((info: any) => {
    const match = /^([1-9]\d*)(?:\.\d+){1,3}(?:esr)?$/iu.exec(typeof info?.version === "string" ? info.version : "");
    const major = match ? Number.parseInt(match[1]!, 10) : undefined;
    return {
      instance: runtimeCapabilityInstance,
      minimumThunderbirdMajor: minimumSameKindListThunderbirdMajor,
      sameKindListEligible: Number.isSafeInteger(major) && major! >= minimumSameKindListThunderbirdMajor,
      richBlockEligible: Number.isSafeInteger(major) && major! >= minimumSameKindListThunderbirdMajor,
    };
  }).catch(() => ({
    instance: runtimeCapabilityInstance,
    minimumThunderbirdMajor: minimumSameKindListThunderbirdMajor,
    sameKindListEligible: false,
    richBlockEligible: false,
  }));
  const sessions = new Map<number, ComposeSession>();
  const pendingSessions = new Map<number, ComposeSession>();
  const suggestions = new Map<string, any>();
  const undos = new Map<string, any>();
  const captures = new Map<number, any>();
  const jobs = new Map<number, ComposeJob>();
  const messageJobs = new Map<number, MessageJob>();
  const messageCaptures = new Map<number, MessageCapture>();
  const lifecycles = new WeakMap<object, DirectComposeLifecycleRegistry>();

  function lifecycleFor(lease: BackgroundFeatureLease): DirectComposeLifecycleRegistry {
    let lifecycle = lifecycles.get(lease.client as object);
    if (!lifecycle) {
      // The registry is permanently scoped to this lease. The coordinator's
      // job gates reject retired completions, while this captured binding lets
      // retirement still send exact cancel/close through the old client.
      lifecycle = new DirectComposeLifecycleRegistry(lease.client, randomId, () => lease.binding);
      lifecycles.set(lease.client as object, lifecycle);
    }
    return lifecycle;
  }

  async function sha256(value: string): Promise<string> {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }

  function recipientText(recipient: any): string {
    if (typeof recipient === "string") return recipient;
    return recipient && typeof recipient === "object" ? recipient.email || recipient.name || "" : "";
  }

  async function composeContext(tabId: number, snapshot: any): Promise<any> {
    const details = await browser.compose.getComposeDetails(tabId);
    const recipients = [...(details.to || []), ...(details.cc || []), ...(details.bcc || [])].map(recipientText).filter(Boolean);
    const document = { subject: details.subject || "", recipients, authoredText: snapshot.authoredText, ...(snapshot.quotedText ? { quotedText: snapshot.quotedText } : {}) };
    return { document, contextHash: await sha256(JSON.stringify(document)) };
  }

  async function composeStateFingerprint(tabId: number): Promise<{ state: any; identity: string; hash: string }> {
    const [details, attachments] = await Promise.all([
      browser.compose.getComposeDetails(tabId),
      browser.compose.listAttachments(tabId),
    ]);
    const state = {
      subject: details.subject ?? "",
      to: details.to ?? [],
      cc: details.cc ?? [],
      bcc: details.bcc ?? [],
      replyTo: details.replyTo ?? [],
      deliveryFormat: details.deliveryFormat ?? null,
      isPlainText: details.isPlainText ?? null,
      attachments: (attachments ?? []).map((attachment: any) => ({
        id: attachment.id, name: attachment.name, size: attachment.size,
      })),
    };
    const identity = JSON.stringify(state);
    return { state, identity, hash: await sha256(identity) };
  }

  async function composeMessage(tabId: number, message: any): Promise<any> {
    const response = await browser.tabs.sendMessage(tabId, { ...message, runtimeCapability: await runtimeCapability });
    if (!response?.ok) throw new Error(response?.error || "The Thunderbird compose editor did not respond.");
    return response.value;
  }

  function bindingCurrent(binding: ConnectionBinding): boolean {
    return controller.isFeatureBindingCurrent(binding);
  }

  function validJobId(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
  }

  async function ensureSession(tabId: number, agentId: string, lease: BackgroundFeatureLease): Promise<ComposeSession> {
    const existing = sessions.get(tabId);
    if (existing?.agentId === agentId && sameConnectionBinding(existing.lease.binding, lease.binding)) return existing;
    const generation = existing ? existing.generation + 1 : 1;
    const composeId = existing?.composeId ?? randomId();
    if (existing) await existing.lifecycle.close(existing.composeId).catch(() => undefined);
    const session: ComposeSession = { tabId, composeId, generation, agentId, lease, lifecycle: lifecycleFor(lease) };
    pendingSessions.set(tabId, session);
    try {
      await session.lifecycle.open({ composeId, composeGeneration: generation, agentId });
      if (pendingSessions.get(tabId) !== session || !bindingCurrent(lease.binding)) {
        await session.lifecycle.close(composeId).catch(() => undefined);
        throw new Error("The compose session was replaced while it was opening.");
      }
      sessions.set(tabId, session);
      await browser.storage.local.set({ selectedAgentId: agentId });
      return session;
    } finally {
      if (pendingSessions.get(tabId) === session) pendingSessions.delete(tabId);
    }
  }

  function compatibleAgents(listed: any): any[] {
    return listed.agents
      .filter((agent: any) => ["verified", "partially_verified"].includes(agent.compatibility?.state))
      .map((agent: any) => agent.compatibility.state === "partially_verified"
        ? { ...agent, displayName: `${agent.displayName} (partially verified)` }
        : agent);
  }

  async function requireUsableAgent(lease: BackgroundFeatureLease, agentId: string, signal: AbortSignal): Promise<void> {
    const listed = await lease.client.listAgents(randomId(), { signal });
    if (!sameConnectionBinding(listed.binding, lease.binding) || !bindingCurrent(lease.binding)) {
      throw new Error("The ThunderClaw connection changed.");
    }
    const selected = listed.value.agents.find((agent: any) => agent.agentId === agentId);
    if (!selected || !["verified", "partially_verified"].includes(selected.compatibility?.state)) {
      throw new Error("The selected agent is not verified for the current configuration. Verify it in ThunderClaw settings.");
    }
  }

  async function validateSuggestionSnapshot(tabId: number, suggestion: any): Promise<any> {
    const current = await composeMessage(tabId, { type: "thunderclaw.inspect", targetId: suggestion.targetId });
    const [{ contextHash }, targetHash, composeState] = await Promise.all([
      composeContext(tabId, current), sha256(current.text), composeStateFingerprint(tabId),
    ]);
    if (contextHash !== suggestion.contextHash || targetHash !== suggestion.targetHash
        || composeState.hash !== suggestion.composeStateHash || composeState.identity !== suggestion.composeStateIdentity
        || !bindingCurrent(suggestion.binding)) {
      throw new Error("The draft changed after this suggestion was created. Run ThunderClaw again.");
    }
    return current;
  }

  async function initialize(tabId: number): Promise<any> {
    const existingJob = jobs.get(tabId);
    if (existingJob?.state === "ready" && existingJob.result) {
      const suggestion = suggestions.get(existingJob.result.suggestionId);
      try {
        if (!suggestion) throw new Error("The preview is no longer available.");
        await validateSuggestionSnapshot(tabId, suggestion);
      } catch {
        discardSuggestionState(tabId);
        captures.delete(tabId);
        existingJob.state = "error";
        existingJob.error = "The draft changed after this preview was created. Run ThunderClaw again.";
        delete existingJob.result;
      }
    }
    const selection = existingJob && ["running", "ready", "applied"].includes(existingJob.state)
      ? captures.get(tabId) || { text: existingJob.result?.original || "" }
      : await composeMessage(tabId, { type: "thunderclaw.capture" });
    if (!existingJob) captures.set(tabId, selection);
    const lease = await controller.acquireFeatureLease();
    const requestId = randomId();
    const [hello, listed, stored] = await Promise.all([lease.client.hello(), lease.client.listAgents(requestId), browser.storage.local.get("selectedAgentId")]);
    if (!bindingCurrent(lease.binding)) throw new Error("The ThunderClaw connection changed.");
    const agents = compatibleAgents(listed.value);
    const selectedAgentId = agents.some((agent: any) => agent.agentId === stored.selectedAgentId)
      ? stored.selectedAgentId : agents.find((agent: any) => agent.isDefault)?.agentId || agents[0]?.agentId || null;
    return { hello: hello.value, agents, selectedAgentId, selection, job: composeJobView(existingJob) };
  }

  async function transform(tabId: number, agentId: string, action: any, instruction: string, job: ComposeJob, snapshot: any): Promise<any> {
    const lease = await controller.acquireFeatureLease();
    if (jobs.get(tabId) !== job || !bindingCurrent(job.binding) || !sameConnectionBinding(job.binding, lease.binding)) throw new Error("The ThunderClaw connection changed.");
    if (snapshot.selectionShape === "flat-list-items" || snapshot.selectionShape === "rich-blocks") {
      const hello = await lease.client.hello();
      if (!sameConnectionBinding(hello.binding, lease.binding) || !bindingCurrent(lease.binding)) throw new Error("The ThunderClaw connection changed.");
      if (snapshot.selectionShape === "flat-list-items" && hello.value.capabilities?.flatListItemReplacement !== true) {
        throw new Error("The current ThunderClaw connection does not support flat-list item replacement.");
      }
      if (snapshot.selectionShape === "rich-blocks" && hello.value.capabilities?.richBlockReplacement !== true) {
        throw new Error("The current ThunderClaw connection does not support rich-block replacement.");
      }
    }
    await requireUsableAgent(lease, agentId, job.abort.signal);
    if (jobs.get(tabId) !== job || !bindingCurrent(job.binding) || !sameConnectionBinding(job.binding, lease.binding)) throw new Error("The preview was discarded.");
    const session = await ensureSession(tabId, agentId, lease);
    if (jobs.get(tabId) !== job || !bindingCurrent(job.binding)) {
      if (sessions.get(tabId) === session) sessions.delete(tabId);
      await session.lifecycle.close(session.composeId).catch(() => undefined);
      throw new Error("The preview was discarded.");
    }
    const [{ document, contextHash }, composeState] = await Promise.all([
      composeContext(tabId, snapshot), composeStateFingerprint(tabId),
    ]);
    const targetHash = await sha256(snapshot.text);
    try {
      await requireUsableAgent(lease, agentId, job.abort.signal);
    } catch (error) {
      if (sessions.get(tabId) === session) sessions.delete(tabId);
      await session.lifecycle.close(session.composeId).catch(() => undefined);
      throw error;
    }
    if (jobs.get(tabId) !== job || !bindingCurrent(job.binding) || !sameConnectionBinding(job.binding, lease.binding)) {
      if (sessions.get(tabId) === session) sessions.delete(tabId);
      await session.lifecycle.close(session.composeId).catch(() => undefined);
      throw new Error("The preview was discarded.");
    }
    const runId = randomId();
    session.activeRunId = runId;
    try {
      const completion = await session.lifecycle.transform(session.composeId, {
        requestId: randomId(), runId, action, instruction: instruction || null, contextHash, targetHash, document,
        target: { targetId: snapshot.targetId, text: snapshot.text, start: 0, end: snapshot.text.length,
          selectionShape: snapshot.selectionShape === "flat-list-items" ? "flat-list-items"
            : snapshot.selectionShape === "rich-blocks" ? "rich-blocks" : "text-range",
          ...(snapshot.selectionShape === "flat-list-items" ? { items: snapshot.items } : {}) },
        limits: { maxOperations: 1, maxOutputCharacters: 12_000 },
      }, { signal: job.abort.signal });
      if (jobs.get(tabId) !== job || !bindingCurrent(job.binding) || !sameConnectionBinding(completion.binding, job.binding)) throw new Error("The preview is stale.");
      const operation = completion.value.operations[0]!;
      if ((snapshot.selectionShape === "flat-list-items" && operation.type !== "replace_flat_list_items")
        || (snapshot.selectionShape === "rich-blocks" && operation.type !== "replace_rich_blocks")
        || (snapshot.selectionShape === "text-range" && operation.type !== "replace_text_range")) {
        throw new Error("The ThunderClaw result does not match the captured selection shape.");
      }
      const postSnapshot = await composeMessage(tabId, { type: "thunderclaw.inspect", targetId: snapshot.targetId });
      const [{ contextHash: postContextHash }, postTargetHash, postGenerationState] = await Promise.all([
        composeContext(tabId, postSnapshot), sha256(postSnapshot.text), composeStateFingerprint(tabId),
      ]);
      if (postContextHash !== contextHash || postTargetHash !== targetHash || postGenerationState.hash !== composeState.hash
          || postGenerationState.identity !== composeState.identity) {
        throw new Error("The draft changed while ThunderClaw was generating the preview. Run ThunderClaw again.");
      }
      const suggestionId = randomId();
      const replacement = operation.type === "replace_flat_list_items" ? operation.items.join("\n")
        : operation.type === "replace_text_range" ? operation.text : "";
      suggestions.set(suggestionId, { tabId, jobId: job.jobId, binding: job.binding, targetId: snapshot.targetId,
        expectedText: snapshot.text,
        replacement: operation.type === "replace_rich_blocks" ? undefined : replacement,
        replacementItems: operation.type === "replace_flat_list_items" ? operation.items : undefined,
        replacementBlocks: operation.type === "replace_rich_blocks" ? operation.blocks : undefined,
        operationType: operation.type, contextHash, targetHash,
        composeStateHash: composeState.hash, composeStateIdentity: composeState.identity });
      return { suggestionId, original: snapshot.text, replacement, summary: completion.value.summary,
        selectionShape: snapshot.selectionShape === "flat-list-items" ? "flat-list-items"
          : snapshot.selectionShape === "rich-blocks" ? "rich-blocks" : "text-range",
        ...(snapshot.selectionShape === "flat-list-items" && operation.type === "replace_flat_list_items" ? {
          listKind: snapshot.listKind, replacementItems: [...operation.items],
        } : {}), ...(snapshot.selectionShape === "rich-blocks" && operation.type === "replace_rich_blocks" ? {
          replacementBlocks: structuredClone(operation.blocks),
        } : {}) };
    } finally {
      if (session.activeRunId === runId) delete session.activeRunId;
    }
  }

  function composeJobView(job?: ComposeJob): any {
    if (!job) return null;
    return { jobId: job.jobId, state: job.state, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
  }

  function discardSuggestionState(tabId: number): void {
    const job = jobs.get(tabId);
    if (job?.result?.suggestionId) { suggestions.delete(job.result.suggestionId); undos.delete(job.result.suggestionId); }
  }

  function cancelComposeJob(tabId: number, remove = true): Promise<unknown>[] {
    const job = jobs.get(tabId);
    if (!job) return [];
    if (remove) { discardSuggestionState(tabId); jobs.delete(tabId); }
    const session = sessions.get(tabId) ?? pendingSessions.get(tabId);
    const cleanups: Promise<unknown>[] = [];
    if (session?.activeRunId) cleanups.push(session.lifecycle.cancel(session.composeId, randomId(), session.activeRunId).catch(() => undefined));
    else if (session && pendingSessions.get(tabId) === session) cleanups.push(session.lifecycle.close(session.composeId).catch(() => undefined));
    job.abort.abort();
    return cleanups;
  }

  async function startTransform(tabId: number, agentId: string, action: any, instruction: string): Promise<any> {
    const existing = jobs.get(tabId);
    if (existing?.state === "running") return composeJobView(existing);
    discardSuggestionState(tabId);
    jobs.delete(tabId);
    const captured = captures.get(tabId) || await composeMessage(tabId, { type: "thunderclaw.capture" });
    const snapshot = await composeMessage(tabId, { type: "thunderclaw.inspect", targetId: captured.targetId });
    if (snapshot.selectionShape === "flat-list-items"
        && ((snapshot.listKind !== "ul" && snapshot.listKind !== "ol") || !Array.isArray(snapshot.items))) {
      throw new Error("The compose editor returned an invalid flat-list snapshot.");
    }
    if (snapshot.selectionShape === "rich-blocks" && snapshot.text.trim().length === 0) {
      throw new Error("The compose editor returned an invalid rich-block snapshot.");
    }
    captures.set(tabId, snapshot);
    const lease = await controller.acquireFeatureLease();
    const job: ComposeJob = { jobId: randomId(), state: "running", binding: lease.binding, abort: new AbortController() };
    jobs.set(tabId, job);
    void transform(tabId, agentId, action, instruction, job, snapshot).then((result) => {
      if (jobs.get(tabId) !== job || !bindingCurrent(job.binding)) return;
      job.state = "ready"; job.result = result;
    }).catch((error) => {
      if (jobs.get(tabId) !== job || !bindingCurrent(job.binding)) return;
      job.state = "error"; job.error = error instanceof Error ? error.message : String(error);
    });
    return composeJobView(job);
  }

  async function applySuggestion(tabId: number, suggestionId: string, jobId: string): Promise<any> {
    const suggestion = suggestions.get(suggestionId);
    const job = jobs.get(tabId);
    if (!validJobId(jobId) || !suggestion || !job || suggestion.tabId !== tabId || suggestion.jobId !== job.jobId || jobId !== job.jobId
        || !bindingCurrent(suggestion.binding)) throw new Error("This suggestion is no longer available.");
    let current;
    try {
      current = await validateSuggestionSnapshot(tabId, suggestion);
    } catch {
      suggestions.delete(suggestionId);
      throw new Error("The draft changed after this suggestion was created. Run ThunderClaw again.");
    }
    if (jobs.get(tabId) !== job) throw new Error("The draft changed after this suggestion was created. Run ThunderClaw again.");
    const result = await composeMessage(tabId, { type: "thunderclaw.apply", targetId: suggestion.targetId,
      expectedText: suggestion.expectedText, operationType: suggestion.operationType,
      ...(suggestion.operationType === "replace_text_range" ? { replacement: suggestion.replacement } : {}),
      ...(suggestion.operationType === "replace_flat_list_items" ? { replacement: suggestion.replacement,
        replacementItems: suggestion.replacementItems } : {}),
      ...(suggestion.operationType === "replace_rich_blocks" ? { replacementBlocks: suggestion.replacementBlocks } : {}) });
    suggestions.delete(suggestionId);
    undos.set(suggestionId, { tabId, jobId: job.jobId, undoId: result.undoId });
    captures.delete(tabId);
    job.state = "applied"; job.result = { ...job.result!, applied: true };
    return composeJobView(job);
  }

  async function undoSuggestion(tabId: number, suggestionId: string, jobId: string): Promise<any> {
    const undo = undos.get(suggestionId);
    const job = jobs.get(tabId);
    if (!validJobId(jobId) || !undo || !job || undo.tabId !== tabId || undo.jobId !== job.jobId || jobId !== job.jobId) throw new Error("This applied change can no longer be undone.");
    const result = await composeMessage(tabId, { type: "thunderclaw.undo", undoId: undo.undoId });
    undos.delete(suggestionId); captures.delete(tabId); jobs.delete(tabId);
    return result;
  }

  async function ensureMessageDisplayScript(tabId: number): Promise<any> {
    try { return await browser.tabs.sendMessage(tabId, { type: "thunderclaw.message.capture" }); }
    catch { await browser.scripting.executeScript({ target: { tabId }, files: ["message-display.js"] }); return browser.tabs.sendMessage(tabId, { type: "thunderclaw.message.capture" }); }
  }

  async function messageDisplayCall(tabId: number, message: any): Promise<any> {
    const response = message.type === "thunderclaw.message.capture" ? await ensureMessageDisplayScript(tabId) : await browser.tabs.sendMessage(tabId, message);
    if (!response?.ok) throw new Error(response?.error || "The Thunderbird message viewer did not respond.");
    return response.value;
  }

  async function captureDisplayedMessage(tabId: number): Promise<MessageCapture> {
    const before = await browser.messageDisplay.getDisplayedMessage(tabId);
    if (!before) throw new Error("Open ThunderClaw while viewing a message.");
    const captured = await messageDisplayCall(tabId, { type: "thunderclaw.message.capture" });
    const after = await browser.messageDisplay.getDisplayedMessage(tabId);
    if (!after || after.id !== before.id) throw new Error("The displayed message changed while ThunderClaw was capturing it.");
    const subject = after.subject || "";
    const author = after.author || "";
    const messageHash = await sha256(JSON.stringify({ messageId: after.id, subject, author, segments: captured.segments }));
    return { ...captured, messageId: after.id, subject, author, messageHash };
  }

  function messageJobView(job?: MessageJob): any {
    if (!job) return null;
    return { jobId: job.jobId, state: job.state, action: job.action, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
  }

  async function initializeMessage(tabId: number): Promise<any> {
    const lease = await controller.acquireFeatureLease();
    const [hello, listed, stored, acceptLanguages, uiLanguage, captured] = await Promise.all([
      lease.client.hello(), lease.client.listAgents(randomId()), browser.storage.local.get(["selectedAgentId", "messageTargetLanguage"]),
      browser.i18n.getAcceptLanguages(), browser.i18n.getUILanguage(), captureDisplayedMessage(tabId),
    ]);
    if (!bindingCurrent(lease.binding)) throw new Error("The ThunderClaw connection changed.");
    const agents = compatibleAgents(listed.value);
    const selectedAgentId = agents.some((agent: any) => agent.agentId === stored.selectedAgentId) ? stored.selectedAgentId : agents.find((agent: any) => agent.isDefault)?.agentId || agents[0]?.agentId || null;
    const preferredLanguage = stored.messageTargetLanguage || acceptLanguages[0] || uiLanguage || "en-US";
    const running = messageJobs.get(tabId);
    if (running && (running.messageId !== captured.messageId || running.messageHash !== captured.messageHash || running.displayInstanceId !== captured.displayInstanceId)) void invalidateMessage(tabId);
    messageCaptures.set(tabId, captured);
    return { hello: hello.value, agents, selectedAgentId, preferredLanguage, acceptLanguages, uiLanguage, detected: await browser.i18n.detectLanguage(captured.text), capture: { characters: captured.text.length }, job: messageJobView(messageJobs.get(tabId)) };
  }

  function invalidateMessage(tabId: number, expectedJobId?: string): Promise<unknown>[] {
    const job = messageJobs.get(tabId);
    if (!job || (expectedJobId !== undefined && expectedJobId !== job.jobId)) return [];
    messageJobs.delete(tabId);
    messageCaptures.delete(tabId);
    const cleanup = job.lease.client.cancelMessageTransform({ protocolVersion: 1, requestId: randomId(), transformRequestId: job.requestId, runId: job.runId, messageHash: job.messageHash }).catch(() => undefined);
    job.abort.abort();
    return [cleanup];
  }

  async function startMessageTransform(tabId: number, agentId: string, action: "translate" | "summarize", sourceLanguage: string | null, targetLanguage: string | null): Promise<any> {
    const existing = messageJobs.get(tabId);
    if (existing?.state === "running") return messageJobView(existing);
    const captured = messageCaptures.get(tabId);
    if (!captured) throw new Error("The displayed message is no longer available. Reopen ThunderClaw.");
    const requestId = randomId(); const runId = randomId(); const abort = new AbortController();
    const lease = await controller.acquireFeatureLease();
    if (messageCaptures.get(tabId) !== captured || !bindingCurrent(lease.binding)) throw new Error("The displayed message changed.");
    const job: MessageJob = { jobId: randomId(), state: "running", action, requestId, runId, messageId: captured.messageId, messageHash: captured.messageHash, displayInstanceId: captured.displayInstanceId, lease, abort };
    messageJobs.set(tabId, job);
    try {
      await requireUsableAgent(lease, agentId, abort.signal);
      if (messageJobs.get(tabId) !== job || messageCaptures.get(tabId) !== captured || !bindingCurrent(lease.binding)) {
        throw new Error("The displayed message changed.");
      }
    } catch (error) {
      if (messageJobs.get(tabId) === job) messageJobs.delete(tabId);
      abort.abort();
      throw error;
    }
    void (async () => {
      try {
        const completion = await lease.client.transformMessage({ protocolVersion: 1, requestId, runId, agentId, action, sourceLanguage, targetLanguage, messageHash: captured.messageHash, document: { subject: captured.subject, author: captured.author, segments: captured.segments }, limits: { maxSegments: 400, maxOutputCharacters: 200_000 } }, { signal: abort.signal });
        if (messageJobs.get(tabId) !== job || !bindingCurrent(lease.binding) || !sameConnectionBinding(completion.binding, lease.binding)) return;
        const fresh = await captureDisplayedMessage(tabId);
        if (messageJobs.get(tabId) !== job || fresh.messageId !== job.messageId || fresh.messageHash !== job.messageHash || fresh.displayInstanceId !== job.displayInstanceId || !bindingCurrent(lease.binding)) throw new Error("The displayed message changed while ThunderClaw was working.");
        if (action === "translate") {
          await messageDisplayCall(tabId, { type: "thunderclaw.message.translate", displayInstanceId: job.displayInstanceId, segments: completion.value.result.segments });
          if (messageJobs.get(tabId) !== job || !bindingCurrent(lease.binding)) return;
          await browser.storage.local.set({ messageTargetLanguage: targetLanguage });
        } else {
          await messageDisplayCall(tabId, { type: "thunderclaw.message.summary", displayInstanceId: job.displayInstanceId, summary: completion.value.result.summary, detectedLanguage: completion.value.result.detectedLanguage });
        }
        if (messageJobs.get(tabId) !== job || !bindingCurrent(lease.binding)) return;
        job.state = "ready"; job.result = completion.value.result;
      } catch (error) {
        if (messageJobs.get(tabId) !== job || !bindingCurrent(job.lease.binding)) return;
        job.state = "error"; job.error = error instanceof Error ? error.message : String(error);
      }
    })();
    return messageJobView(job);
  }

  async function dismissMessageResult(tabId: number, jobId: string): Promise<any> {
    const job = messageJobs.get(tabId);
    if (!validJobId(jobId) || job?.jobId !== jobId) throw new Error("This message result is no longer current.");
    void Promise.allSettled(invalidateMessage(tabId, jobId));
    await messageDisplayCall(tabId, { type: "thunderclaw.message.dismiss", ...(job ? { displayInstanceId: job.displayInstanceId } : {}) });
    return { dismissed: true };
  }

  function closeTab(tabId: number): Promise<unknown>[] {
    const cleanups = [...cancelComposeJob(tabId), ...invalidateMessage(tabId)];
    const session = sessions.get(tabId) ?? pendingSessions.get(tabId);
    sessions.delete(tabId); pendingSessions.delete(tabId); captures.delete(tabId); jobs.delete(tabId); messageJobs.delete(tabId); messageCaptures.delete(tabId);
    if (session) cleanups.push(session.lifecycle.close(session.composeId).catch(() => undefined));
    for (const [id, suggestion] of suggestions) if (suggestion.tabId === tabId) suggestions.delete(id);
    for (const [id, undo] of undos) if (undo.tabId === tabId) undos.delete(id);
    return cleanups;
  }

  controller.addFeatureRetirementHandler((lease) => {
    const cleanups: Promise<unknown>[] = [];
    for (const [tabId, job] of jobs) {
      if (!sameConnectionBinding(job.binding, lease.binding)) continue;
      cleanups.push(...cancelComposeJob(tabId));
      captures.delete(tabId);
    }
    for (const [tabId, session] of [...sessions, ...pendingSessions]) {
      if (!sameConnectionBinding(session.lease.binding, lease.binding)) continue;
      sessions.delete(tabId); pendingSessions.delete(tabId); captures.delete(tabId); jobs.delete(tabId);
      cleanups.push(session.lifecycle.close(session.composeId).catch(() => undefined));
    }
    for (const [tabId, job] of messageJobs) if (sameConnectionBinding(job.lease.binding, lease.binding)) cleanups.push(...invalidateMessage(tabId));
    for (const [id, suggestion] of suggestions) if (sameConnectionBinding(suggestion.binding, lease.binding)) suggestions.delete(id);
    return Promise.allSettled(cleanups).then(() => undefined);
  });

  browser.runtime.onMessage.addListener((message: any) => {
    if (!message || typeof message !== "object" || !Number.isInteger(message.tabId)) return undefined;
    if (message.type === "messagePopup.initialize") return initializeMessage(message.tabId);
    if (message.type === "messagePopup.transform") return startMessageTransform(message.tabId, message.agentId, message.action, message.sourceLanguage, message.targetLanguage);
    if (message.type === "messagePopup.job") return Promise.resolve(messageJobView(messageJobs.get(message.tabId)));
    if (message.type === "messagePopup.original" || message.type === "messagePopup.translation") {
      const job = messageJobs.get(message.tabId);
      if (!validJobId(message.jobId) || !job || message.jobId !== job.jobId) return Promise.reject(new Error("This message result is no longer current."));
      return messageDisplayCall(message.tabId, { type: message.type === "messagePopup.original" ? "thunderclaw.message.original" : "thunderclaw.message.showTranslation", displayInstanceId: job.displayInstanceId });
    }
    if (message.type === "messagePopup.dismiss") return dismissMessageResult(message.tabId, message.jobId);
    if (message.type === "popup.initialize") return initialize(message.tabId);
    if (message.type === "popup.transform") return startTransform(message.tabId, message.agentId, message.action, message.instruction);
    if (message.type === "popup.job") return Promise.resolve(composeJobView(jobs.get(message.tabId)));
    if (message.type === "popup.discard") {
      const job = jobs.get(message.tabId);
      if (!validJobId(message.jobId) || job?.jobId !== message.jobId) return Promise.reject(new Error("This preview is no longer current."));
      void Promise.allSettled(cancelComposeJob(message.tabId)); captures.delete(message.tabId);
      return Promise.resolve({ discarded: true });
    }
    if (message.type === "popup.apply") return applySuggestion(message.tabId, message.suggestionId, message.jobId);
    if (message.type === "popup.undo") return undoSuggestion(message.tabId, message.suggestionId, message.jobId);
    if (message.type === "popup.cancel") {
      const job = jobs.get(message.tabId);
      if (!validJobId(message.jobId) || job?.jobId !== message.jobId) return Promise.reject(new Error("This preview is no longer current."));
      const active = sessions.get(message.tabId)?.activeRunId;
      void Promise.allSettled(cancelComposeJob(message.tabId, false));
      return Promise.resolve({ cancelled: Boolean(active) });
    }
    return undefined;
  });

  browser.tabs.onRemoved.addListener((tabId: number) => { void Promise.allSettled(closeTab(tabId)); });
  browser.messageDisplay.onMessageDisplayed?.addListener((tab: any) => { if (Number.isInteger(tab?.id)) void Promise.allSettled(invalidateMessage(tab.id)); });

  async function registerMessageDisplayScript(): Promise<void> {
    const registered = await browser.scripting.messageDisplay.getRegisteredScripts({ ids: ["thunderclaw-message-display"] });
    if (registered.length) return;
    await browser.scripting.messageDisplay.registerScripts([{ id: "thunderclaw-message-display", js: ["message-display.js"], runAt: "document_idle" }]);
  }
  void registerMessageDisplayScript().catch(() => undefined);
}
