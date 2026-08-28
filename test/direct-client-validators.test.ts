import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProbeRequest,
  OpenComposeRequest,
  TransformComposeRequest,
  TransformMessageRequest,
} from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { DirectClientError } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import {
  validateAgentListResponse,
  validateAgentProbeRequest,
  validateAgentProbeResponse,
  validateCancelAgentProbeRequest,
  validateCancelAgentProbeResponse,
  validateCancelComposeResponse,
  validateCancelMessageResponse,
  validateCloseComposeResponse,
  validateGatewayStatus,
  validateOpenComposeResponse,
  validateTransformComposeResponse,
  validateTransformMessageResponse,
} from "../packages/thunderbird-extension/src/direct-client-validators.js";

function contractCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DirectClientError && error.kind === "contract" && error.code === code;
}

const openRequest: OpenComposeRequest = {
  protocolVersion: 1,
  requestId: "open-request",
  composeId: "compose-a",
  composeGeneration: 7,
  agentId: "agent-a",
};

function composeRequest(): TransformComposeRequest {
  return {
    protocolVersion: 1,
    requestId: "compose-request",
    runId: "compose-run",
    composeId: "compose-a",
    composeGeneration: 7,
    agentId: "agent-a",
    action: "improve",
    instruction: null,
    contextHash: "sha256:context",
    targetHash: "sha256:target",
    document: { subject: "Subject", recipients: ["person@example.test"], authoredText: "rough text" },
    target: { targetId: "target-a", text: "rough text", start: 2, end: 8 },
    limits: { maxOperations: 2, maxOutputCharacters: 20 },
  };
}

function composeResponse(request = composeRequest()): Record<string, unknown> {
  return {
    protocolVersion: 1,
    runId: request.runId,
    result: {
      version: 1,
      requestId: request.requestId,
      composeGeneration: request.composeGeneration,
      contextHash: request.contextHash,
      targetHash: request.targetHash,
      operations: [{ type: "replace_text_range", targetId: request.target.targetId, start: request.target.start, end: request.target.end, text: "clear text" }],
      summary: "Improved.",
    },
    evidence: { provider: "provider-a", model: "model-a", runtimeSessionMarker: "marker", repairAttempted: false, toolSummary: "must not escape" },
  };
}

function messageRequest(action: "translate" | "summarize" = "translate"): TransformMessageRequest {
  return {
    protocolVersion: 1,
    requestId: "message-request",
    runId: "message-run",
    agentId: "agent-a",
    action,
    sourceLanguage: "Dutch",
    targetLanguage: "English",
    messageHash: "sha256:message",
    document: {
      subject: "Subject",
      author: "person@example.test",
      segments: [{ id: "segment-a", text: "een" }, { id: "segment-b", text: "twee" }],
    },
    limits: { maxSegments: 2, maxOutputCharacters: 50 },
  };
}

function messageResponse(request = messageRequest()): Record<string, unknown> {
  return {
    protocolVersion: 1,
    runId: request.runId,
    result: {
      version: 1,
      requestId: request.requestId,
      messageHash: request.messageHash,
      action: request.action,
      detectedLanguage: "Dutch",
      targetLanguage: request.targetLanguage ?? null,
      segments: request.action === "translate"
        ? [{ id: "segment-b", text: "Read > this < literally" }, { id: "segment-a", text: "one" }]
        : [],
      summary: request.action === "summarize" ? { title: "Update", bullets: ["One item"] } : null,
    },
    evidence: { runtimeSessionMarker: null, repairAttempted: false },
  };
}

test("status enforces protocol/plugin identity and reconstructs capabilities", () => {
  const source = Object.create({ inherited: true }) as Record<string, unknown>;
  source.protocolVersion = 1;
  source.plugin = "thunderclaw";
  source.gatewayVersion = "2026.9.1-beta.1";
  source.capabilities = { transform: true, cancellation: "compose", ignoredObject: { unsafe: true } };
  assert.throws(() => validateGatewayStatus(source), contractCode("INVALID_BACKEND_RESPONSE"));

  source.capabilities = { transform: true, cancellation: "compose" };
  assert.deepEqual(validateGatewayStatus(source), {
    protocolVersion: 1,
    plugin: "thunderclaw",
    gatewayVersion: "2026.9.1-beta.1",
    capabilities: { transform: true, cancellation: "compose" },
  });
  assert.throws(() => validateGatewayStatus({ ...source, protocolVersion: 2 }), contractCode("UNSUPPORTED_PROTOCOL"));
  assert.throws(() => validateGatewayStatus({ ...source, plugin: "lookalike" }), contractCode("UNEXPECTED_PLUGIN"));
});

