export const PROTOCOL_VERSION = 1 as const;
const LIST_ITEM_UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
const RICH_TEXT_UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;
const RICH_MARKS = ["bold", "italic", "underline"] as const;
const MARKDOWN_LIST_LINE = /(?:^|\n)[\t ]*(?:[-+*]|\d+[.)])[\t ]+\S/u;
const NEGATED_LIST_INSTRUCTION = /\b(?:do[\t ]+not|don['’]t|dont|never|avoid|remove|without)\b[^\r\n.!?]{0,64}\b(?:bullets?|bullet(?:ed)?[\t ]+(?:list|points?|items?)|(?:numbered|ordered|enumerated|unordered)[\t ]+list|list)\b|\b(?:not|no)[\t ]+(?:an?[\t ]+)?(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list|list)\b|\b(?:instead[\t ]+of|rather[\t ]+than)[\t ]+(?:an?[\t ]+)?(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list|list)\b/iu;
const MIXED_BLOCK_INSTRUCTION = /\b(?:paragraphs?|intro(?:duction)?|opening|conclusion|closing)\b[^\r\n.!?]{0,64}\b(?:then|and|with|plus|along[\t ]+with|followed[\t ]+by)\b[^\r\n.!?]{0,64}\b(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list)\b|\b(?:bullets?|bullet(?:ed)?[\t ]+list|(?:numbered|ordered|enumerated|unordered)[\t ]+list)\b[^\r\n.!?]{0,64}\b(?:then|and|with|plus|along[\t ]+with|followed[\t ]+by)\b[^\r\n.!?]{0,64}\b(?:paragraphs?|intro(?:duction)?|opening|conclusion|closing)\b/iu;
const ORDERED_LIST_INSTRUCTION = /\b(?:convert|turn|format|reformat|restructure|rewrite|present|put|change|make|give|create|write|produce|return)\b[^\r\n.!?]{0,64}\b(?:numbered|ordered|enumerated)[\t ]+(?:list|points?|items?)\b/iu;
const UNORDERED_LIST_INSTRUCTION = /\b(?:convert|turn|format|reformat|restructure|rewrite|present|put|change|make|give|create|write|produce|return)\b[^\r\n.!?]{0,64}\b(?:unordered[\t ]+list|bullets?|bullet(?:ed)?[\t ]+(?:list|points?|items?))\b/iu;
const GENERIC_LIST_INSTRUCTION = /\b(?:convert|turn|format|reformat|restructure|present|put|change|make)\b[^\r\n.!?]{0,64}\b(?:as|into|to|in)[\t ]+an?[\t ]+list\b/iu;

export type RichTextSpan = { text: string; marks?: Array<(typeof RICH_MARKS)[number]> };
export type RichBlock =
  | { type: "paragraph"; spans: RichTextSpan[] }
  | { type: "unordered_list" | "ordered_list"; items: Array<{ spans: RichTextSpan[] }> };

export function requestedRichListType(instruction: string | null | undefined): "unordered_list" | "ordered_list" | undefined {
  if (!instruction) return undefined;
  if (NEGATED_LIST_INSTRUCTION.test(instruction) || MIXED_BLOCK_INSTRUCTION.test(instruction)) return undefined;
  if (ORDERED_LIST_INSTRUCTION.test(instruction)) return "ordered_list";
  if (UNORDERED_LIST_INSTRUCTION.test(instruction) || GENERIC_LIST_INSTRUCTION.test(instruction)) return "unordered_list";
  return undefined;
}

function canonicalReplacementText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").split(/(\n[\t ]*\n(?:[\t ]*\n)*)/u)
    .map((part, index) => index % 2 === 0 ? part.replace(/[\t ]*\n[\t ]*/gu, " ") : "\n\n")
    .join("");
}

export type OpenComposeRequest = {
  protocolVersion: 1;
  requestId: string;
  composeId: string;
  composeGeneration: number;
  agentId: string;
};

export type AgentProbeRequest = {
  protocolVersion: 1;
  requestId: string;
  probeRunId: string;
  agentId: string;
};

export type AgentProbeCancelRequest = AgentProbeRequest;

export type TransformRequest = OpenComposeRequest & {
  runId: string;
  action: "improve" | "proofread" | "shorten" | "tone" | "translate" | "summarize" | "ask";
  instruction?: string | null;
  contextHash: string;
  targetHash: string;
  document: {
    subject: string;
    recipients: string[];
    authoredText: string;
    quotedText?: string;
  };
  target: {
    targetId: string;
    text: string;
    start: number;
    end: number;
    selectionShape?: "text-range" | "flat-list-items" | "rich-blocks";
    items?: string[];
    blocks?: RichBlock[];
  };
  limits: {
    maxOperations: number;
    maxOutputCharacters: number;
  };
};

export type EditResult = {
  version: 1;
  requestId: string;
  composeGeneration: number;
  contextHash: string;
  targetHash: string;
  operations: Array<
    | { type: "replace_text_range"; targetId: string; start: number; end: number; text: string; items?: never }
    | { type: "replace_flat_list_items"; targetId: string; items: string[]; text?: never }
    | { type: "replace_rich_blocks"; targetId: string; blocks: RichBlock[]; text?: never; items?: never }
  >;
  summary: string;
};

export type MessageTransformRequest = {
  protocolVersion: 1;
  requestId: string;
  runId: string;
  agentId: string;
  action: "translate" | "summarize";
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
  messageHash: string;
  document: {
    subject: string;
    author: string;
    segments: Array<{ id: string; text: string }>;
  };
  limits: {
    maxSegments: number;
    maxOutputCharacters: number;
  };
};

export type MessageCancelRequest = {
  protocolVersion: 1;
  requestId: string;
  transformRequestId: string;
  runId: string;
  messageHash: string;
};

export type MessageTransformResult = {
  version: 1;
  requestId: string;
  messageHash: string;
  action: "translate" | "summarize";
  detectedLanguage: string | null;
  targetLanguage: string | null;
  segments: Array<{ id: string; text: string }>;
  summary: { title: string; bullets: string[] } | null;
};

export class ContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...keys].sort());
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractError("INVALID_REQUEST", `${key} must be a non-empty string`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new ContractError("INVALID_REQUEST", `${key} must be a string`);
  }
  return value;
}

