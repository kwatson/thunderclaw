import { inferenceFailureMessage } from "./inference-client.js";
import { DirectClientError, sameConnectionBinding } from "./direct-client-contract.js";
import type { ConnectionBinding, MessageTransformResult, RichBlock, ThunderClawDirectClient } from "./direct-client-contract.js";
import { DirectComposeLifecycleRegistry } from "./direct-client-lifecycle.js";
import { randomId } from "./random-id.js";
import { validateRichTargetBlocks } from "./direct-client-validators.js";
type BackgroundFeatureLease = { client: ThunderClawDirectClient; binding: ConnectionBinding };
type FeatureConnectionController = {
  acquireFeatureLease(): Promise<BackgroundFeatureLease>;
  isFeatureBindingCurrent(binding: ConnectionBinding): boolean;
  addFeatureRetirementHandler(handler: (lease: BackgroundFeatureLease) => void | Promise<void>): void;
};

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
  state: "running" | "ready" | "applied" | "cancelled" | "error";
  startedAt: number;
  mutation?: "apply" | "undo";
  settled?: Promise<void>;
  binding: ConnectionBinding;
  abort: AbortController;
  result?: { suggestionId: string; original: string; replacement: string; summary: string; applied?: true;
    selectionShape?: "text-range" | "flat-list-items" | "rich-blocks"; listKind?: "ul" | "ol";
    originalItems?: string[]; replacementItems?: string[]; originalBlocks?: RichBlock[]; replacementBlocks?: RichBlock[] };
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
  state: "running" | "finishing" | "ready" | "cancelled" | "error";
  startedAt: number;
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

// Restrict errors leaving the background to fixed, reviewed UI messages. API
// exceptions can include endpoints, credentials, or message content.
const featureErrorMessages = new Set([
  "A tracked compose node is outside the editor.",
  "A tracked compose node was detached.",
  "Focusing the compose editor changed the exact list selection.",
  "Focusing the compose editor changed the exact rich-block selection.",
  "Grant access to the selected inference endpoint in settings.",
  "Save and test a valid inference connection in settings.",
  "The connection changed. Try the action again.",
  "Open ThunderClaw from a message compose window.",
  "Open ThunderClaw while viewing a message.",
  "Quoted history and signatures are context only and cannot be edited.",
  "Rich Apply is disabled for this draft because exact rollback could not be verified.",
  "Rich Apply requires an exact rich-block operation.",
  "Select non-empty text in the message body.",
  "Describe the tone you want before generating a preview.",
  "Enter a target language before generating a preview.",
  "Enter an instruction before generating a preview.",
  "Select text in the message body before opening ThunderClaw.",
  "Text Apply requires an exact text-range operation.",
  "The ThunderClaw connection changed.",
  "The ThunderClaw popup request is invalid.",
  "The ThunderClaw result does not match the captured selection shape.",
  "The compose editor returned an invalid flat-list snapshot.",
  "The compose editor returned an invalid rich-block snapshot.",
  "The compose session was replaced while it was opening.",
  "The configured model is no longer available. Check ThunderClaw settings.",
  "The current ThunderClaw connection does not support flat-list item replacement.",
  "The current ThunderClaw connection does not support rich-block replacement.",
  "The displayed message changed while ThunderClaw was capturing it.",
  "The displayed message changed while ThunderClaw was working.",
  "The displayed message changed.",
  "The displayed message changed. Generate the translation again.",
  "The displayed message changed. Run ThunderClaw again.",
  "The displayed message is no longer available. Reopen ThunderClaw.",
  "The draft changed after Apply, so ThunderClaw will not overwrite the newer edit.",
  "The draft changed after this suggestion was created. Run ThunderClaw again.",
  "The draft changed while ThunderClaw was generating the preview. Run ThunderClaw again.",
  "The original list selection changed.",
  "The original list selection changed. Run ThunderClaw again.",
  "The original rich-block selection changed. Run ThunderClaw again.",
  "The original selected text changed.",
  "The original selection direction changed.",
  "The original selection direction changed. Run ThunderClaw again.",
  "The original selection is no longer available.",
  "The preview is no longer available.",
  "The preview is stale.",
  "The preview was discarded.",
  "The review window could not be opened.",
  "The rich-block suggestion is invalid or stale. Run ThunderClaw again.",
  "The selected list changed. Run ThunderClaw again on the current draft.",
  "The selected text changed. Run ThunderClaw again on the current draft.",
  "The selection is outside the message body.",
  "The whole-list suggestion is invalid or stale. Run ThunderClaw again.",
  "This ThunderClaw action is only available from its popup.",
  "This applied change can no longer be undone.",
  "This message result is no longer current.",
  "This preview is no longer current.",
  "This suggestion is no longer available.",
  "Thunderbird rejected the exact whole-list replacement and restored the draft.",
  "Thunderbird could not verify exact whole-list rollback. Rich Apply is disabled for this draft.",
  "Thunderbird rejected the exact rich-block replacement and restored the draft.",
  "Thunderbird could not verify exact rich-block rollback. Rich Apply is disabled for this draft.",
  "Thunderbird could not select the exact rich-block wrappers.",
  "Thunderbird could not undo the applied change.",
  "Thunderbird could not verify exact rich-block Undo. Rich Apply is disabled for this draft.",
  "Thunderbird could not verify exact whole-list Undo. Rich Apply is disabled for this draft.",
  "Thunderbird did not apply the replacement through its editor.",
  "Unsupported compose DOM node.",
  "Whole-list Apply requires an exact flat-list item operation.",
  "Whole-list editing currently requires complete flat list items containing plain text only.",
  "Whole-list editing currently requires plain text list items.",
  "Whole-list editing requires Thunderbird 153 or newer."
]);
function featureErrorMessage(error: unknown): string {
  if (error instanceof DirectClientError) {
    const safeMessage = inferenceFailureMessage(error.code);
    if (safeMessage) return safeMessage;
    const messages: Record<string, string> = {
      configuration: "Check the inference connection settings and test the selected model.",
      permission: "Grant access to the selected inference endpoint in settings.",
      authentication: "The inference server rejected the API key. Replace it in settings.",
      rate_limit: "The inference server rate limit was reached. Try again later.",
      network: "Unable to contact the inference server. Check its address and availability.",
      timeout: "The inference request exceeded its time limit. Try again.",
      cancellation: "The inference request was cancelled. Try again.",
      contract: "The model returned an invalid structured result. Check its structured output support.",
      capability: "The configured model does not support this action.",
      backend: "The inference server could not complete the request. Try again later.",
    };
    return messages[error.kind] ?? "ThunderClaw could not complete this action. Check settings and try again.";
  }
  return error instanceof Error && featureErrorMessages.has(error.message)
    ? error.message : "ThunderClaw could not complete this action. Check settings and try again.";
}