test("agent responses bind request identity and reconstruct nested records", () => {
  const compatibility = {
    state: "verified",
    executionMode: "restricted-agent",
    usesPersonality: true,
    usesMemory: true,
    toolsDisabled: true,
    checks: {
      configuration: "passed",
      credentials: "passed",
      structuredOutput: "passed",
      toolIsolation: "passed",
      cancellation: "passed",
      fallbacks: "not_applicable",
      unexpected: "discard me",
    },
    lastProbe: { testedAt: "2026-08-08T12:00:00.000Z", observedProvider: "provider-a", observedModel: null, unexpected: true },
    reason: "Restricted probe passed.",
    secret: "discard me",
  };
  const response = {
    protocolVersion: 1,
    requestId: "agents-request",
    agents: [{
      agentId: "agent-a",
      displayName: "Agent A",
      isDefault: true,
      provider: "provider-a",
      model: "model-a",
      unexpected: "discard me",
      reasoning: { defaultLevel: "medium", levels: [{ id: "low", label: "Low", unexpected: true }], unexpected: true },
      compatibility,
    }],
  };
  assert.deepEqual(validateAgentListResponse(response, "agents-request"), {
    protocolVersion: 1,
    requestId: "agents-request",
    agents: [{
      agentId: "agent-a",
      displayName: "Agent A",
      isDefault: true,
      provider: "provider-a",
      model: "model-a",
      reasoning: { defaultLevel: "medium", levels: [{ id: "low", label: "Low" }] },
      compatibility: {
        state: "verified",
        executionMode: "restricted-agent",
        usesPersonality: true,
        usesMemory: true,
        toolsDisabled: true,
        checks: {
          configuration: "passed",
          credentials: "passed",
          structuredOutput: "passed",
          toolIsolation: "passed",
          cancellation: "passed",
          fallbacks: "not_applicable",
        },
        lastProbe: { testedAt: "2026-08-08T12:00:00.000Z", observedProvider: "provider-a", observedModel: null },
        reason: "Restricted probe passed.",
      },
    }],
  });
  assert.throws(() => validateAgentListResponse({ ...response, requestId: "other" }, "agents-request"), contractCode("MISMATCHED_REQUEST"));
  assert.throws(() => validateAgentListResponse({ ...response, agents: [{ ...response.agents[0], reasoning: { defaultLevel: "medium", levels: [{ id: "", label: "Low" }] } }] }, "agents-request"), contractCode("INVALID_BACKEND_RESPONSE"));

  const invalidCompatibility: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["state", (value) => { value.state = "compatible"; }],
    ["executionMode", (value) => { value.executionMode = "unrestricted"; }],
    ["usesPersonality", (value) => { value.usesPersonality = false; }],
    ["usesMemory", (value) => { value.usesMemory = "yes"; }],
    ["toolsDisabled", (value) => { value.toolsDisabled = false; }],
    ["configuration check", (value) => { (value.checks as Record<string, unknown>).configuration = "not_run"; }],
    ["other check", (value) => { (value.checks as Record<string, unknown>).credentials = "unknown"; }],
    ["lastProbe", (value) => { value.lastProbe = { testedAt: "", observedProvider: null, observedModel: null }; }],
    ["reason control", (value) => { value.reason = "unsafe\u000a"; }],
  ];
  for (const [label, mutate] of invalidCompatibility) {
    const bad = structuredClone(response);
    mutate((bad.agents[0] as Record<string, unknown>).compatibility as Record<string, unknown>);
    assert.throws(() => validateAgentListResponse(bad, "agents-request"), contractCode("INVALID_BACKEND_RESPONSE"), label);
  }
  const badBoolean = structuredClone(response);
  (badBoolean.agents[0] as Record<string, unknown>).isDefault = "true";
  assert.throws(() => validateAgentListResponse(badBoolean, "agents-request"), contractCode("INVALID_BACKEND_RESPONSE"));
});