function parseRichSpans(value: unknown, label: string): RichTextSpan[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new ContractError("INVALID_AGENT_OUTPUT", `${label} spans are invalid`);
  }
  const spans = value.map((candidate) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, candidate.marks === undefined ? ["text"] : ["text", "marks"])
      || typeof candidate.text !== "string" || candidate.text.length < 1
      || RICH_TEXT_UNSAFE_CHARACTERS.test(candidate.text)) {
      throw new ContractError("INVALID_AGENT_OUTPUT", `${label} span text is invalid`);
    }
    if (candidate.marks === undefined) return { text: candidate.text };
    const candidateMarks = candidate.marks;
    if (!Array.isArray(candidateMarks) || candidateMarks.length < 1 || candidateMarks.length > RICH_MARKS.length
      || candidateMarks.some((mark) => typeof mark !== "string" || !RICH_MARKS.includes(mark as typeof RICH_MARKS[number]))
      || new Set(candidateMarks).size !== candidateMarks.length
      || JSON.stringify(candidateMarks) !== JSON.stringify(RICH_MARKS.filter((mark) => candidateMarks.includes(mark)))) {
      throw new ContractError("INVALID_AGENT_OUTPUT", `${label} span marks are invalid`);
    }
    return { text: candidate.text, marks: [...candidateMarks] as RichTextSpan["marks"] };
  });
  if (!spans.some((span) => span.text.trim().length > 0)) {
    throw new ContractError("INVALID_AGENT_OUTPUT", `${label} must contain visible text`);
  }
  return spans;
}