function validPopupMessage(message: Record<string, unknown>): boolean {
  if (!Number.isSafeInteger(message.tabId) || (message.tabId as number) <= 0) return false;
  const fields: Record<string, string[]> = {
    "popup.initialize": [], "popup.job": [],
    "popup.transform": ["agentId", "action", "instruction"],
    "popup.apply": ["suggestionId", "jobId"], "popup.undo": ["suggestionId", "jobId"],
    "popup.discard": ["jobId"], "popup.cancel": ["jobId"], "popup.expand": ["jobId"],
    "messagePopup.initialize": [], "messagePopup.job": [],
    "messagePopup.transform": ["agentId", "action", "sourceLanguage", "targetLanguage"],
    "messagePopup.original": ["jobId"], "messagePopup.translation": ["jobId"], "messagePopup.dismiss": ["jobId"], "messagePopup.cancel": ["jobId"],
  };
  const required = fields[message.type as string];
  if (!required || Object.keys(message).length !== required.length + 2
      || Object.keys(message).some((key) => !["type", "tabId", ...required].includes(key))) return false;
  const text = (key: string, max: number, empty = false) => typeof message[key] === "string"
    && (empty || (message[key] as string).trim().length > 0) && (message[key] as string).length <= max;
  if (required.includes("agentId") && !text("agentId", 256)) return false;
  if (required.includes("jobId") && !text("jobId", 128)) return false;
  if (required.includes("suggestionId") && !text("suggestionId", 128)) return false;
  if (message.type === "popup.transform") return ["improve", "proofread", "shorten", "tone", "translate", "summarize", "ask"].includes(message.action as string)
    && text("instruction", 4000, true);
  if (message.type === "messagePopup.transform") return ["translate", "summarize"].includes(message.action as string)
    && (message.sourceLanguage === null || text("sourceLanguage", 100))
    && (message.targetLanguage === null || text("targetLanguage", 100))
    && (message.action !== "translate" || text("targetLanguage", 100));
  return true;
}