test("agent compatibility state cannot contradict its checks or durable evidence", () => {
  const valid = {
    protocolVersion: 1,
    requestId: "agents-semantic-request",
    agents: [{
      agentId: "agent-a",
      displayName: "Agent A",
      isDefault: true,
      provider: "provider-a",
      model: "model-a",
      reasoning: { defaultLevel: null, levels: [] },
      compatibility: {
        state: "verified",
        executionMode: "restricted-agent",
        usesPersonality: true,
        usesMemory: true,
        toolsDisabled: true,
        checks: {
          configuration: "passed",
          credentials: "passed",
          structuredOutput: "passed",
          toolIsolation: "passed",
          cancellation: "passed",
          fallbacks: "not_applicable",
        },
        lastProbe: { testedAt: "2026-08-08T12:00:00.000Z", observedProvider: "provider-a", observedModel: "model-a" },
        reason: "Restricted probe passed.",
      },
    }],
  };
  const contradictions: Array<[string, (compatibility: Record<string, unknown>) => void]> = [
    ["verified with a failed core check", (compatibility) => {
      (compatibility.checks as Record<string, unknown>).credentials = "failed";
    }],
    ["verified without durable probe evidence", (compatibility) => { compatibility.lastProbe = null; }],
    ["unverified while retaining passed evidence", (compatibility) => { compatibility.state = "unverified"; }],
    ["unsupported despite a passed configuration", (compatibility) => {
      compatibility.state = "unsupported";
      compatibility.lastProbe = null;
      const checks = compatibility.checks as Record<string, unknown>;
      for (const key of ["credentials", "structuredOutput", "toolIsolation", "cancellation", "fallbacks"]) checks[key] = "not_run";
    }],
  ];
  for (const [label, mutate] of contradictions) {
    const response = structuredClone(valid);
    mutate((response.agents[0]!.compatibility) as Record<string, unknown>);
    assert.throws(
      () => validateAgentListResponse(response, valid.requestId),
      contractCode("INVALID_BACKEND_RESPONSE"),
      label,
    );
  }
});

test("agent probe requests and responses enforce every exact identity", () => {
  const request: AgentProbeRequest = { protocolVersion: 1, requestId: "probe-request", probeRunId: "probe-run", agentId: "agent-a" };
  assert.deepEqual(validateAgentProbeRequest({ ...request }), request);
  assert.deepEqual(validateCancelAgentProbeRequest({ ...request, requestId: "cancel-request" }), { ...request, requestId: "cancel-request" });
  for (const invalid of [
    { ...request, extra: true },
    { ...request, probeRunId: request.requestId },
    { ...request, agentId: "" },
  ]) assert.throws(() => validateAgentProbeRequest(invalid), contractCode("INVALID_REQUEST"));

  const agent = {
    agentId: request.agentId,
    displayName: "Agent A",
    isDefault: true,
    provider: "provider-a",
    model: "model-a",
    reasoning: { defaultLevel: null, levels: [], ignored: true },
    compatibility: {
      state: "partially_verified",
      executionMode: "restricted-agent",
      usesPersonality: true,
      usesMemory: true,
      toolsDisabled: true,
      checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_run" },
      lastProbe: { testedAt: "2026-08-08T12:00:00.000Z", observedProvider: "provider-a", observedModel: "model-a", ignored: true },
      reason: "Configured fallback evidence is unavailable.",
      ignored: true,
    },
    ignored: true,
  };
  const response = { protocolVersion: 1, requestId: request.requestId, probeRunId: request.probeRunId, agent, ignored: true };
  const validated = validateAgentProbeResponse(response, request);
  assert.deepEqual(validated, {
    protocolVersion: 1,
    requestId: request.requestId,
    probeRunId: request.probeRunId,
    agent: {
      agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider-a", model: "model-a",
      reasoning: { defaultLevel: null, levels: [] },
      compatibility: {
        state: "partially_verified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
        checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_run" },
        lastProbe: { testedAt: "2026-08-08T12:00:00.000Z", observedProvider: "provider-a", observedModel: "model-a" },
        reason: "Configured fallback evidence is unavailable.",
      },
    },
  });
  for (const replacement of [{ requestId: "wrong" }, { probeRunId: "wrong" }]) {
    assert.throws(() => validateAgentProbeResponse({ ...response, ...replacement }, request), contractCode("MISMATCHED_RUN"));
  }
  assert.throws(() => validateAgentProbeResponse({ ...response, agent: { ...agent, agentId: "agent-b" } }, request), contractCode("AGENT_MISMATCH"));

  const cancelRequest = { ...request, requestId: "cancel-request" };
  const acknowledgement = { ...cancelRequest, cancelled: true };
  assert.deepEqual(validateCancelAgentProbeResponse(acknowledgement, cancelRequest), acknowledgement);
  for (const replacement of [{ requestId: "wrong" }, { probeRunId: "wrong" }, { agentId: "wrong" }, { cancelled: false }]) {
    assert.throws(() => validateCancelAgentProbeResponse({ ...acknowledgement, ...replacement }, cancelRequest), contractCode("MISMATCHED_RUN"));
  }
});