function parseRichBlocks(value: unknown): RichBlock[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new ContractError("INVALID_AGENT_OUTPUT", "rich blocks are invalid");
  }
  let characters = 0;
  const blocks = value.map((candidate, blockIndex) => {
    if (!isRecord(candidate)) throw new ContractError("INVALID_AGENT_OUTPUT", "rich block is invalid");
    if (candidate.type === "paragraph") {
      if (!hasExactKeys(candidate, ["type", "spans"])) throw new ContractError("INVALID_AGENT_OUTPUT", "rich paragraph fields are invalid");
      const spans = parseRichSpans(candidate.spans, `paragraph ${blockIndex}`);
      characters += spans.reduce((sum, span) => sum + span.text.length, 0);
      return { type: "paragraph" as const, spans };
    }
    if ((candidate.type === "unordered_list" || candidate.type === "ordered_list")
      && Array.isArray(candidate.items) && candidate.items.length >= 1 && candidate.items.length <= 100) {
      const items = candidate.items.map((item, itemIndex) => {
        if (!isRecord(item) || !hasExactKeys(item, ["spans"])) throw new ContractError("INVALID_AGENT_OUTPUT", "rich list item is invalid");
        const spans = parseRichSpans(item.spans, `list item ${blockIndex}:${itemIndex}`);
        characters += spans.reduce((sum, span) => sum + span.text.length, 0);
        return { spans };
      });
      return { type: candidate.type as "unordered_list" | "ordered_list", items };
    }
    throw new ContractError("INVALID_AGENT_OUTPUT", "rich block type is invalid");
  });
  if (characters > 12_000) throw new ContractError("OUTPUT_TOO_LARGE", "rich block output exceeds the requested limit");
  return blocks;
}

export function parseOpenComposeRequest(value: unknown): OpenComposeRequest {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ContractError("UNSUPPORTED_PROTOCOL", "protocolVersion must be 1");
  }
  const generation = value.composeGeneration;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new ContractError("INVALID_REQUEST", "composeGeneration must be a positive integer");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requiredString(value, "requestId"),
    composeId: requiredString(value, "composeId"),
    composeGeneration: generation as number,
    agentId: requiredString(value, "agentId"),
  };
}

export function parseAgentProbeRequest(value: unknown): AgentProbeRequest {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ContractError("UNSUPPORTED_PROTOCOL", "protocolVersion must be 1");
  }
  const expectedKeys = new Set(["protocolVersion", "requestId", "probeRunId", "agentId"]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new ContractError("INVALID_REQUEST", "agent probe request contains unknown fields");
  }
  const requestId = requiredString(value, "requestId");
  const probeRunId = requiredString(value, "probeRunId");
  const agentId = requiredString(value, "agentId");
  if (
    requestId.length > 128 || probeRunId.length > 128 || agentId.length > 128 ||
    [requestId, probeRunId, agentId].some((field) => /[\u0000-\u001F\u007F]/u.test(field))
  ) {
    throw new ContractError("INVALID_REQUEST", "agent probe identity is too long");
  }
  if (requestId === probeRunId) {
    throw new ContractError("INVALID_REQUEST", "requestId and probeRunId must be distinct");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    probeRunId,
    agentId,
  };
}

export function parseAgentProbeCancelRequest(value: unknown): AgentProbeCancelRequest {
  return parseAgentProbeRequest(value);
}

export function parseMessageTransformRequest(value: unknown): MessageTransformRequest {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ContractError("UNSUPPORTED_PROTOCOL", "protocolVersion must be 1");
  }
  if (!isRecord(value.document) || !isRecord(value.limits)) {
    throw new ContractError("INVALID_REQUEST", "document and limits are required");
  }
  if (value.action !== "translate" && value.action !== "summarize") {
    throw new ContractError("INVALID_REQUEST", "message action must be translate or summarize");
  }
  const segments = value.document.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new ContractError("INVALID_REQUEST", "document.segments must not be empty");
  }
  const parsedSegments = segments.map((candidate) => {
    if (!isRecord(candidate)) throw new ContractError("INVALID_REQUEST", "each segment must be an object");
    return { id: requiredString(candidate, "id"), text: requiredString(candidate, "text") };
  });
  if (new Set(parsedSegments.map(({ id }) => id)).size !== parsedSegments.length) {
    throw new ContractError("INVALID_REQUEST", "segment IDs must be unique");
  }
  const maxSegments = value.limits.maxSegments;
  const maxOutputCharacters = value.limits.maxOutputCharacters;
  if (!Number.isSafeInteger(maxSegments) || (maxSegments as number) < 1 || parsedSegments.length > (maxSegments as number)) {
    throw new ContractError("INVALID_REQUEST", "segment count exceeds the requested limit");
  }
  if (!Number.isSafeInteger(maxOutputCharacters) || (maxOutputCharacters as number) < 1) {
    throw new ContractError("INVALID_REQUEST", "maxOutputCharacters must be a positive integer");
  }
  const sourceLanguage = value.sourceLanguage == null ? null : requiredString(value, "sourceLanguage");
  const targetLanguage = value.targetLanguage == null ? null : requiredString(value, "targetLanguage");
  if (value.action === "translate" && !targetLanguage) {
    throw new ContractError("INVALID_REQUEST", "targetLanguage is required for translation");
  }
  return {
    protocolVersion: 1,
    requestId: requiredString(value, "requestId"),
    runId: requiredString(value, "runId"),
    agentId: requiredString(value, "agentId"),
    action: value.action,
    sourceLanguage,
    targetLanguage,
    messageHash: requiredString(value, "messageHash"),
    document: {
      subject: stringField(value.document, "subject"),
      author: stringField(value.document, "author"),
      segments: parsedSegments,
    },
    limits: { maxSegments: maxSegments as number, maxOutputCharacters: maxOutputCharacters as number },
  };
}