function validReviewMessage(message: Record<string, unknown>): boolean {
  const fields: Record<string, string[]> = { "review.initialize": [], "review.job": ["jobId"],
    "review.apply": ["jobId", "suggestionId"], "review.undo": ["jobId", "suggestionId"], "review.discard": ["jobId"] };
  const required = fields[message.type as string];
  return Boolean(required) && Object.keys(message).length === required.length + 1
    && Object.keys(message).every((key) => key === "type" || required.includes(key))
    && required.every((key) => typeof message[key] === "string" && (message[key] as string).length > 0 && (message[key] as string).length <= 128);
}

export function installFeatureBackground(controller: FeatureConnectionController): void {
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
  const pendingComposeCancelCleanups = new Map<number, Promise<void>>();
  const pendingComposeStarts = new Map<number, Promise<any>>();
  const pendingMessageStarts = new Map<number, Promise<any>>();
  const reviewBindings = new Map<number, { sourceTabId: number; jobId: string; windowId: number }>();
  const reviewOpening = new Map<string, Promise<void>>();
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
      return session;
    } finally {
      if (pendingSessions.get(tabId) === session) pendingSessions.delete(tabId);
    }
  }

  function compatibleAgents(listed: any): any[] {
    return listed.agents.filter((agent: any) => ["verified", "partially_verified"].includes(agent.compatibility?.state));
  }

  async function requireUsableAgent(lease: BackgroundFeatureLease, agentId: string, signal: AbortSignal): Promise<void> {
    const listed = await lease.client.listAgents(randomId(), { signal });
    if (!sameConnectionBinding(listed.binding, lease.binding) || !bindingCurrent(lease.binding)) {
      throw new Error("The ThunderClaw connection changed.");
    }
    const selected = listed.value.agents.find((agent: any) => agent.agentId === agentId);
    if (!selected || !["verified", "partially_verified"].includes(selected.compatibility?.state)) {
      throw new Error("The configured model is no longer available. Check ThunderClaw settings.");
    }
  }

  function targetFingerprint(snapshot: any): Promise<string> {
    // Bind supported formatting as well as text so a same-text format change retires the preview.
    return sha256(snapshot.selectionShape === "rich-blocks"
      ? JSON.stringify({ text: snapshot.text, blocks: validateRichTargetBlocks(snapshot.blocks, snapshot.text) })
      : snapshot.text);
  }

  async function validateSuggestionSnapshot(tabId: number, suggestion: any): Promise<any> {
    const current = await composeMessage(tabId, { type: "thunderclaw.inspect", targetId: suggestion.targetId });
    const [{ contextHash }, targetHash, composeState] = await Promise.all([
      composeContext(tabId, current), targetFingerprint(current), composeStateFingerprint(tabId),
    ]);
    if (contextHash !== suggestion.contextHash || targetHash !== suggestion.targetHash
        || composeState.hash !== suggestion.composeStateHash || composeState.identity !== suggestion.composeStateIdentity
        || !bindingCurrent(suggestion.binding)) {
      throw new Error("The draft changed after this suggestion was created. Run ThunderClaw again.");
    }
    return current;
  }

  async function initialize(tabId: number): Promise<any> {
    let existingJob = jobs.get(tabId);
    const terminalOnEntry = existingJob && ["cancelled", "error"].includes(existingJob.state);
    if (existingJob?.state === "ready" && existingJob.result && !existingJob.mutation) {
      const expectedResult = existingJob.result;
      const suggestion = suggestions.get(expectedResult.suggestionId);
      try {
        if (!suggestion) throw new Error("The preview is no longer available.");
        await validateSuggestionSnapshot(tabId, suggestion);
      } catch {
        if (jobs.get(tabId) === existingJob && existingJob.state === "ready"
            && existingJob.result === expectedResult && !existingJob.mutation) {
          discardSuggestionState(tabId);
          captures.delete(tabId);
          existingJob.state = "error";
          existingJob.error = "The draft changed after this preview was created. Run ThunderClaw again.";
          delete existingJob.result;
        }
      }
    }
    const selection = existingJob && ["running", "ready", "applied"].includes(existingJob.state)
      ? captures.get(tabId) || { text: existingJob.result?.original || "" }
      : await composeMessage(tabId, { type: "thunderclaw.capture" });
    if (!existingJob) captures.set(tabId, selection);
    else if (terminalOnEntry && jobs.get(tabId) === existingJob) {
      const previous = captures.get(tabId);
      captures.set(tabId, selection);
      if (!previous || previous.text !== selection.text || previous.selectionShape !== selection.selectionShape
          || JSON.stringify(previous.items ?? null) !== JSON.stringify(selection.items ?? null)
          || JSON.stringify(previous.blocks ?? null) !== JSON.stringify(selection.blocks ?? null)) {
        jobs.delete(tabId);
        existingJob = undefined;
      }
    }
    else if (existingJob.state === "error") captures.set(tabId, selection);
    const lease = await controller.acquireFeatureLease();
    const requestId = randomId();
    const [hello, listed] = await Promise.all([lease.client.hello(), lease.client.listAgents(requestId)]);
    if (!bindingCurrent(lease.binding)) throw new Error("The ThunderClaw connection changed.");
    const agents = compatibleAgents(listed.value);
    const selectedAgentId = agents.find((agent: any) => agent.isDefault)?.agentId || agents[0]?.agentId || null;
    return { hello: hello.value, agents, selectedAgentId, selection, job: composeJobView(existingJob) };
  }

  async function transform(tabId: number, agentId: string, action: any, instruction: string, job: ComposeJob, snapshot: any): Promise<any> {
    const lease = await controller.acquireFeatureLease();
    if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || !bindingCurrent(job.binding) || !sameConnectionBinding(job.binding, lease.binding)) throw new Error("The ThunderClaw connection changed.");
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
    if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || !bindingCurrent(job.binding) || !sameConnectionBinding(job.binding, lease.binding)) throw new Error("The preview was discarded.");
    const session = await ensureSession(tabId, agentId, lease);
    if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || !bindingCurrent(job.binding)) {
      if (sessions.get(tabId) === session) sessions.delete(tabId);
      await session.lifecycle.close(session.composeId).catch(() => undefined);
      throw new Error("The preview was discarded.");
    }
    const [{ document, contextHash }, composeState] = await Promise.all([
      composeContext(tabId, snapshot), composeStateFingerprint(tabId),
    ]);
    const targetHash = await targetFingerprint(snapshot);
    try {
      await requireUsableAgent(lease, agentId, job.abort.signal);
    } catch (error) {
      if (sessions.get(tabId) === session) sessions.delete(tabId);
      await session.lifecycle.close(session.composeId).catch(() => undefined);
      throw error;
    }
    if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || !bindingCurrent(job.binding) || !sameConnectionBinding(job.binding, lease.binding)) {
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
          ...(snapshot.selectionShape === "flat-list-items" ? { items: snapshot.items } : {}),
          ...(snapshot.selectionShape === "rich-blocks" ? { blocks: structuredClone(snapshot.blocks) } : {}) },
        limits: { maxOperations: 1, maxOutputCharacters: 12_000 },
      }, { signal: job.abort.signal });
      if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || !bindingCurrent(job.binding) || !sameConnectionBinding(completion.binding, job.binding)) throw new Error("The preview is stale.");
      const operation = completion.value.operations[0]!;
      if ((snapshot.selectionShape === "flat-list-items" && operation.type !== "replace_flat_list_items")
        || (snapshot.selectionShape === "rich-blocks" && operation.type !== "replace_rich_blocks")
        || (snapshot.selectionShape === "text-range" && operation.type !== "replace_text_range")) {
        throw new Error("The ThunderClaw result does not match the captured selection shape.");
      }
      const postSnapshot = await composeMessage(tabId, { type: "thunderclaw.inspect", targetId: snapshot.targetId });
      const [{ contextHash: postContextHash }, postTargetHash, postGenerationState] = await Promise.all([
        composeContext(tabId, postSnapshot), targetFingerprint(postSnapshot), composeStateFingerprint(tabId),
      ]);
      if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || postContextHash !== contextHash || postTargetHash !== targetHash || postGenerationState.hash !== composeState.hash
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
          listKind: snapshot.listKind, originalItems: [...snapshot.items], replacementItems: [...operation.items],
        } : {}), ...(snapshot.selectionShape === "rich-blocks" && operation.type === "replace_rich_blocks" ? {
          originalBlocks: structuredClone(snapshot.blocks), replacementBlocks: structuredClone(operation.blocks),
        } : {}) };
    } finally {
      if (session.activeRunId === runId) delete session.activeRunId;
    }
  }

  function composeJobView(job?: ComposeJob): any {
    if (!job) return null;
    return { jobId: job.jobId, state: job.state, startedAt: job.startedAt, ...(job.mutation ? { mutation: job.mutation } : {}), ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
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

  function cancelRunningCompose(tabId: number, jobId: string): any {
    const job = jobs.get(tabId);
    if (!validJobId(jobId) || !job || job.jobId !== jobId) throw new Error("This preview is no longer current.");
    if (job.state !== "running") return composeJobView(job);
    job.state = "cancelled";
    const cleanups = cancelComposeJob(tabId, false);
    const cleanup = Promise.allSettled([...cleanups, ...(job.settled ? [job.settled] : [])]).then(() => undefined);
    pendingComposeCancelCleanups.set(tabId, cleanup);
    void cleanup.finally(() => { if (pendingComposeCancelCleanups.get(tabId) === cleanup) pendingComposeCancelCleanups.delete(tabId); });
    return composeJobView(job);
  }

  async function startTransform(tabId: number, agentId: string, action: any, instruction: string): Promise<any> {
    if (!instruction.trim()) {
      if (action === "tone") throw new Error("Describe the tone you want before generating a preview.");
      if (action === "translate") throw new Error("Enter a target language before generating a preview.");
      if (action === "ask") throw new Error("Enter an instruction before generating a preview.");
    }
    const existing = jobs.get(tabId);
    if (existing?.state === "running") return composeJobView(existing);
    if (existing?.mutation) throw new Error("The preview is no longer current.");
    if (pendingComposeCancelCleanups.has(tabId)) await pendingComposeCancelCleanups.get(tabId);
    discardSuggestionState(tabId);
    jobs.delete(tabId);
    const captured = captures.get(tabId) || await composeMessage(tabId, { type: "thunderclaw.capture" });
    const snapshot = await composeMessage(tabId, { type: "thunderclaw.inspect", targetId: captured.targetId });
    if (snapshot.selectionShape === "flat-list-items"
        && ((snapshot.listKind !== "ul" && snapshot.listKind !== "ol") || !Array.isArray(snapshot.items))) {
      throw new Error("The compose editor returned an invalid flat-list snapshot.");
    }
    if (snapshot.selectionShape === "rich-blocks") {
      try { snapshot.blocks = validateRichTargetBlocks(snapshot.blocks, snapshot.text); }
      catch { throw new Error("The compose editor returned an invalid rich-block snapshot."); }
    }
    captures.set(tabId, snapshot);
    const lease = await controller.acquireFeatureLease();
    const job: ComposeJob = { jobId: randomId(), state: "running", startedAt: Date.now(), binding: lease.binding, abort: new AbortController() };
    jobs.set(tabId, job);
    job.settled = transform(tabId, agentId, action, instruction, job, snapshot).then((result) => {
      if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || !bindingCurrent(job.binding)) return;
      job.state = "ready"; job.result = result;
    }).catch((error) => {
      if (jobs.get(tabId) !== job || job.state !== "running" || job.abort.signal.aborted || !bindingCurrent(job.binding)) return;
      job.state = "error"; job.error = featureErrorMessage(error);
    });
    return composeJobView(job);
  }

  async function applySuggestion(tabId: number, suggestionId: string, jobId: string): Promise<any> {
    const suggestion = suggestions.get(suggestionId);
    const job = jobs.get(tabId);
    if (!validJobId(jobId) || !suggestion || !job || job.state !== "ready" || job.mutation || suggestion.tabId !== tabId || suggestion.jobId !== job.jobId || jobId !== job.jobId
        || !bindingCurrent(suggestion.binding)) throw new Error("This suggestion is no longer available.");
    job.mutation = "apply";
    try {
    let current;
    try {
      current = await validateSuggestionSnapshot(tabId, suggestion);
    } catch {
      suggestions.delete(suggestionId);
      job.state = "error"; job.error = "The draft changed after this suggestion was created. Run ThunderClaw again."; delete job.result;
      throw new Error("The draft changed after this suggestion was created. Run ThunderClaw again.");
    }
    if (jobs.get(tabId) !== job) throw new Error("The draft changed after this suggestion was created. Run ThunderClaw again.");
    const result = await composeMessage(tabId, { type: "thunderclaw.apply", targetId: suggestion.targetId,
      expectedText: suggestion.expectedText, operationType: suggestion.operationType,
      ...(suggestion.operationType === "replace_text_range" ? { replacement: suggestion.replacement } : {}),
      ...(suggestion.operationType === "replace_flat_list_items" ? { replacement: suggestion.replacement,
        replacementItems: suggestion.replacementItems } : {}),
      ...(suggestion.operationType === "replace_rich_blocks" ? { replacementBlocks: suggestion.replacementBlocks } : {}) });
    if (jobs.get(tabId) !== job || !bindingCurrent(job.binding)) throw new Error("This suggestion is no longer available.");
    suggestions.delete(suggestionId);
    undos.set(suggestionId, { tabId, jobId: job.jobId, undoId: result.undoId });
    captures.delete(tabId);
    job.state = "applied"; job.result = { ...job.result!, applied: true };
    return composeJobView(job);
    } finally { delete job.mutation; }
  }

  async function undoSuggestion(tabId: number, suggestionId: string, jobId: string): Promise<any> {
    const undo = undos.get(suggestionId);
    const job = jobs.get(tabId);
    if (!validJobId(jobId) || !undo || !job || job.state !== "applied" || job.mutation || undo.tabId !== tabId || undo.jobId !== job.jobId || jobId !== job.jobId) throw new Error("This applied change can no longer be undone.");
    job.mutation = "undo";
    try {
    const result = await composeMessage(tabId, { type: "thunderclaw.undo", undoId: undo.undoId });
    if (jobs.get(tabId) !== job || !bindingCurrent(job.binding)) throw new Error("This applied change can no longer be undone.");
    undos.delete(suggestionId); captures.delete(tabId); jobs.delete(tabId);
    return result;
    } finally { delete job.mutation; }
  }

  async function checkedReviewJob(sourceTabId: number, jobId: string, validateReady = false): Promise<ComposeJob> {
    const job = jobs.get(sourceTabId);
    if (!validJobId(jobId) || !job || job.jobId !== jobId || !["ready", "applied"].includes(job.state)
        || !job.result || !bindingCurrent(job.binding)) throw new Error("This preview is no longer current.");
    if (validateReady && job.state === "ready" && !job.mutation) {
      const suggestion = suggestions.get(job.result.suggestionId);
      if (!suggestion) throw new Error("The preview is no longer available.");
      await validateSuggestionSnapshot(sourceTabId, suggestion);
      if (jobs.get(sourceTabId) !== job || job.state !== "ready" || !bindingCurrent(job.binding)) throw new Error("This preview is no longer current.");
    }
    return job;
  }

  async function expandReview(sourceTabId: number, jobId: string): Promise<{ opened: true }> {
    await checkedReviewJob(sourceTabId, jobId, true);
    const existing = [...reviewBindings.values()].find((item) => item.sourceTabId === sourceTabId && item.jobId === jobId);
    if (existing) {
      try { await browser.windows.update(existing.windowId, { focused: true }); return { opened: true }; }
      catch { for (const [id, value] of reviewBindings) if (value === existing) reviewBindings.delete(id); }
    }
    const pending = reviewOpening.get(jobId);
    if (pending) { await pending; return { opened: true }; }
    const opening = (async () => {
      // Thunderbird can load an extension page before windows.create resolves.
      // Bind the real tab first, then navigate it to the review page.
      const created = await browser.windows.create({ type: "popup", url: "about:blank", width: 900, height: 700, allowScriptsToClose: true });
      const reviewTabId = created?.tabs?.[0]?.id ?? (created?.id ? (await browser.tabs.query({ windowId: created.id }))[0]?.id : undefined);
      if (!Number.isSafeInteger(reviewTabId) || reviewTabId <= 0 || !Number.isSafeInteger(created?.id)) throw new Error("The review window could not be opened.");
      try { await checkedReviewJob(sourceTabId, jobId, true); }
      catch (error) { await browser.windows.remove(created.id).catch(() => undefined); throw error; }
      reviewBindings.set(reviewTabId, { sourceTabId, jobId, windowId: created.id });
      try { await browser.tabs.update(reviewTabId, { url: browser.runtime.getURL("review.html") }); }
      catch (error) { reviewBindings.delete(reviewTabId); await browser.windows.remove(created.id).catch(() => undefined); throw error; }
    })();
    reviewOpening.set(jobId, opening);
    try { await opening; } finally { if (reviewOpening.get(jobId) === opening) reviewOpening.delete(jobId); }
    return { opened: true };
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
    return { jobId: job.jobId, state: job.state, startedAt: job.startedAt, action: job.action, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}) };
  }

  async function initializeMessage(tabId: number): Promise<any> {
    const lease = await controller.acquireFeatureLease();
    const [hello, listed, stored, acceptLanguages, uiLanguage, captured] = await Promise.all([
      lease.client.hello(), lease.client.listAgents(randomId()), browser.storage.local.get("messageTargetLanguage"),
      browser.i18n.getAcceptLanguages(), browser.i18n.getUILanguage(), captureDisplayedMessage(tabId),
    ]);
    if (!bindingCurrent(lease.binding)) throw new Error("The ThunderClaw connection changed.");
    const agents = compatibleAgents(listed.value);
    const selectedAgentId = agents.find((agent: any) => agent.isDefault)?.agentId || agents[0]?.agentId || null;
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

  function cancelRunningMessage(tabId: number, jobId: string): any {
    const job = messageJobs.get(tabId);
    if (!validJobId(jobId) || !job || job.jobId !== jobId) throw new Error("This message result is no longer current.");
    if (job.state !== "running") return messageJobView(job);
    job.state = "cancelled";
    job.abort.abort();
    void job.lease.client.cancelMessageTransform({ protocolVersion: 1, requestId: randomId(), transformRequestId: job.requestId, runId: job.runId, messageHash: job.messageHash }).catch(() => undefined);
    return messageJobView(job);
  }

  async function startMessageTransform(tabId: number, agentId: string, action: "translate" | "summarize", sourceLanguage: string | null, targetLanguage: string | null): Promise<any> {
    const existing = messageJobs.get(tabId);
    if (existing?.state === "running" || existing?.state === "finishing") return messageJobView(existing);
    const captured = messageCaptures.get(tabId);
    if (!captured) throw new Error("The displayed message is no longer available. Reopen ThunderClaw.");
    const requestId = randomId(); const runId = randomId(); const abort = new AbortController();
    const lease = await controller.acquireFeatureLease();
    if (messageCaptures.get(tabId) !== captured || !bindingCurrent(lease.binding)) throw new Error("The displayed message changed.");
    const job: MessageJob = { jobId: randomId(), state: "running", startedAt: Date.now(), action, requestId, runId, messageId: captured.messageId, messageHash: captured.messageHash, displayInstanceId: captured.displayInstanceId, lease, abort };
    messageJobs.set(tabId, job);
    try {
      await requireUsableAgent(lease, agentId, abort.signal);
      if (messageJobs.get(tabId) !== job || job.state !== "running" || abort.signal.aborted || messageCaptures.get(tabId) !== captured || !bindingCurrent(lease.binding)) {
        throw new Error("The displayed message changed.");
      }
    } catch (error) {
      if (messageJobs.get(tabId) === job && job.state !== "cancelled") messageJobs.delete(tabId);
      abort.abort();
      if (job.state === "cancelled") return messageJobView(job);
      throw error;
    }
    void (async () => {
      try {
        const completion = await lease.client.transformMessage({ protocolVersion: 1, requestId, runId, agentId, action, sourceLanguage, targetLanguage, messageHash: captured.messageHash, document: { subject: captured.subject, author: captured.author, segments: captured.segments }, limits: { maxSegments: 400, maxOutputCharacters: 200_000 } }, { signal: abort.signal });
        if (messageJobs.get(tabId) !== job || job.state !== "running" || abort.signal.aborted || !bindingCurrent(lease.binding) || !sameConnectionBinding(completion.binding, lease.binding)) return;
        const fresh = await captureDisplayedMessage(tabId);
        if (messageJobs.get(tabId) !== job || job.state !== "running" || abort.signal.aborted) return;
        if (fresh.messageId !== job.messageId || fresh.messageHash !== job.messageHash || fresh.displayInstanceId !== job.displayInstanceId || !bindingCurrent(lease.binding)) throw new Error("The displayed message changed while ThunderClaw was working.");
        job.state = "finishing";
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
        if (messageJobs.get(tabId) !== job || job.state === "cancelled" || !bindingCurrent(job.lease.binding)) return;
        job.state = "error"; job.error = featureErrorMessage(error);
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
    reviewBindings.delete(tabId);
    for (const [id, binding] of reviewBindings) if (binding.sourceTabId === tabId) reviewBindings.delete(id);
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

  async function dispatchPopupMessage(message: any): Promise<any> {
    if (message.type === "messagePopup.initialize") return initializeMessage(message.tabId);
    if (message.type === "messagePopup.transform") {
      const pending = pendingMessageStarts.get(message.tabId);
      if (pending) return pending;
      const starting = startMessageTransform(message.tabId, message.agentId, message.action, message.sourceLanguage, message.targetLanguage);
      pendingMessageStarts.set(message.tabId, starting);
      void starting.finally(() => { if (pendingMessageStarts.get(message.tabId) === starting) pendingMessageStarts.delete(message.tabId); }).catch(() => undefined);
      return starting;
    }
    if (message.type === "messagePopup.job") return Promise.resolve(messageJobView(messageJobs.get(message.tabId)));
    if (message.type === "messagePopup.original" || message.type === "messagePopup.translation") {
      const job = messageJobs.get(message.tabId);
      if (!validJobId(message.jobId) || !job || message.jobId !== job.jobId) return Promise.reject(new Error("This message result is no longer current."));
      return messageDisplayCall(message.tabId, { type: message.type === "messagePopup.original" ? "thunderclaw.message.original" : "thunderclaw.message.showTranslation", displayInstanceId: job.displayInstanceId });
    }
    if (message.type === "messagePopup.dismiss") return dismissMessageResult(message.tabId, message.jobId);
    if (message.type === "messagePopup.cancel") return cancelRunningMessage(message.tabId, message.jobId);
    if (message.type === "popup.initialize") return initialize(message.tabId);
    if (message.type === "popup.transform") {
      const pending = pendingComposeStarts.get(message.tabId);
      if (pending) return pending;
      const starting = startTransform(message.tabId, message.agentId, message.action, message.instruction);
      pendingComposeStarts.set(message.tabId, starting);
      void starting.finally(() => { if (pendingComposeStarts.get(message.tabId) === starting) pendingComposeStarts.delete(message.tabId); }).catch(() => undefined);
      return starting;
    }
    if (message.type === "popup.job") return Promise.resolve(composeJobView(jobs.get(message.tabId)));
    if (message.type === "popup.discard") {
      const job = jobs.get(message.tabId);
      if (!validJobId(message.jobId) || !job || job.jobId !== message.jobId || job.mutation) return Promise.reject(new Error("This preview is no longer current."));
      void Promise.allSettled(cancelComposeJob(message.tabId)); captures.delete(message.tabId);
      return Promise.resolve({ discarded: true });
    }
    if (message.type === "popup.apply") return applySuggestion(message.tabId, message.suggestionId, message.jobId);
    if (message.type === "popup.undo") return undoSuggestion(message.tabId, message.suggestionId, message.jobId);
    if (message.type === "popup.expand") return expandReview(message.tabId, message.jobId);
    if (message.type === "popup.cancel") return cancelRunningCompose(message.tabId, message.jobId);
    return undefined;
  }

  browser.runtime.onMessage.addListener((message: any, sender: any) => {
    if (!message || typeof message !== "object" || typeof message.type !== "string"
        || (!message.type.startsWith("popup.") && !message.type.startsWith("messagePopup.") && !message.type.startsWith("review."))) return undefined;
    if (message.type.startsWith("review.")) {
      if (sender?.id !== browser.runtime.id || sender?.url !== browser.runtime.getURL("review.html")
          || !Number.isSafeInteger(sender?.tab?.id) || !validReviewMessage(message)) {
        return Promise.reject(new Error("This ThunderClaw action is only available from its popup."));
      }
      return (async () => {
        const binding = reviewBindings.get(sender.tab.id);
        if (!binding) throw new Error("This preview is no longer current.");
        const source = await browser.tabs.get(binding.sourceTabId);
        if (source?.type !== "messageCompose") throw new Error("This preview is no longer current.");
        const job = await checkedReviewJob(binding.sourceTabId, binding.jobId, message.type === "review.initialize");
        if (message.jobId !== undefined && message.jobId !== binding.jobId) throw new Error("This preview is no longer current.");
        if (message.type === "review.initialize" || message.type === "review.job") return { job: composeJobView(job) };
        if (message.type === "review.apply") return { job: await applySuggestion(binding.sourceTabId, message.suggestionId, binding.jobId) };
        if (message.type === "review.undo") return { job: await undoSuggestion(binding.sourceTabId, message.suggestionId, binding.jobId) };
        if (message.type === "review.discard") {
          if (job.state !== "ready" || job.mutation) throw new Error("This preview is no longer current.");
          void Promise.allSettled(cancelComposeJob(binding.sourceTabId)); captures.delete(binding.sourceTabId); return { discarded: true };
        }
        return undefined;
      })().catch((error) => { throw new Error(featureErrorMessage(error)); });
    }
    const reading = message.type.startsWith("messagePopup.");
    const expectedUrl = browser.runtime.getURL(reading ? "message-popup.html" : "popup.html");
    // Thunderbird may include tab metadata for an extension action popup.
    // The extension identity and exact page URL establish the trusted sender.
    if (sender?.id !== browser.runtime.id || sender?.url !== expectedUrl) {
      return Promise.reject(new Error("This ThunderClaw action is only available from its popup."));
    }
    if (!validPopupMessage(message)) return Promise.reject(new Error("The ThunderClaw popup request is invalid."));
    return (async () => {
      const tab = await browser.tabs.get(message.tabId);
      if (reading ? !["mail", "messageDisplay"].includes(tab?.type) : tab?.type !== "messageCompose") {
        throw new Error(reading ? "Open ThunderClaw while viewing a message." : "Open ThunderClaw from a message compose window.");
      }
      return dispatchPopupMessage(message);
    })().catch((error) => { throw new Error(featureErrorMessage(error)); });
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