test("agent compatibility states reject contradictory check and last-probe evidence", () => {
  const base = {
    protocolVersion: 1,
    requestId: "agents-request",
    agents: [{
      agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider-a", model: "model-a",
      reasoning: { defaultLevel: null, levels: [] },
      compatibility: {
        state: "verified",
        executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
        checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_applicable" },
        lastProbe: { testedAt: "2026-08-08T12:00:00.000Z", observedProvider: "provider-a", observedModel: "model-a" },
        reason: "Restricted checks passed.",
      },
    }],
  };
  const valid = [
    base,
    (() => { const value = structuredClone(base); const compatibility = value.agents[0]!.compatibility; compatibility.state = "partially_verified"; compatibility.checks.fallbacks = "not_run"; return value; })(),
    (() => { const value = structuredClone(base); const compatibility = value.agents[0]!.compatibility; compatibility.state = "incompatible"; compatibility.checks.structuredOutput = "failed"; return value; })(),
    (() => { const value = structuredClone(base); const compatibility = value.agents[0]!.compatibility; compatibility.state = "unverified"; Object.assign(compatibility.checks, { credentials: "not_run", structuredOutput: "not_run", toolIsolation: "not_run", cancellation: "not_run", fallbacks: "not_run" }); compatibility.lastProbe = null as never; return value; })(),
    (() => { const value = structuredClone(base); const compatibility = value.agents[0]!.compatibility; compatibility.state = "unsupported"; Object.assign(compatibility.checks, { configuration: "failed", credentials: "not_run", structuredOutput: "not_run", toolIsolation: "not_run", cancellation: "not_run", fallbacks: "not_run" }); compatibility.lastProbe = null as never; return value; })(),
  ];
  for (const value of valid) assert.doesNotThrow(() => validateAgentListResponse(value, "agents-request"));

  const contradictory = [
    (() => { const value = structuredClone(base); value.agents[0]!.compatibility.checks.cancellation = "not_run"; return value; })(),
    (() => { const value = structuredClone(base); value.agents[0]!.compatibility.lastProbe = null as never; return value; })(),
    (() => { const value = structuredClone(valid[1]!); value.agents[0]!.compatibility.checks.fallbacks = "passed"; return value; })(),
    (() => { const value = structuredClone(valid[2]!); value.agents[0]!.compatibility.checks.structuredOutput = "passed"; return value; })(),
    (() => { const value = structuredClone(valid[3]!); value.agents[0]!.compatibility.checks.credentials = "passed"; return value; })(),
    (() => { const value = structuredClone(valid[3]!); value.agents[0]!.compatibility.lastProbe = base.agents[0]!.compatibility.lastProbe; return value; })(),
    (() => { const value = structuredClone(valid[4]!); value.agents[0]!.compatibility.checks.configuration = "passed"; return value; })(),
    (() => { const value = structuredClone(valid[4]!); value.agents[0]!.compatibility.checks.fallbacks = "not_applicable"; return value; })(),
  ];
  for (const value of contradictory) {
    assert.throws(() => validateAgentListResponse(value, "agents-request"), contractCode("INVALID_BACKEND_RESPONSE"));
  }
});