export function parseMessageCancelRequest(value: unknown): MessageCancelRequest {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new ContractError("UNSUPPORTED_PROTOCOL", "protocolVersion must be 1");
  }
  const expectedKeys = new Set(["protocolVersion", "requestId", "transformRequestId", "runId", "messageHash"]);
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
    throw new ContractError("INVALID_REQUEST", "message cancel request contains unknown fields");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requiredString(value, "requestId"),
    transformRequestId: requiredString(value, "transformRequestId"),
    runId: requiredString(value, "runId"),
    messageHash: requiredString(value, "messageHash"),
  };
}

export function parseMessageTransformResult(text: string, request: MessageTransformRequest): MessageTransformResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/iu);
  const jsonText = fenced ? fenced[1]!.trim() : trimmed;
  if (jsonText.length > request.limits.maxOutputCharacters) {
    throw new ContractError("OUTPUT_TOO_LARGE", "agent output exceeds the requested limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new ContractError("INVALID_AGENT_OUTPUT", "agent output is not one JSON object");
  }
  if (!isRecord(value) || value.version !== 1 || value.requestId !== request.requestId || value.messageHash !== request.messageHash || value.action !== request.action) {
    throw new ContractError("STALE_OR_MISMATCHED_RESULT", "message result identity does not match request");
  }
  const detectedLanguage = value.detectedLanguage == null ? null : requiredString(value, "detectedLanguage");
  const targetLanguage = value.targetLanguage == null ? null : requiredString(value, "targetLanguage");
  if (targetLanguage !== request.targetLanguage) {
    throw new ContractError("STALE_OR_MISMATCHED_RESULT", "message result target language does not match request");
  }
  let segments: Array<{ id: string; text: string }> = [];
  let summary: { title: string; bullets: string[] } | null = null;
  if (request.action === "translate") {
    if (!Array.isArray(value.segments) || value.segments.length !== request.document.segments.length) {
      throw new ContractError("INVALID_AGENT_OUTPUT", "translation must return every source segment exactly once");
    }
    const expected = new Set(request.document.segments.map(({ id }) => id));
    segments = value.segments.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.id !== "string" || !expected.delete(candidate.id) || typeof candidate.text !== "string") {
        throw new ContractError("INVALID_AGENT_OUTPUT", "translation segment identity is invalid");
      }
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(candidate.text)) {
        throw new ContractError("UNSAFE_AGENT_OUTPUT", "translation contains control characters");
      }
      return { id: candidate.id, text: candidate.text };
    });
    if (expected.size !== 0) {
      throw new ContractError("STALE_OR_MISMATCHED_RESULT", "translation segments do not match request");
    }
    if (value.summary !== null) throw new ContractError("INVALID_AGENT_OUTPUT", "translation summary must be null");
  } else {
    if (!isRecord(value.summary) || typeof value.summary.title !== "string" || !Array.isArray(value.summary.bullets) || !value.summary.bullets.every((item) => typeof item === "string")) {
      throw new ContractError("INVALID_AGENT_OUTPUT", "summary must contain a title and bullet strings");
    }
    if (value.summary.bullets.length < 1 || value.summary.bullets.length > 8) {
      throw new ContractError("INVALID_AGENT_OUTPUT", "summary must contain between one and eight bullets");
    }
    for (const item of [value.summary.title, ...value.summary.bullets]) {
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(item)) {
        throw new ContractError("UNSAFE_AGENT_OUTPUT", "summary contains control characters");
      }
    }
    summary = { title: value.summary.title, bullets: value.summary.bullets as string[] };
    if (!Array.isArray(value.segments) || value.segments.length !== 0) {
      throw new ContractError("INVALID_AGENT_OUTPUT", "summary segments must be empty");
    }
  }
  return { version: 1, requestId: request.requestId, messageHash: request.messageHash, action: request.action, detectedLanguage, targetLanguage, segments, summary };
}

