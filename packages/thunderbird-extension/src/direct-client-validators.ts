import {
  DirectClientError,
  THUNDERCLAW_PLUGIN_ID,
  THUNDERCLAW_PROTOCOL_VERSION,
  type AgentListResponse,
  type AgentProbeRequest,
  type AgentProbeResponse,
  type AgentRecord,
  type CancelAgentProbeRequest,
  type CancelAgentProbeResponse,
  type CancelComposeRequest,
  type CancelComposeResponse,
  type CancelMessageRequest,
  type CancelMessageResponse,
  type CloseComposeResponse,
  type EditResult,
  type GatewayStatus,
  type MessageTransformResult,
  type OpenComposeRequest,
  type OpenComposeResponse,
  type RunEvidence,
  type RichBlock,
  type RichTextSpan,
  type TransformComposeRequest,
  type TransformComposeResponse,
  type TransformMessageRequest,
  type TransformMessageResponse,
} from "./direct-client-contract.js";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const COMPOSE_UNSAFE_CHARACTERS = /[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const LIST_ITEM_UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
const RICH_TEXT_UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
const RICH_MARKS = ["bold", "italic", "underline"] as const;
const MARKDOWN_LIST_LINE = /(?:^|\n)[\t ]*(?:[-+*]|\d+[.)])[\t ]+\S/u;
const NEGATED_LIST_INSTRUCTION = /\b(?:do[\t ]+not|don['’]t|dont|never|avoid|remove|without)\b[^\r\n.!?]{0,64}\b(?:bullets?|bullet(?:ed)?[\t ]+(?:list|points?|items?)|(?:numbered|ordered|enumerated|unordered)[\t ]+list|list)\b|\b(?:not|no)[\t ]+(?:an?[\t ]+)?(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list|list)\b|\b(?:instead[\t ]+of|rather[\t ]+than)[\t ]+(?:an?[\t ]+)?(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list|list)\b/iu;
const MIXED_BLOCK_INSTRUCTION = /\b(?:paragraphs?|intro(?:duction)?|opening|conclusion|closing)\b[^\r\n.!?]{0,64}\b(?:then|and|with|plus|along[\t ]+with|followed[\t ]+by)\b[^\r\n.!?]{0,64}\b(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list)\b|\b(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list)\b[^\r\n.!?]{0,64}\b(?:then|and|with|plus|along[\t ]+with|followed[\t ]+by)\b[^\r\n.!?]{0,64}\b(?:paragraphs?|intro(?:duction)?|opening|conclusion|closing)\b/iu;
const ORDERED_LIST_INSTRUCTION = /\b(?:convert|turn|format|reformat|restructure|rewrite|present|put|change|make|give|create|write|produce|return)\b[^\r\n.!?]{0,64}\b(?:numbered|ordered|enumerated)[\t ]+(?:list|points?|items?)\b/iu;
const UNORDERED_LIST_INSTRUCTION = /\b(?:convert|turn|format|reformat|restructure|rewrite|present|put|change|make|give|create|write|produce|return)\b[^\r\n.!?]{0,64}\b(?:unordered[\t ]+list|bullets?|bullet(?:ed)?[\t ]+(?:list|points?|items?))\b/iu;
const GENERIC_LIST_INSTRUCTION = /\b(?:convert|turn|format|reformat|restructure|present|put|change|make)\b[^\r\n.!?]{0,64}\b(?:as|into|to|in)[\t ]+an?[\t ]+list\b/iu;
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_IDENTIFIER_CHARACTERS = 512;
const MAX_REQUEST_STRING_CHARACTERS = 1_048_576;
const MAX_LANGUAGE_CHARACTERS = 256;

function canonicalReplacementText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").split(/(\n[\t ]*\n(?:[\t ]*\n)*)/u)
    .map((part, index) => index % 2 === 0 ? part.replace(/[\t ]*\n[\t ]*/gu, " ") : "\n\n")
    .join("");
}

function requestedRichListType(instruction: string | null | undefined): "unordered_list" | "ordered_list" | undefined {
  if (!instruction) return undefined;
  if (NEGATED_LIST_INSTRUCTION.test(instruction) || MIXED_BLOCK_INSTRUCTION.test(instruction)) return undefined;
  if (ORDERED_LIST_INSTRUCTION.test(instruction)) return "ordered_list";
  if (UNORDERED_LIST_INSTRUCTION.test(instruction) || GENERIC_LIST_INSTRUCTION.test(instruction)) return "unordered_list";
  return undefined;
}

function invalid(code: string, message: string): never {
  throw new DirectClientError("contract", code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("INVALID_BACKEND_RESPONSE", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function richSpans(value: unknown, label: string): RichTextSpan[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) invalid("INVALID_BACKEND_RESPONSE", `${label} spans are invalid`);
  const spans = value.map((candidate) => {
    const span = record(candidate, `${label} span`);
    if (!exactKeys(span, span.marks === undefined ? ["text"] : ["text", "marks"])
      || typeof span.text !== "string" || span.text.length < 1 || RICH_TEXT_UNSAFE_CHARACTERS.test(span.text)) {
      invalid("INVALID_BACKEND_RESPONSE", `${label} span text is invalid`);
    }
    if (span.marks === undefined) return { text: span.text };
    const candidateMarks = span.marks;
    if (!Array.isArray(candidateMarks) || candidateMarks.length < 1 || candidateMarks.length > RICH_MARKS.length
      || candidateMarks.some((mark) => typeof mark !== "string" || !RICH_MARKS.includes(mark as typeof RICH_MARKS[number]))
      || new Set(candidateMarks).size !== candidateMarks.length
      || JSON.stringify(candidateMarks) !== JSON.stringify(RICH_MARKS.filter((mark) => candidateMarks.includes(mark)))) {
      invalid("INVALID_BACKEND_RESPONSE", `${label} span marks are invalid`);
    }
    return { text: span.text, marks: [...candidateMarks] as Array<"bold" | "italic" | "underline"> };
  });
  if (!spans.some((span) => span.text.trim().length > 0)) invalid("INVALID_BACKEND_RESPONSE", `${label} must contain visible text`);
  return spans;
}

function richBlocks(value: unknown): RichBlock[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) invalid("INVALID_BACKEND_RESPONSE", "rich blocks are invalid");
  let characters = 0;
  const blocks = value.map((candidate, blockIndex) => {
    const block = record(candidate, "rich block");
    if (block.type === "paragraph") {
      if (!exactKeys(block, ["type", "spans"])) invalid("INVALID_BACKEND_RESPONSE", "rich paragraph fields are invalid");
      const spans = richSpans(block.spans, `paragraph ${blockIndex}`);
      characters += spans.reduce((sum, span) => sum + span.text.length, 0);
      return { type: "paragraph" as const, spans };
    }
    if ((block.type === "unordered_list" || block.type === "ordered_list")
      && Array.isArray(block.items) && block.items.length >= 1 && block.items.length <= 100) {
      const items = block.items.map((candidateItem, itemIndex) => {
        const item = record(candidateItem, "rich list item");
        if (!exactKeys(item, ["spans"])) invalid("INVALID_BACKEND_RESPONSE", "rich list item fields are invalid");
        const spans = richSpans(item.spans, `list item ${blockIndex}:${itemIndex}`);
        characters += spans.reduce((sum, span) => sum + span.text.length, 0);
        return { spans };
      });
      return { type: block.type, items } as RichBlock;
    }
    return invalid("INVALID_BACKEND_RESPONSE", "rich block type is invalid");
  });
  if (characters > 12_000) invalid("OUTPUT_TOO_LARGE", "rich block output exceeds the limit");
  return blocks;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || ALL_CONTROL_CHARACTERS.test(value)) {
    return invalid("INVALID_BACKEND_RESPONSE", `${label} must be a non-empty string`);
  }
  return value;
}

function canonicalUtcTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length !== 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return invalid("INVALID_BACKEND_RESPONSE", `${label} must be a canonical UTC timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch)) invalid("INVALID_BACKEND_RESPONSE", `${label} must be a canonical UTC timestamp`);
  let canonical: string;
  try {
    canonical = new Date(epoch).toISOString();
  } catch {
    return invalid("INVALID_BACKEND_RESPONSE", `${label} must be a canonical UTC timestamp`);
  }
  if (canonical !== value) invalid("INVALID_BACKEND_RESPONSE", `${label} must be a canonical UTC timestamp`);
  return canonical;
}

function requestFailure(code: string, message: string): never {
  throw new DirectClientError("contract", code, message);
}

function requestString(value: unknown, label: string, maximum = MAX_REQUEST_STRING_CHARACTERS, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    return requestFailure("INVALID_REQUEST", `${label} is invalid`);
  }
  return value;
}

function requestId(value: unknown, label: string): string {
  const validated = requestString(value, label, MAX_IDENTIFIER_CHARACTERS);
  if (validated.trim().length === 0 || ALL_CONTROL_CHARACTERS.test(validated)) requestFailure("INVALID_REQUEST", `${label} is invalid`);
  return validated;
}

function requestRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return requestFailure("INVALID_REQUEST", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function requestProtocol(value: Record<string, unknown>): void {
  if (value.protocolVersion !== THUNDERCLAW_PROTOCOL_VERSION) requestFailure("UNSUPPORTED_PROTOCOL", "protocolVersion must be 1");
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return requestFailure("INVALID_REQUEST", `${label} must be a positive safe integer`);
  return value as number;
}

function exactRequestKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key)) || expected.some((key) => !(key in value))) {
    requestFailure("INVALID_REQUEST", `${label} contains unexpected or missing fields`);
  }
}

export function validateListAgentsRequestId(value: unknown): string {
  return requestId(value, "requestId");
}

export function validateAgentProbeRequest(value: unknown): AgentProbeRequest {
  const request = requestRecord(value, "agent probe request");
  exactRequestKeys(request, ["protocolVersion", "requestId", "probeRunId", "agentId"], "agent probe request");
  requestProtocol(request);
  const validatedRequestId = requestId(request.requestId, "requestId");
  const probeRunId = requestId(request.probeRunId, "probeRunId");
  if (validatedRequestId === probeRunId) requestFailure("INVALID_REQUEST", "requestId and probeRunId must be distinct");
  return {
    protocolVersion: 1,
    requestId: validatedRequestId,
    probeRunId,
    agentId: requestId(request.agentId, "agentId"),
  };
}

export function validateCancelAgentProbeRequest(value: unknown): CancelAgentProbeRequest {
  return validateAgentProbeRequest(value);
}

export function validateOpenComposeRequest(value: unknown): OpenComposeRequest {
  const request = requestRecord(value, "request");
  requestProtocol(request);
  return {
    protocolVersion: 1,
    requestId: requestId(request.requestId, "requestId"),
    composeId: requestId(request.composeId, "composeId"),
    composeGeneration: positiveInteger(request.composeGeneration, "composeGeneration"),
    agentId: requestId(request.agentId, "agentId"),
  };
}

export function validateTransformComposeRequest(value: unknown): TransformComposeRequest {
  const request = requestRecord(value, "request");
  const base = validateOpenComposeRequest(request);
  const document = requestRecord(request.document, "document");
  const target = requestRecord(request.target, "target");
  const limits = requestRecord(request.limits, "limits");
  const actions: TransformComposeRequest["action"][] = ["improve", "proofread", "shorten", "tone", "translate", "summarize", "ask"];
  if (typeof request.action !== "string" || !actions.includes(request.action as TransformComposeRequest["action"])) requestFailure("INVALID_REQUEST", "unsupported compose action");
  if (!Array.isArray(document.recipients)) requestFailure("INVALID_REQUEST", "document.recipients must be an array");
  const recipients = document.recipients.map((recipient) => requestString(recipient, "recipient", MAX_REQUEST_STRING_CHARACTERS, true));
  const text = requestString(target.text, "target.text");
  const selectionShape = target.selectionShape === undefined ? undefined : target.selectionShape;
  if (selectionShape !== undefined && selectionShape !== "text-range" && selectionShape !== "flat-list-items"
    && selectionShape !== "rich-blocks") requestFailure("INVALID_REQUEST", "unsupported selection shape");
  let targetItems: string[] | undefined;
  if (selectionShape === "flat-list-items") {
    if (!Array.isArray(target.items) || target.items.length < 1 || target.items.length > 100) requestFailure("INVALID_REQUEST", "flat list items are invalid");
    targetItems = target.items.map((item) => requestString(item, "target.items", MAX_REQUEST_STRING_CHARACTERS));
    if (targetItems.some((item) => item.trim().length === 0 || LIST_ITEM_UNSAFE_CHARACTERS.test(item))
      || targetItems.join("\n") !== text) requestFailure("INVALID_REQUEST", "flat list items are invalid");
  } else if (target.items !== undefined) requestFailure("INVALID_REQUEST", "text range target must not contain items");
  const start = target.start;
  const end = target.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number) || (end as number) > text.length) requestFailure("INVALID_REQUEST", "target range is out of bounds");
  const instruction = request.instruction == null ? null : requestString(request.instruction, "instruction");
  const quotedText = typeof document.quotedText === "undefined" ? undefined : requestString(document.quotedText, "document.quotedText", MAX_REQUEST_STRING_CHARACTERS, true);
  return {
    ...base,
    runId: requestId(request.runId, "runId"),
    action: request.action as TransformComposeRequest["action"],
    instruction,
    contextHash: requestId(request.contextHash, "contextHash"),
    targetHash: requestId(request.targetHash, "targetHash"),
    document: {
      subject: requestString(document.subject, "document.subject", MAX_REQUEST_STRING_CHARACTERS, true),
      recipients,
      authoredText: requestString(document.authoredText, "document.authoredText"),
      ...(quotedText === undefined ? {} : { quotedText }),
    },
    target: {
      targetId: requestId(target.targetId, "targetId"),
      text,
      start: start as number,
      end: end as number,
      ...(selectionShape === undefined ? {} : { selectionShape }),
      ...(targetItems === undefined ? {} : { items: targetItems }),
    },
    limits: {
      maxOperations: positiveInteger(limits.maxOperations, "limits.maxOperations"),
      maxOutputCharacters: positiveInteger(limits.maxOutputCharacters, "limits.maxOutputCharacters"),
    },
  };
}

export function validateCancelComposeRequest(value: unknown): CancelComposeRequest {
  const request = requestRecord(value, "request");
  const base = validateOpenComposeRequest(request);
  return { ...base, runId: requestId(request.runId, "runId") };
}

export function validateTransformMessageRequest(value: unknown): TransformMessageRequest {
  const request = requestRecord(value, "request");
  requestProtocol(request);
  if (request.action !== "translate" && request.action !== "summarize") requestFailure("INVALID_REQUEST", "message action must be translate or summarize");
  const document = requestRecord(request.document, "document");
  const limits = requestRecord(request.limits, "limits");
  const maxSegments = positiveInteger(limits.maxSegments, "limits.maxSegments");
  if (!Array.isArray(document.segments) || document.segments.length === 0 || document.segments.length > maxSegments) requestFailure("INVALID_REQUEST", "document segment count is invalid");
  const ids = new Set<string>();
  const segments = document.segments.map((value) => {
    const segment = requestRecord(value, "segment");
    const id = requestId(segment.id, "segment.id");
    if (ids.has(id)) requestFailure("INVALID_REQUEST", "segment IDs must be unique");
    ids.add(id);
    return { id, text: requestString(segment.text, "segment.text") };
  });
  const language = (value: unknown, label: string): string => {
    const validated = requestString(value, label, MAX_LANGUAGE_CHARACTERS);
    if (ALL_CONTROL_CHARACTERS.test(validated)) requestFailure("INVALID_REQUEST", `${label} is invalid`);
    return validated;
  };
  const sourceLanguage = request.sourceLanguage == null ? null : language(request.sourceLanguage, "sourceLanguage");
  const targetLanguage = request.targetLanguage == null ? null : language(request.targetLanguage, "targetLanguage");
  if (request.action === "translate" && targetLanguage === null) requestFailure("INVALID_REQUEST", "targetLanguage is required for translation");
  return {
    protocolVersion: 1,
    requestId: requestId(request.requestId, "requestId"),
    runId: requestId(request.runId, "runId"),
    agentId: requestId(request.agentId, "agentId"),
    action: request.action,
    sourceLanguage,
    targetLanguage,
    messageHash: requestId(request.messageHash, "messageHash"),
    document: {
      subject: requestString(document.subject, "document.subject", MAX_REQUEST_STRING_CHARACTERS, true),
      author: requestString(document.author, "document.author", MAX_REQUEST_STRING_CHARACTERS, true),
      segments,
    },
    limits: { maxSegments, maxOutputCharacters: positiveInteger(limits.maxOutputCharacters, "limits.maxOutputCharacters") },
  };
}

export function validateCancelMessageRequest(value: unknown): CancelMessageRequest {
  const request = requestRecord(value, "request");
  requestProtocol(request);
  const expectedKeys = new Set(["protocolVersion", "requestId", "transformRequestId", "runId", "messageHash"]);
  if (Object.keys(request).some((key) => !expectedKeys.has(key))) requestFailure("INVALID_REQUEST", "message cancel request contains unknown fields");
  return {
    protocolVersion: 1,
    requestId: requestId(request.requestId, "requestId"),
    transformRequestId: requestId(request.transformRequestId, "transformRequestId"),
    runId: requestId(request.runId, "runId"),
    messageHash: requestId(request.messageHash, "messageHash"),
  };
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, label);
}

function protocol(value: Record<string, unknown>): void {
  if (value.protocolVersion !== THUNDERCLAW_PROTOCOL_VERSION) {
    invalid("UNSUPPORTED_PROTOCOL", "ThunderClaw protocol version is not supported");
  }
}

function evidence(value: unknown): RunEvidence {
  const candidate = record(value, "evidence");
  const provider = candidate.provider;
  const model = candidate.model;
  if (provider !== undefined && typeof provider !== "string") invalid("INVALID_BACKEND_RESPONSE", "evidence.provider must be a string");
  if (model !== undefined && typeof model !== "string") invalid("INVALID_BACKEND_RESPONSE", "evidence.model must be a string");
  if (candidate.runtimeSessionMarker !== null && typeof candidate.runtimeSessionMarker !== "string") {
    invalid("INVALID_BACKEND_RESPONSE", "evidence.runtimeSessionMarker is invalid");
  }
  if (typeof candidate.repairAttempted !== "boolean") invalid("INVALID_BACKEND_RESPONSE", "evidence.repairAttempted must be boolean");
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    runtimeSessionMarker: candidate.runtimeSessionMarker,
    repairAttempted: candidate.repairAttempted,
  };
}

export function validateGatewayStatus(value: unknown): GatewayStatus {
  const response = record(value, "response");
  protocol(response);
  if (response.plugin !== THUNDERCLAW_PLUGIN_ID) invalid("UNEXPECTED_PLUGIN", "unexpected plugin identity");
  const rawCapabilities = record(response.capabilities, "capabilities");
  const capabilities: Record<string, boolean | string> = {};
  for (const [key, capability] of Object.entries(rawCapabilities)) {
    if (typeof capability !== "boolean" && typeof capability !== "string") {
      invalid("INVALID_BACKEND_RESPONSE", `capability ${key} has an invalid value`);
    }
    capabilities[key] = capability;
  }
  return {
    protocolVersion: 1,
    plugin: "thunderclaw",
    gatewayVersion: nonEmptyString(response.gatewayVersion, "gatewayVersion"),
    capabilities,
  };
}

function validateAgent(value: unknown): AgentRecord {
  const candidate = record(value, "agent");
  const rawReasoning = record(candidate.reasoning, "agent.reasoning");
  const rawLevels = rawReasoning.levels;
  if (!Array.isArray(rawLevels)) invalid("INVALID_BACKEND_RESPONSE", "agent.reasoning.levels must be an array");
  const levels = rawLevels.map((value) => {
    const level = record(value, "reasoning level");
    return { id: nonEmptyString(level.id, "reasoning level id"), label: nonEmptyString(level.label, "reasoning level label") };
  });
  const rawCompatibility = record(candidate.compatibility, "agent.compatibility");
  const states: AgentRecord["compatibility"]["state"][] = ["unverified", "partially_verified", "verified", "incompatible", "unsupported"];
  if (typeof rawCompatibility.state !== "string" || !states.includes(rawCompatibility.state as AgentRecord["compatibility"]["state"])) invalid("INVALID_BACKEND_RESPONSE", "compatibility.state is invalid");
  if (rawCompatibility.executionMode !== "restricted-agent" || rawCompatibility.usesPersonality !== true || rawCompatibility.usesMemory !== true || rawCompatibility.toolsDisabled !== true) invalid("INVALID_BACKEND_RESPONSE", "agent compatibility safety mode is invalid");
  const rawChecks = record(rawCompatibility.checks, "agent.compatibility.checks");
  const check = (name: string, configuration = false): "passed" | "failed" | "not_run" | "not_applicable" => {
    const value = rawChecks[name];
    if (value !== "passed" && value !== "failed" && (configuration || (value !== "not_run" && value !== "not_applicable"))) invalid("INVALID_BACKEND_RESPONSE", `compatibility check ${name} is invalid`);
    return value;
  };
  let lastProbe: AgentRecord["compatibility"]["lastProbe"] = null;
  if (rawCompatibility.lastProbe !== null) {
    const rawProbe = record(rawCompatibility.lastProbe, "agent.compatibility.lastProbe");
    lastProbe = {
      testedAt: canonicalUtcTimestamp(rawProbe.testedAt, "lastProbe.testedAt"),
      observedProvider: rawProbe.observedProvider === null ? null : nonEmptyString(rawProbe.observedProvider, "lastProbe.observedProvider"),
      observedModel: rawProbe.observedModel === null ? null : nonEmptyString(rawProbe.observedModel, "lastProbe.observedModel"),
    };
  }
  if (typeof candidate.isDefault !== "boolean") invalid("INVALID_BACKEND_RESPONSE", "agent.isDefault must be boolean");
  const configurationCheck = check("configuration", true);
  if (configurationCheck !== "passed" && configurationCheck !== "failed") invalid("INVALID_BACKEND_RESPONSE", "compatibility configuration check is invalid");
  const checks = {
    configuration: configurationCheck,
    credentials: check("credentials"),
    structuredOutput: check("structuredOutput"),
    toolIsolation: check("toolIsolation"),
    cancellation: check("cancellation"),
    fallbacks: check("fallbacks"),
  };
  const coreChecks = [checks.credentials, checks.structuredOutput, checks.toolIsolation, checks.cancellation];
  const state = rawCompatibility.state as AgentRecord["compatibility"]["state"];
  const validSemantics = (() => {
    switch (state) {
      case "verified":
        return checks.configuration === "passed"
          && coreChecks.every((value) => value === "passed")
          && (checks.fallbacks === "passed" || checks.fallbacks === "not_applicable")
          && lastProbe !== null;
      case "partially_verified":
        return checks.configuration === "passed"
          && coreChecks.every((value) => value === "passed")
          && checks.fallbacks === "not_run"
          && lastProbe !== null;
      case "incompatible":
        return checks.configuration === "passed"
          && [...coreChecks, checks.fallbacks].some((value) => value === "failed")
          && lastProbe !== null;
      case "unverified":
        return checks.configuration === "passed"
          && [...coreChecks, checks.fallbacks].every((value) => value === "not_run")
          && lastProbe === null;
      case "unsupported":
        return checks.configuration === "failed"
          && [...coreChecks, checks.fallbacks].every((value) => value === "not_run")
          && lastProbe === null;
    }
  })();
  if (!validSemantics) invalid("INVALID_BACKEND_RESPONSE", "agent compatibility evidence contradicts its state");
  if (typeof rawCompatibility.reason !== "string" || ALL_CONTROL_CHARACTERS.test(rawCompatibility.reason)) invalid("INVALID_BACKEND_RESPONSE", "compatibility.reason must be plain text");
  return {
    agentId: nonEmptyString(candidate.agentId, "agentId"),
    displayName: nonEmptyString(candidate.displayName, "displayName"),
    isDefault: candidate.isDefault,
    provider: candidate.provider === null ? null : nonEmptyString(candidate.provider, "provider"),
    model: candidate.model === null ? null : nonEmptyString(candidate.model, "model"),
    reasoning: {
      defaultLevel: rawReasoning.defaultLevel === null ? null : nonEmptyString(rawReasoning.defaultLevel, "reasoning.defaultLevel"),
      levels,
    },
    compatibility: {
      state,
      executionMode: "restricted-agent",
      usesPersonality: true,
      usesMemory: true,
      toolsDisabled: true,
      checks,
      lastProbe,
      reason: rawCompatibility.reason,
    },
  };
}

export function validateAgentListResponse(value: unknown, requestId: string): AgentListResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.requestId !== requestId || !Array.isArray(response.agents)) {
    invalid("MISMATCHED_REQUEST", "agent response identity is invalid");
  }
  return { protocolVersion: 1, requestId, agents: response.agents.map(validateAgent) };
}

export function validateAgentProbeResponse(value: unknown, request: AgentProbeRequest): AgentProbeResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.requestId !== request.requestId || response.probeRunId !== request.probeRunId) {
    invalid("MISMATCHED_RUN", "agent probe response identity is invalid");
  }
  const agent = validateAgent(response.agent);
  if (agent.agentId !== request.agentId) invalid("AGENT_MISMATCH", "agent probe result belongs to another agent");
  return { protocolVersion: 1, requestId: request.requestId, probeRunId: request.probeRunId, agent };
}

export function validateCancelAgentProbeResponse(value: unknown, request: CancelAgentProbeRequest): CancelAgentProbeResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.requestId !== request.requestId || response.probeRunId !== request.probeRunId || response.agentId !== request.agentId || response.cancelled !== true) {
    invalid("MISMATCHED_RUN", "agent probe cancel acknowledgement is invalid");
  }
  return { protocolVersion: 1, requestId: request.requestId, probeRunId: request.probeRunId, agentId: request.agentId, cancelled: true };
}

export function validateOpenComposeResponse(value: unknown, request: OpenComposeRequest): OpenComposeResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.requestId !== request.requestId || response.composeId !== request.composeId || response.composeGeneration !== request.composeGeneration) {
    invalid("STALE_OR_MISMATCHED_RESULT", "opened compose identity is invalid");
  }
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    composeId: request.composeId,
    composeGeneration: request.composeGeneration,
    sessionId: nonEmptyString(response.sessionId, "sessionId"),
  };
}

function validateEditResult(value: unknown, request: TransformComposeRequest): EditResult {
  const result = record(value, "result");
  if (result.version !== 1 || result.requestId !== request.requestId || result.composeGeneration !== request.composeGeneration || result.contextHash !== request.contextHash || result.targetHash !== request.targetHash) {
    invalid("STALE_OR_MISMATCHED_RESULT", "result identity does not match the current compose snapshot");
  }
  if (!Array.isArray(result.operations) || result.operations.length < 1 || result.operations.length > request.limits.maxOperations) {
    invalid("INVALID_BACKEND_RESPONSE", "result has an invalid operation count");
  }
  let outputCharacters = 0;
  const operations = result.operations.map((value) => {
    const operation = record(value, "operation");
    if (operation.targetId !== request.target.targetId) {
      invalid("INVALID_BACKEND_RESPONSE", "result operation is outside the editable target");
    }
    if (request.target.selectionShape === "flat-list-items") {
      if (operation.type !== "replace_flat_list_items" || !Array.isArray(operation.items)
        || operation.items.length < 1 || operation.items.length > 100
        || operation.items.some((item) => typeof item !== "string" || item.trim().length === 0
          || LIST_ITEM_UNSAFE_CHARACTERS.test(item))) {
        invalid("INVALID_BACKEND_RESPONSE", "flat list replacement items are invalid");
      }
      outputCharacters += operation.items.reduce((sum, item) => sum + item.length, 0);
      return { type: "replace_flat_list_items" as const, targetId: request.target.targetId, items: [...operation.items] };
    }
    if (request.target.selectionShape === "rich-blocks") {
      if (operation.type !== "replace_rich_blocks" || !exactKeys(operation, ["type", "targetId", "blocks"])) {
        invalid("INVALID_BACKEND_RESPONSE", "rich block target requires rich block replacement");
      }
      const blocks = richBlocks(operation.blocks);
      const requiredListType = requestedRichListType(request.instruction);
      if (requiredListType && !blocks.every((block) => block.type === requiredListType)) {
        invalid("INVALID_BACKEND_RESPONSE", `requested ${requiredListType} output must contain only that typed list block`);
      }
      outputCharacters += blocks.reduce((total, block) => total + (block.type === "paragraph"
        ? block.spans.reduce((sum, span) => sum + span.text.length, 0)
        : block.items.reduce((sum, item) => sum + item.spans.reduce((spanSum, span) => spanSum + span.text.length, 0), 0)), 0);
      return { type: "replace_rich_blocks" as const, targetId: request.target.targetId, blocks };
    }
    if (operation.type !== "replace_text_range" || operation.start !== request.target.start
      || operation.end !== request.target.end || typeof operation.text !== "string") {
      invalid("INVALID_BACKEND_RESPONSE", "result operation is outside the editable target");
    }
    if (MARKDOWN_LIST_LINE.test(operation.text.replace(/\r\n?/gu, "\n"))) {
      invalid("INVALID_BACKEND_RESPONSE", "plain text replacement contains Markdown list syntax");
    }
    const replacementText = canonicalReplacementText(operation.text);
    if (COMPOSE_UNSAFE_CHARACTERS.test(replacementText)) invalid("UNSAFE_BACKEND_RESPONSE", "result contains HTML-like or control characters");
    outputCharacters += replacementText.length;
    return { type: "replace_text_range" as const, targetId: request.target.targetId, start: request.target.start, end: request.target.end, text: replacementText };
  });
  if (typeof result.summary !== "string") invalid("INVALID_BACKEND_RESPONSE", "result summary must be a string");
  if (COMPOSE_UNSAFE_CHARACTERS.test(result.summary)) invalid("UNSAFE_BACKEND_RESPONSE", "result summary contains HTML-like or control characters");
  outputCharacters += result.summary.length;
  if (outputCharacters > request.limits.maxOutputCharacters) invalid("OUTPUT_TOO_LARGE", "result exceeds the requested output limit");
  return { version: 1, requestId: request.requestId, composeGeneration: request.composeGeneration, contextHash: request.contextHash, targetHash: request.targetHash, operations, summary: result.summary };
}

export function validateTransformComposeResponse(value: unknown, request: TransformComposeRequest): TransformComposeResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.runId !== request.runId) invalid("MISMATCHED_RUN", "transform run identity is invalid");
  return { protocolVersion: 1, runId: request.runId, result: validateEditResult(response.result, request), evidence: evidence(response.evidence) };
}

export function validateCancelComposeResponse(value: unknown, request: CancelComposeRequest): CancelComposeResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.requestId !== request.requestId || response.runId !== request.runId || response.cancelled !== true) invalid("MISMATCHED_RUN", "cancel acknowledgement is invalid");
  return { protocolVersion: 1, requestId: request.requestId, runId: request.runId, cancelled: true };
}

export function validateCloseComposeResponse(value: unknown, request: OpenComposeRequest): CloseComposeResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.requestId !== request.requestId || response.composeId !== request.composeId || response.composeGeneration !== request.composeGeneration || response.closed !== true) invalid("STALE_OR_MISMATCHED_RESULT", "close acknowledgement is invalid");
  return { protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, closed: true };
}

function validateMessageResult(value: unknown, request: TransformMessageRequest): MessageTransformResult {
  const result = record(value, "result");
  if (result.version !== 1 || result.requestId !== request.requestId || result.messageHash !== request.messageHash || result.action !== request.action) invalid("STALE_OR_MISMATCHED_RESULT", "message result identity does not match the displayed message");
  if (!Array.isArray(result.segments)) invalid("INVALID_BACKEND_RESPONSE", "message result segments are invalid");
  let outputCharacters = 0;
  const segments = result.segments.map((value) => {
    const segment = record(value, "segment");
    const id = nonEmptyString(segment.id, "segment.id");
    if (typeof segment.text !== "string") invalid("INVALID_BACKEND_RESPONSE", "segment.text must be a string");
    if (CONTROL_CHARACTERS.test(segment.text)) invalid("UNSAFE_BACKEND_RESPONSE", "message result contains control characters");
    outputCharacters += segment.text.length;
    return { id, text: segment.text };
  });
  let summary: MessageTransformResult["summary"] = null;
  if (result.summary !== null) {
    const rawSummary = record(result.summary, "summary");
    if (typeof rawSummary.title !== "string" || !Array.isArray(rawSummary.bullets)) invalid("INVALID_BACKEND_RESPONSE", "message summary is invalid");
    const bullets = rawSummary.bullets.map((bullet) => typeof bullet === "string" ? bullet : invalid("INVALID_BACKEND_RESPONSE", "summary bullet must be a string"));
    if ([rawSummary.title, ...bullets].some((text) => CONTROL_CHARACTERS.test(text))) invalid("UNSAFE_BACKEND_RESPONSE", "message summary contains control characters");
    outputCharacters += rawSummary.title.length + bullets.reduce((total, bullet) => total + bullet.length, 0);
    summary = { title: rawSummary.title, bullets };
  }
  if (outputCharacters > request.limits.maxOutputCharacters) invalid("OUTPUT_TOO_LARGE", "message result exceeds the requested output limit");
  const targetLanguage = result.targetLanguage === null ? null : nullableString(result.targetLanguage, "targetLanguage");
  if (targetLanguage !== (request.targetLanguage ?? null)) invalid("STALE_OR_MISMATCHED_RESULT", "message result target language does not match the request");
  if (request.action === "translate") {
    const expected = new Set(request.document.segments.map(({ id }) => id));
    if (segments.length !== expected.size || segments.some(({ id }) => !expected.delete(id)) || expected.size !== 0 || summary !== null || result.targetLanguage !== request.targetLanguage) invalid("STALE_OR_MISMATCHED_RESULT", "translation does not match the requested segments and language");
  } else if (segments.length !== 0 || summary === null || summary.bullets.length < 1 || summary.bullets.length > 8) {
    invalid("INVALID_BACKEND_RESPONSE", "summary result shape is invalid");
  }
  return {
    version: 1,
    requestId: request.requestId,
    messageHash: request.messageHash,
    action: request.action,
    detectedLanguage: result.detectedLanguage === null ? null : nullableString(result.detectedLanguage, "detectedLanguage"),
    targetLanguage,
    segments,
    summary,
  };
}

export function validateTransformMessageResponse(value: unknown, request: TransformMessageRequest): TransformMessageResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.runId !== request.runId) invalid("MISMATCHED_RUN", "message transform run identity is invalid");
  return { protocolVersion: 1, runId: request.runId, result: validateMessageResult(response.result, request), evidence: evidence(response.evidence) };
}

export function validateCancelMessageResponse(value: unknown, request: CancelMessageRequest): CancelMessageResponse {
  const response = record(value, "response");
  protocol(response);
  if (response.requestId !== request.requestId || response.transformRequestId !== request.transformRequestId || response.runId !== request.runId || response.messageHash !== request.messageHash || response.cancelled !== true) invalid("MISMATCHED_RUN", "message cancel acknowledgement is invalid");
  return { protocolVersion: 1, requestId: request.requestId, transformRequestId: request.transformRequestId, runId: request.runId, messageHash: request.messageHash, cancelled: true };
}