test("lastProbe.testedAt accepts only bounded canonical UTC timestamps", () => {
  const response = {
    protocolVersion: 1,
    requestId: "timestamp-request",
    agents: [{
      agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider-a", model: "model-a",
      reasoning: { defaultLevel: null, levels: [] },
      compatibility: {
        state: "verified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
        checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_applicable" },
        lastProbe: { testedAt: "2026-08-08T12:34:56.789Z", observedProvider: "provider-a", observedModel: "model-a" },
        reason: "Restricted checks passed.",
      },
    }],
  };
  assert.equal(validateAgentListResponse(response, response.requestId).agents[0]?.compatibility.lastProbe?.testedAt, "2026-08-08T12:34:56.789Z");
  const hostile = [
    "2026-08-08T12:34:56Z",
    "2026-08-08T12:34:56.789+00:00",
    "2026-08-08t12:34:56.789z",
    "2026-02-30T12:34:56.789Z",
    "2026-08-08T12:34:56.78Z",
    "2026-08-08T12:34:56.789Z\nBearer CANARY_SECRET",
    "9".repeat(10_000),
  ];
  for (const testedAt of hostile) {
    const invalid = structuredClone(response);
    invalid.agents[0]!.compatibility.lastProbe.testedAt = testedAt;
    assert.throws(() => validateAgentListResponse(invalid, response.requestId), contractCode("INVALID_BACKEND_RESPONSE"), testedAt.slice(0, 40));
  }
});

test("open compose binds request, compose identity, and generation", () => {
  const response = { protocolVersion: 1, requestId: openRequest.requestId, composeId: openRequest.composeId, composeGeneration: openRequest.composeGeneration, sessionId: "session-a" };
  assert.deepEqual(validateOpenComposeResponse(response, openRequest), response);
  for (const replacement of [
    { requestId: "wrong" },
    { composeId: "compose-b" },
    { composeGeneration: 8 },
  ]) {
    assert.throws(() => validateOpenComposeResponse({ ...response, ...replacement }, openRequest), contractCode("STALE_OR_MISMATCHED_RESULT"));
  }
});

test("cancel and close acknowledgements bind every lifecycle identity", () => {
  const cancelRequest = { ...openRequest, requestId: "cancel-request", runId: "run-a" };
  const cancelResponse = { protocolVersion: 1, requestId: cancelRequest.requestId, runId: cancelRequest.runId, cancelled: true };
  assert.deepEqual(validateCancelComposeResponse(cancelResponse, cancelRequest), cancelResponse);
  for (const replacement of [{ requestId: "wrong" }, { runId: "wrong" }, { cancelled: false }]) {
    assert.throws(() => validateCancelComposeResponse({ ...cancelResponse, ...replacement }, cancelRequest), contractCode("MISMATCHED_RUN"));
  }

  const closeResponse = { protocolVersion: 1, requestId: openRequest.requestId, composeId: openRequest.composeId, composeGeneration: openRequest.composeGeneration, closed: true };
  assert.deepEqual(validateCloseComposeResponse(closeResponse, openRequest), closeResponse);
  for (const replacement of [{ requestId: "wrong" }, { composeId: "wrong" }, { composeGeneration: 8 }, { closed: false }]) {
    assert.throws(() => validateCloseComposeResponse({ ...closeResponse, ...replacement }, openRequest), contractCode("STALE_OR_MISMATCHED_RESULT"));
  }

  const messageCancelRequest = { protocolVersion: 1 as const, requestId: "message-cancel", transformRequestId: "message-transform", runId: "message-run", messageHash: "message-hash" };
  const messageCancelResponse = { protocolVersion: 1, requestId: messageCancelRequest.requestId, transformRequestId: messageCancelRequest.transformRequestId, runId: messageCancelRequest.runId, messageHash: messageCancelRequest.messageHash, cancelled: true };
  assert.deepEqual(validateCancelMessageResponse(messageCancelResponse, messageCancelRequest), messageCancelResponse);
  for (const replacement of [{ requestId: "wrong" }, { transformRequestId: "wrong" }, { runId: "wrong" }, { messageHash: "wrong" }, { cancelled: false }]) {
    assert.throws(() => validateCancelMessageResponse({ ...messageCancelResponse, ...replacement }, messageCancelRequest), contractCode("MISMATCHED_RUN"));
  }
});