export function parseTransformRequest(value: unknown): TransformRequest {
  const base = parseOpenComposeRequest(value);
  if (!isRecord(value)) throw new ContractError("INVALID_REQUEST", "request must be an object");
  if (!isRecord(value.document) || !isRecord(value.target) || !isRecord(value.limits)) {
    throw new ContractError("INVALID_REQUEST", "document, target, and limits are required");
  }
  const action = value.action;
  const actions = new Set(["improve", "proofread", "shorten", "tone", "translate", "summarize", "ask"]);
  if (typeof action !== "string" || !actions.has(action)) {
    throw new ContractError("INVALID_REQUEST", "unsupported action");
  }
  const recipients = value.document.recipients;
  if (!Array.isArray(recipients) || !recipients.every((entry) => typeof entry === "string")) {
    throw new ContractError("INVALID_REQUEST", "document.recipients must be strings");
  }
  const start = value.target.start;
  const end = value.target.end;
  const targetText = requiredString(value.target, "text");
  const selectionShape = value.target.selectionShape === undefined ? undefined : value.target.selectionShape;
  if (selectionShape !== undefined && selectionShape !== "text-range" && selectionShape !== "flat-list-items"
    && selectionShape !== "rich-blocks") {
    throw new ContractError("INVALID_REQUEST", "unsupported selection shape");
  }
  let targetItems: string[] | undefined;
  if (selectionShape === "flat-list-items") {
    if (!Array.isArray(value.target.items) || value.target.items.length < 1 || value.target.items.length > 100
      || value.target.items.some((item) => typeof item !== "string" || item.trim().length === 0
        || LIST_ITEM_UNSAFE_CHARACTERS.test(item))) {
      throw new ContractError("INVALID_REQUEST", "flat list target items are invalid");
    }
    targetItems = [...value.target.items] as string[];
    if (targetItems.join("\n") !== targetText) throw new ContractError("INVALID_REQUEST", "flat list target text does not match its items");
  } else if (value.target.items !== undefined) {
    throw new ContractError("INVALID_REQUEST", "text range target must not contain list items");
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number) || (end as number) > targetText.length) {
    throw new ContractError("INVALID_REQUEST", "target range is out of bounds");
  }
  const maxOperations = value.limits.maxOperations;
  const maxOutputCharacters = value.limits.maxOutputCharacters;
  if (!Number.isSafeInteger(maxOperations) || (maxOperations as number) < 1 || !Number.isSafeInteger(maxOutputCharacters) || (maxOutputCharacters as number) < 1) {
    throw new ContractError("INVALID_REQUEST", "limits must be positive integers");
  }
  return {
    ...base,
    runId: requiredString(value, "runId"),
    action: action as TransformRequest["action"],
    instruction: value.instruction == null ? null : requiredString(value, "instruction"),
    contextHash: requiredString(value, "contextHash"),
    targetHash: requiredString(value, "targetHash"),
    document: {
      subject: stringField(value.document, "subject"),
      recipients,
      authoredText: requiredString(value.document, "authoredText"),
      quotedText: typeof value.document.quotedText === "string" ? value.document.quotedText : undefined,
    },
    target: {
      targetId: requiredString(value.target, "targetId"),
      text: targetText,
      start: start as number,
      end: end as number,
      ...(selectionShape === undefined ? {} : { selectionShape }),
      ...(targetItems === undefined ? {} : { items: targetItems }),
    },
    limits: { maxOperations: maxOperations as number, maxOutputCharacters: maxOutputCharacters as number },
  };
}