test("compose result binds every snapshot hash and run identity", () => {
  const request = composeRequest();
  const response = composeResponse(request);
  assert.equal(validateTransformComposeResponse(response, request).result.operations[0]?.text, "clear text");
  assert.equal("toolSummary" in validateTransformComposeResponse(response, request).evidence, false);
  assert.throws(() => validateTransformComposeResponse({ ...response, runId: "wrong" }, request), contractCode("MISMATCHED_RUN"));
  for (const field of ["requestId", "composeGeneration", "contextHash", "targetHash"] as const) {
    const bad = structuredClone(response);
    (bad.result as Record<string, unknown>)[field] = field === "composeGeneration" ? 8 : "wrong";
    assert.throws(() => validateTransformComposeResponse(bad, request), contractCode("STALE_OR_MISMATCHED_RESULT"), field);
  }
});

test("compose boundary folds display wrapping but preserves paragraph breaks", () => {
  const request = composeRequest();
  request.limits.maxOutputCharacters = 200;
  const response = composeResponse(request);
  ((response.result as Record<string, unknown>).operations as Array<Record<string, unknown>>)[0]!.text =
    "A long model line\nwrapped for display.\r\n\r\nA second\nparagraph.";
  const operation = validateTransformComposeResponse(response, request).result.operations[0];
  assert.equal(operation?.text, "A long model line wrapped for display.\n\nA second paragraph.");
});

test("compose boundary rejects Markdown list output on the plain text path", () => {
  const request = composeRequest();
  const response = composeResponse(request);
  ((response.result as Record<string, unknown>).operations as Array<Record<string, unknown>>)[0]!.text =
    "- First point\n- Second point\n- Third point";
  assert.throws(() => validateTransformComposeResponse(response, request), contractCode("INVALID_BACKEND_RESPONSE"));
});

test("compose boundary independently validates discriminated flat-list item results", () => {
  const request: TransformComposeRequest = { ...composeRequest(), target: {
    targetId: "target-list", text: "One\nTwo", start: 0, end: 7,
    selectionShape: "flat-list-items", items: ["One", "Two"],
  }, limits: { maxOperations: 2, maxOutputCharacters: 100 } };
  const response = composeResponse(request);
  const result = response.result as Record<string, unknown>;
  result.operations = [{ type: "replace_flat_list_items", targetId: "target-list", items: ["Two", "Three <literal>"] }];
  assert.deepEqual(validateTransformComposeResponse(response, request).result.operations[0]?.items,
    ["Two", "Three <literal>"]);
  for (const operation of [
    { type: "replace_text_range", targetId: "target-list", start: 0, end: 7, text: "wrong" },
    { type: "replace_flat_list_items", targetId: "target-list", items: ["bad\nitem"] },
    ...["\u0085", "\u2028", "\u2029", "\u009f"].map((character) =>
      ({ type: "replace_flat_list_items", targetId: "target-list", items: [`one${character}two`] })),
  ]) {
    result.operations = [operation];
    assert.throws(() => validateTransformComposeResponse(response, request), contractCode("INVALID_BACKEND_RESPONSE"));
  }
});

test("compose boundary independently validates typed rich-block results", () => {
  const request: TransformComposeRequest = { ...composeRequest(), target: {
    targetId: "target-rich", text: "Original paragraphs", start: 0, end: 19, selectionShape: "rich-blocks",
  }, limits: { maxOperations: 1, maxOutputCharacters: 1000 } };
  const response = composeResponse(request);
  const result = response.result as Record<string, unknown>;
  const blocks = [{ type: "unordered_list", items: [
    { spans: [{ text: "First" }] }, { spans: [{ text: "Second", marks: ["bold", "underline"] }] },
  ] }];
  result.operations = [{ type: "replace_rich_blocks", targetId: "target-rich", blocks }];
  assert.deepEqual(validateTransformComposeResponse(response, request).result.operations[0],
    { type: "replace_rich_blocks", targetId: "target-rich", blocks });
  for (const invalidBlocks of [
    [{ type: "paragraph", spans: [{ text: "bad\nline" }] }],
    [{ type: "paragraph", spans: [{ text: "bad", marks: ["underline", "bold"] }] }],
    [{ type: "unordered_list", items: [] }],
  ]) {
    result.operations = [{ type: "replace_rich_blocks", targetId: "target-rich", blocks: invalidBlocks }];
    assert.throws(() => validateTransformComposeResponse(response, request), contractCode("INVALID_BACKEND_RESPONSE"));
  }
});

test("compose boundary rejects paragraph-only results when the instruction requests a typed list", () => {
  for (const [instruction, expectedType] of [
    ["can you convert this to a bullet list?", "unordered_list"],
    ["convert to bullet list instead of paragraph", "unordered_list"],
    ["put this in a list", "unordered_list"],
    ["create a bulleted list", "unordered_list"],
    ["give me three bullet points", "unordered_list"],
    ["convert this to a numbered list", "ordered_list"],
    ["change this into an ordered list", "ordered_list"],
    ["return numbered items", "ordered_list"],
  ] as const) {
    const request: TransformComposeRequest = { ...composeRequest(), instruction, target: {
      targetId: "target-rich", text: "Three features", start: 0, end: 14, selectionShape: "rich-blocks",
    }, limits: { maxOperations: 1, maxOutputCharacters: 1000 } };
    const response = composeResponse(request);
    const result = response.result as Record<string, unknown>;
    result.operations = [{ type: "replace_rich_blocks", targetId: "target-rich",
      blocks: [{ type: "paragraph", spans: [{ text: "First, a feature." }] }] }];
    assert.throws(() => validateTransformComposeResponse(response, request), contractCode("INVALID_BACKEND_RESPONSE"), instruction);
    result.operations = [{ type: "replace_rich_blocks", targetId: "target-rich",
      blocks: [{ type: expectedType, items: [{ spans: [{ text: "A feature" }] }] }] }];
    const operation = validateTransformComposeResponse(response, request).result.operations[0];
    assert.equal(operation?.type, "replace_rich_blocks");
    if (operation?.type === "replace_rich_blocks") assert.equal(operation.blocks[0]?.type, expectedType);
  }
});

test("compose boundary leaves negated, descriptive, and mixed list wording semantically unconstrained", () => {
  for (const instruction of [
    "remove the bullet points and make this prose",
    "do not convert this to a list",
    "don’t convert this to a list",
    "never return a bullet list",
    "use paragraphs, not bullets",
    "make this a paragraph instead of bullets",
    "make this more ordered and concise",
    "rewrite this to list the reasons more clearly",
    "write an intro paragraph and then bullet points",
    "use bullets followed by a concluding paragraph",
    "write bullet points and a short intro",
    "give me bullet points plus a conclusion",
  ]) {
    const request: TransformComposeRequest = { ...composeRequest(), instruction, target: {
      targetId: "target-rich", text: "Three features", start: 0, end: 14, selectionShape: "rich-blocks",
    }, limits: { maxOperations: 1, maxOutputCharacters: 1000 } };
    const response = composeResponse(request);
    (response.result as Record<string, unknown>).operations = [{ type: "replace_rich_blocks", targetId: "target-rich",
      blocks: [{ type: "paragraph", spans: [{ text: "Expected prose." }] }] }];
    assert.equal(validateTransformComposeResponse(response, request).result.operations[0]?.type, "replace_rich_blocks", instruction);
  }
});