export function parseEditResult(text: string, request: TransformRequest): EditResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/iu);
  const jsonText = fenced ? fenced[1]!.trim() : trimmed;
  if (jsonText.length > request.limits.maxOutputCharacters) {
    throw new ContractError("OUTPUT_TOO_LARGE", "agent output exceeds the requested limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new ContractError("INVALID_AGENT_OUTPUT", "agent output is not one JSON object");
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.operations)) {
    throw new ContractError("INVALID_AGENT_OUTPUT", "invalid result envelope");
  }
  if (value.requestId !== request.requestId || value.composeGeneration !== request.composeGeneration || value.contextHash !== request.contextHash || value.targetHash !== request.targetHash) {
    throw new ContractError("STALE_OR_MISMATCHED_RESULT", "result identity does not match request");
  }
  if (value.operations.length === 0 || value.operations.length > request.limits.maxOperations) {
    throw new ContractError("INVALID_AGENT_OUTPUT", "invalid operation count");
  }
  const operations = value.operations.map((operation) => {
    if (!isRecord(operation) || operation.targetId !== request.target.targetId) {
      throw new ContractError("INVALID_AGENT_OUTPUT", "unsupported edit operation");
    }
    if (request.target.selectionShape === "flat-list-items") {
      if (operation.type !== "replace_flat_list_items" || !Array.isArray(operation.items)
        || operation.items.length < 1 || operation.items.length > 100
        || operation.items.some((item) => typeof item !== "string" || item.trim().length === 0
          || LIST_ITEM_UNSAFE_CHARACTERS.test(item))) {
        throw new ContractError("INVALID_AGENT_OUTPUT", "flat list replacement items are invalid");
      }
      return { type: "replace_flat_list_items" as const, targetId: operation.targetId as string,
        items: [...operation.items] as string[] };
    }
    if (request.target.selectionShape === "rich-blocks") {
      const exactOperation = hasExactKeys(operation, ["type", "targetId", "blocks"]);
      // DeepSeek may duplicate the envelope summary inside an otherwise exact rich operation.
      // Accept only a byte-for-byte duplicate, then reconstruct the canonical operation below.
      const redundantSummary = hasExactKeys(operation, ["type", "targetId", "blocks", "summary"])
        && typeof operation.summary === "string" && operation.summary === value.summary;
      if (operation.type !== "replace_rich_blocks" || (!exactOperation && !redundantSummary)) {
        throw new ContractError("INVALID_AGENT_OUTPUT", "rich block target requires rich block replacement");
      }
      const blocks = parseRichBlocks(operation.blocks);
      const requiredListType = requestedRichListType(request.instruction);
      if (requiredListType && !blocks.every((block) => block.type === requiredListType)) {
        throw new ContractError("INVALID_AGENT_OUTPUT", `requested ${requiredListType} output must contain only that typed list block`);
      }
      return { type: "replace_rich_blocks" as const, targetId: operation.targetId as string, blocks };
    }
    if (operation.type !== "replace_text_range" || typeof operation.text !== "string"
      || operation.start !== request.target.start || operation.end !== request.target.end) {
      throw new ContractError("INVALID_AGENT_OUTPUT", "operation is outside the editable range");
    }
    if (MARKDOWN_LIST_LINE.test(operation.text.replace(/\r\n?/gu, "\n"))) {
      throw new ContractError("INVALID_AGENT_OUTPUT", "plain text replacement must not contain Markdown list syntax");
    }
    const replacementText = canonicalReplacementText(operation.text);
    if (replacementText.trim().toLowerCase() === "replacement text") {
      throw new ContractError("INVALID_AGENT_OUTPUT", "replacement must not be a schema placeholder");
    }
    if (/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(replacementText)) {
      throw new ContractError("UNSAFE_AGENT_OUTPUT", "replacement contains HTML-like or control characters");
    }
    return {
      type: "replace_text_range" as const,
      targetId: operation.targetId as string,
      start: operation.start as number,
      end: operation.end as number,
      text: replacementText,
    };
  });
  if (typeof value.summary !== "string") {
    throw new ContractError("INVALID_AGENT_OUTPUT", "summary must be a string");
  }
  if (value.summary.trim().toLowerCase() === "short description") {
    throw new ContractError("INVALID_AGENT_OUTPUT", "summary must not be a schema placeholder");
  }
  return {
    version: 1,
    requestId: request.requestId,
    composeGeneration: request.composeGeneration,
    contextHash: request.contextHash,
    targetHash: request.targetHash,
    operations,
    summary: value.summary,
  };
}