test("compose operations enforce exact target/range, count, output budget, and hostile characters", () => {
  const request = composeRequest();
  const cases: Array<[string, (result: Record<string, unknown>) => void, string]> = [
    ["target", (result) => { ((result.operations as Array<Record<string, unknown>>)[0]!).targetId = "other"; }, "INVALID_BACKEND_RESPONSE"],
    ["start", (result) => { ((result.operations as Array<Record<string, unknown>>)[0]!).start = 1; }, "INVALID_BACKEND_RESPONSE"],
    ["end", (result) => { ((result.operations as Array<Record<string, unknown>>)[0]!).end = 9; }, "INVALID_BACKEND_RESPONSE"],
    ["empty operations", (result) => { result.operations = []; }, "INVALID_BACKEND_RESPONSE"],
    ["too many operations", (result) => { result.operations = Array(3).fill((result.operations as unknown[])[0]); }, "INVALID_BACKEND_RESPONSE"],
    ["output budget", (result) => { ((result.operations as Array<Record<string, unknown>>)[0]!).text = "x".repeat(21); }, "OUTPUT_TOO_LARGE"],
    ["angle bracket", (result) => { ((result.operations as Array<Record<string, unknown>>)[0]!).text = "<b>unsafe</b>"; }, "UNSAFE_BACKEND_RESPONSE"],
    ["control", (result) => { result.summary = "unsafe\u0007"; }, "UNSAFE_BACKEND_RESPONSE"],
  ];
  for (const [label, mutate, code] of cases) {
    const response = structuredClone(composeResponse(request));
    mutate(response.result as Record<string, unknown>);
    assert.throws(() => validateTransformComposeResponse(response, request), contractCode(code), label);
  }
});

test("compose output budget includes both replacement text and summary", () => {
  const request = composeRequest();
  request.limits.maxOutputCharacters = 12;
  const response = composeResponse(request);
  ((response.result as Record<string, unknown>).operations as Array<Record<string, unknown>>)[0]!.text = "edit";
  (response.result as Record<string, unknown>).summary = "123456789";
  assert.throws(() => validateTransformComposeResponse(response, request), contractCode("OUTPUT_TOO_LARGE"));
});

test("message translation accepts literal angles and an exact reordered segment set", () => {
  const request = messageRequest();
  const result = validateTransformMessageResponse(messageResponse(request), request).result;
  assert.deepEqual(result.segments.map(({ id }) => id), ["segment-b", "segment-a"]);
  assert.equal(result.segments[0]?.text, "Read > this < literally");
});

test("message translation rejects duplicate, missing, extra segments and stale identity", () => {
  const request = messageRequest();
  for (const ids of [["segment-a", "segment-a"], ["segment-a"], ["segment-a", "segment-b", "segment-c"]]) {
    const response = structuredClone(messageResponse(request));
    (response.result as Record<string, unknown>).segments = ids.map((id) => ({ id, text: "safe" }));
    assert.throws(() => validateTransformMessageResponse(response, request), contractCode("STALE_OR_MISMATCHED_RESULT"), ids.join(","));
  }
  for (const [field, value] of [["requestId", "wrong"], ["messageHash", "wrong"], ["action", "summarize"]] as const) {
    const response = structuredClone(messageResponse(request));
    (response.result as Record<string, unknown>)[field] = value;
    assert.throws(() => validateTransformMessageResponse(response, request), contractCode("STALE_OR_MISMATCHED_RESULT"), field);
  }
  assert.throws(() => validateTransformMessageResponse({ ...messageResponse(request), runId: "wrong" }, request), contractCode("MISMATCHED_RUN"));
});

test("message results reject controls and enforce output and summary shape limits", () => {
  const translation = messageRequest();
  const control = structuredClone(messageResponse(translation));
  ((control.result as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0]!.text = "unsafe\u007f";
  assert.throws(() => validateTransformMessageResponse(control, translation), contractCode("UNSAFE_BACKEND_RESPONSE"));

  const oversized = structuredClone(messageResponse(translation));
  ((oversized.result as Record<string, unknown>).segments as Array<Record<string, unknown>>)[0]!.text = "x".repeat(50);
  assert.throws(() => validateTransformMessageResponse(oversized, translation), contractCode("OUTPUT_TOO_LARGE"));

  const summaryRequest = messageRequest("summarize");
  const valid = validateTransformMessageResponse(messageResponse(summaryRequest), summaryRequest).result;
  assert.deepEqual(valid.summary, { title: "Update", bullets: ["One item"] });
  const tooMany = structuredClone(messageResponse(summaryRequest));
  ((tooMany.result as Record<string, unknown>).summary as Record<string, unknown>).bullets = Array(9).fill("item");
  assert.throws(() => validateTransformMessageResponse(tooMany, summaryRequest), contractCode("INVALID_BACKEND_RESPONSE"));
});
