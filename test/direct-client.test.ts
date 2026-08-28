import assert from "node:assert/strict";
import test from "node:test";
import {
  DirectClientError,
  type ClientAuthentication,
  type ConnectionBinding,
  type AgentRecord,
  type OpenComposeRequest,
  type TransformComposeRequest,
  type TransformMessageRequest,
} from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { BrowserThunderClawDirectClient } from "../packages/thunderbird-extension/src/direct-client.js";

const apiBase = "https://gateway.example:8443/thunderclaw/v1";
const origin = "https://gateway.example:8443";
const binding: ConnectionBinding = {
  apiBase,
  origin,
  credential: { mode: "device_credential", credentialId: "device-a" },
  permissionId: "https://gateway.example/*",
  epoch: 4,
};

function authentication(credential = "narrow-secret"): ClientAuthentication {
  return {
    binding: { ...binding.credential, mode: "device_credential" },
    developmentOnly: false,
    authorize: async (writer) => writer.setBearerCredential(credential),
  };
}

function responseAt(url: string, body: BodyInit | null, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function jsonAt(url: string, body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return responseAt(url, JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function statusBody(): Record<string, unknown> {
  return { protocolVersion: 1, plugin: "thunderclaw", gatewayVersion: "2026.9.1-beta.1", capabilities: { transform: true } };
}

function errorCode(kind: DirectClientError["kind"], code: string): (error: unknown) => boolean {
  return (error) => error instanceof DirectClientError && error.kind === kind && error.code === code;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function composeRequest(): TransformComposeRequest {
  return {
    protocolVersion: 1,
    requestId: "request-a",
    runId: "run-a",
    composeId: "compose-a",
    composeGeneration: 3,
    agentId: "agent-a",
    action: "improve",
    instruction: null,
    contextHash: "context-hash",
    targetHash: "target-hash",
    document: { subject: "Subject", recipients: [], authoredText: "draft" },
    target: { targetId: "target-a", text: "draft", start: 0, end: 5 },
    limits: { maxOperations: 1, maxOutputCharacters: 100 },
  };
}

function messageRequest(): TransformMessageRequest {
  return {
    protocolVersion: 1,
    requestId: "message-request",
    runId: "message-run",
    agentId: "agent-a",
    action: "translate",
    sourceLanguage: "Dutch",
    targetLanguage: "English",
    messageHash: "message-hash",
    document: { subject: "Subject", author: "sender@example.test", segments: [{ id: "segment-a", text: "tekst" }] },
    limits: { maxSegments: 1, maxOutputCharacters: 100 },
  };
}

function probedAgent(): AgentRecord {
  return {
    agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider-a", model: "model-a",
    reasoning: { defaultLevel: null, levels: [] },
    compatibility: {
      state: "verified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
      checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_applicable" },
      lastProbe: { testedAt: "2026-08-08T12:00:00.000Z", observedProvider: "provider-a", observedModel: "model-a" },
      reason: "Restricted checks passed.",
    },
  };
}

test("client attaches one bearer credential and confines status to the fixed route", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new BrowserThunderClawDirectClient(binding, authentication(), async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return jsonAt(String(input), statusBody());
  });
  const completion = await client.status();
  assert.equal(completion.binding, client.binding);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${apiBase}/status`);
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.redirect, "manual");
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), "Bearer narrow-secret");
  assert.equal(JSON.stringify(completion).includes("narrow-secret"), false);
});

test("native fetch is invoked without the direct-client instance as receiver and injected fetch remains supported", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const receivers: unknown[] = [];
  const nativeFetch = function (this: unknown, input: RequestInfo | URL): Promise<Response> {
    receivers.push(this);
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation receiver");
    return Promise.resolve(jsonAt(String(input), statusBody()));
  } as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: nativeFetch });
  try {
    const nativeClient = new BrowserThunderClawDirectClient(binding, authentication());
    const nativeCompletion = await nativeClient.status();
    assert.equal(nativeCompletion.value.plugin, "thunderclaw");
    assert.equal(receivers.length, 1);
    assert.equal(receivers[0] === undefined || receivers[0] === globalThis, true);

    let injectedCalls = 0;
    const injectedFetch: typeof fetch = async (input) => {
      injectedCalls += 1;
      return jsonAt(String(input), statusBody());
    };
    const injectedCompletion = await new BrowserThunderClawDirectClient(binding, authentication(), injectedFetch).status();
    assert.equal(injectedCompletion.value.plugin, "thunderclaw");
    assert.equal(injectedCalls, 1, "the constructor fetch seam remains authoritative");
    assert.equal(receivers.length, 1, "an injected fetch does not fall through to native fetch");
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
    else Reflect.deleteProperty(globalThis, "fetch");
  }
});

test("construction rejects noncanonical bases and authentication binding mismatches", () => {
  const mismatched: ClientAuthentication = {
    binding: { mode: "device_credential", credentialId: "device-b" },
    developmentOnly: false,
    authorize: async (writer) => writer.setBearerCredential("narrow-secret"),
  };
  assert.throws(() => new BrowserThunderClawDirectClient(binding, mismatched), errorCode("configuration", "AUTHENTICATION_BINDING_MISMATCH"));
  for (const badBase of [
    "https://gateway.example:8443/thunderclaw/v1/",
    "https://user@gateway.example:8443/thunderclaw/v1",
    "https://gateway.example:8443/thunderclaw/v1?query=1",
    "file:///thunderclaw/v1",
  ]) {
    assert.throws(
      () => new BrowserThunderClawDirectClient({ ...binding, apiBase: badBase }, authentication()),
      (error: unknown) => error instanceof DirectClientError && error.kind === "configuration",
      badBase,
    );
  }
});

test("authentication must set exactly one valid credential without leaking it into errors", async () => {
  let fetches = 0;
  const fetchImpl = async (): Promise<Response> => { fetches += 1; throw new Error("must not fetch"); };
  for (const auth of [
    { ...authentication("secret-one"), authorize: async () => undefined },
    { ...authentication("secret-two"), authorize: async (writer: Parameters<ClientAuthentication["authorize"]>[0]) => { writer.setBearerCredential("secret-two"); writer.setBearerCredential("secret-two"); } },
    { ...authentication("secret-three"), authorize: async (writer: Parameters<ClientAuthentication["authorize"]>[0]) => writer.setBearerCredential("bad\r\nsecret-three") },
  ] satisfies ClientAuthentication[]) {
    await assert.rejects(new BrowserThunderClawDirectClient(binding, auth, fetchImpl).status(), (error: unknown) => {
      assert.ok(error instanceof DirectClientError);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
  assert.equal(fetches, 0);
});

test("a pre-aborted caller skips both authentication and fetch", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const auth: ClientAuthentication = {
    binding: { mode: "device_credential", credentialId: "device-a" },
    developmentOnly: false,
    authorize: async () => { authCalls += 1; },
  };
  const controller = new AbortController();
  controller.abort();
  const client = new BrowserThunderClawDirectClient(binding, auth, async () => { fetchCalls += 1; throw new Error("must not fetch"); });
  await assert.rejects(client.status({ signal: controller.signal }), errorCode("cancellation", "REQUEST_ABORTED"));
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("timeout and caller abort also bound authorization, and a late writer is inert", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler) => originalSetTimeout(handler, 0)) as typeof setTimeout;
  try {
    let timeoutFetches = 0;
    const hungAuth: ClientAuthentication = {
      binding: { mode: "device_credential", credentialId: "device-a" },
      developmentOnly: false,
      authorize: async () => new Promise<void>(() => undefined),
    };
    await assert.rejects(
      new BrowserThunderClawDirectClient(binding, hungAuth, async () => { timeoutFetches += 1; throw new Error("must not fetch"); }).status(),
      errorCode("timeout", "REQUEST_TIMEOUT"),
    );
    assert.equal(timeoutFetches, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  let lateWriter: Parameters<ClientAuthentication["authorize"]>[0] | undefined;
  let abortFetches = 0;
  const authStarted = deferred<void>();
  const caller = new AbortController();
  const abortableAuth: ClientAuthentication = {
    binding: { mode: "device_credential", credentialId: "device-a" },
    developmentOnly: false,
    authorize: async (writer) => {
      lateWriter = writer;
      authStarted.resolve();
      return new Promise<void>(() => undefined);
    },
  };
  const running = new BrowserThunderClawDirectClient(binding, abortableAuth, async () => { abortFetches += 1; throw new Error("must not fetch"); }).status({ signal: caller.signal });
  await authStarted.promise;
  caller.abort();
  await assert.rejects(running, errorCode("cancellation", "REQUEST_ABORTED"));
  lateWriter?.setBearerCredential("late-secret");
  await Promise.resolve();
  assert.equal(abortFetches, 0);
});

test("oversized request bodies fail before authentication or fetch", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const auth: ClientAuthentication = {
    binding: { mode: "device_credential", credentialId: "device-a" },
    developmentOnly: false,
    authorize: async (writer) => { authCalls += 1; writer.setBearerCredential("narrow-secret"); },
  };
  const request = composeRequest();
  request.document.authoredText = "x".repeat(256_001);
  const client = new BrowserThunderClawDirectClient(binding, auth, async () => { fetchCalls += 1; throw new Error("must not fetch"); });
  await assert.rejects(client.transformCompose(request), errorCode("contract", "REQUEST_TOO_LARGE"));
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("runtime request validation rejects malformed compose/message inputs before auth or I/O", async () => {
  let authCalls = 0;
  let fetchCalls = 0;
  const auth: ClientAuthentication = {
    binding: { mode: "device_credential", credentialId: "device-a" },
    developmentOnly: false,
    authorize: async (writer) => { authCalls += 1; writer.setBearerCredential("secret"); },
  };
  const client = new BrowserThunderClawDirectClient(binding, auth, async () => { fetchCalls += 1; throw new Error("must not fetch"); });
  const badRange = composeRequest();
  badRange.target.end = 99;
  const badLimit = composeRequest();
  badLimit.limits.maxOperations = 0;
  const tooManySegments = messageRequest();
  tooManySegments.document.segments.push({ id: "segment-b", text: "meer" });
  const duplicateSegments = messageRequest();
  duplicateSegments.document.segments.push({ id: "segment-a", text: "duplicate" });
  duplicateSegments.limits.maxSegments = 2;
  const noTargetLanguage = messageRequest();
  noTargetLanguage.targetLanguage = null;
  const calls = [
    () => client.listAgents("   "),
    () => client.openCompose({ protocolVersion: 1, requestId: "open", composeId: "compose", composeGeneration: 0, agentId: "agent" }),
    () => client.transformCompose(badRange),
    () => client.transformCompose(badLimit),
    () => client.transformMessage(tooManySegments),
    () => client.transformMessage(duplicateSegments),
    () => client.transformMessage(noTargetLanguage),
    () => client.cancelMessageTransform({ protocolVersion: 1, requestId: "", transformRequestId: "transform", runId: "run", messageHash: "hash" }),
  ];
  for (const call of calls) await assert.rejects(call(), errorCode("contract", "INVALID_REQUEST"));
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("structured HTTP failures use authoritative classification and local messages", async () => {
  const cases: Array<[number, string, DirectClientError["kind"], string]> = [
    [401, "UNAUTHORIZED", "authentication", "ThunderClaw authentication was rejected."],
    [403, "FORBIDDEN", "permission", "ThunderClaw does not have permission to complete this request."],
    [404, "NOT_FOUND", "capability", "This ThunderClaw operation is not available."],
    [429, "RATE_LIMITED", "rate_limit", "ThunderClaw is temporarily rate limited. Try again later."],
    [408, "RUN_TIMEOUT", "timeout", "The ThunderClaw request timed out."],
    [503, "BACKEND_UNAVAILABLE", "backend", "ThunderClaw could not complete the request."],
    [403, "UNKNOWN_FUTURE_CODE", "backend", "ThunderClaw could not complete the request."],
  ];
  for (const [status, code, kind, localMessage] of cases) {
    const backendMessage = "Bearer sensitive-looking-value for person@example.test";
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async (input) => jsonAt(String(input), { error: { code, message: backendMessage } }, status, status === 429 ? { "retry-after": "3" } : {}));
    await assert.rejects(client.status(), (error: unknown) => {
      assert.ok(error instanceof DirectClientError);
      assert.equal(error.kind, kind);
      assert.equal(error.code, code);
      assert.equal(error.message, localMessage);
      assert.equal(error.message.includes(backendMessage), false);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, status === 429 ? 3000 : null);
      return true;
    });
  }
});

test("validated backend error messages are never propagated or logged", async () => {
  const backendMessage = "Bearer SECRET_VALUE belongs to private@example.test";
  const calls: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values: unknown[]) => { calls.push(values.join(" ")); };
  console.warn = (...values: unknown[]) => { calls.push(values.join(" ")); };
  console.error = (...values: unknown[]) => { calls.push(values.join(" ")); };
  try {
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async (input) => jsonAt(String(input), { error: { code: "INTERNAL_ERROR", message: backendMessage } }, 500));
    await assert.rejects(client.status(), (error: unknown) => {
      assert.ok(error instanceof DirectClientError);
      assert.equal(error.message, "ThunderClaw could not complete the request.");
      assert.equal(JSON.stringify(error).includes(backendMessage), false);
      return true;
    });
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  assert.equal(calls.some((value) => value.includes(backendMessage)), false);
});

test("structured errors enforce code grammar, bounded control-free messages, and semantic ordering", async () => {
  const url = `${apiBase}/status`;
  const invalidErrors = [
    { code: "lowercase", message: "safe" },
    { code: `A${"B".repeat(64)}`, message: "safe" },
    { code: "VALID_CODE", message: "" },
    { code: "VALID_CODE", message: "x".repeat(1_001) },
    { code: "VALID_CODE", message: "unsafe\nmessage" },
  ];
  for (const error of invalidErrors) {
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => jsonAt(url, { error }, 400));
    await assert.rejects(client.status(), errorCode("contract", "INVALID_BACKEND_RESPONSE"));
  }

  const ordered: Array<[number, string, DirectClientError["kind"]]> = [
    [401, "PERMISSION_DENIED", "permission"],
    [401, "RUN_CANCELLED", "cancellation"],
    [401, "RATE_LIMITED", "rate_limit"],
    [403, "INVALID_CREDENTIAL", "authentication"],
    [401, "UNKNOWN_AGENT", "capability"],
    [403, "UNKNOWN_CODE", "backend"],
  ];
  for (const [status, code, kind] of ordered) {
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => jsonAt(url, { error: { code, message: "safe" } }, status));
    await assert.rejects(client.status(), (error: unknown) => error instanceof DirectClientError && error.code === code && error.kind === kind);
  }
});

test("proxy HTML, malformed JSON, and fatal UTF-8 are distinct contract failures", async () => {
  const url = `${apiBase}/status`;
  const cases: Array<[BodyInit, string, number]> = [
    ["<html>proxy</html>", "INVALID_BACKEND_JSON", 502],
    ["{broken", "INVALID_BACKEND_JSON", 200],
    [new Uint8Array([0xc3, 0x28]), "INVALID_BACKEND_UTF8", 200],
  ];
  for (const [body, code, status] of cases) {
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => responseAt(url, body, { status }));
    await assert.rejects(client.status(), errorCode("contract", code));
  }
});

test("absent Content-Length is accepted within the streamed response limit", async () => {
  const url = `${apiBase}/status`;
  const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => responseAt(url, JSON.stringify(statusBody()), { status: 200 }));
  assert.equal((await client.status()).value.plugin, "thunderclaw");
});

test("declared, dishonest, and chunked response overflows fail closed and streamed overflow cancels its reader", async () => {
  const url = `${apiBase}/status`;
  let declaredCancelled = false;
  const declaredStream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { declaredCancelled = true; },
  });
  const declared = new BrowserThunderClawDirectClient(binding, authentication(), async () => responseAt(url, declaredStream, { headers: { "content-length": "65537" } }));
  await assert.rejects(declared.status(), errorCode("contract", "BACKEND_RESPONSE_TOO_LARGE"));
  assert.equal(declaredCancelled, true);

  const overflowHeaders: HeadersInit[] = [new Headers({ "content-length": "1" }), new Headers({ "transfer-encoding": "chunked" })];
  for (const headers of overflowHeaders) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { cancelled = true; },
    });
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => responseAt(url, stream, { headers }));
    await assert.rejects(client.status(), errorCode("contract", "BACKEND_RESPONSE_TOO_LARGE"));
    assert.equal(cancelled, true);
  }
});

test("noncanonical Content-Length forms fail contract validation and cancel the body", async () => {
  const url = `${apiBase}/status`;
  for (const declared of ["01", "+1", "-1", "1.0", "1e1", "", "NaN"]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(statusBody()))); },
      cancel() { cancelled = true; },
    });
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => responseAt(url, stream, { headers: { "content-length": declared } }));
    await assert.rejects(client.status(), errorCode("contract", "INVALID_BACKEND_RESPONSE"), declared);
    assert.equal(cancelled, true, declared);
  }
});

test("redirect indicators and final URL origin/route mismatches are rejected", async () => {
  const requested = `${apiBase}/status`;
  for (const finalUrl of [
    "https://redirect.example/thunderclaw/v1/status",
    `${origin}/other/status`,
    `${requested}?injected=1`,
  ]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(statusBody()))); },
      cancel() { cancelled = true; },
    });
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => responseAt(finalUrl, stream));
    await assert.rejects(client.status(), errorCode("contract", "REDIRECT_REJECTED"));
    await Promise.resolve();
    assert.equal(cancelled, true, finalUrl);
  }
  let redirectedCancelled = false;
  const redirectedStream = new ReadableStream<Uint8Array>({ cancel() { redirectedCancelled = true; } });
  const redirected = responseAt(requested, redirectedStream);
  Object.defineProperty(redirected, "redirected", { configurable: true, value: true });
  await assert.rejects(new BrowserThunderClawDirectClient(binding, authentication(), async () => redirected).status(), errorCode("contract", "REDIRECT_REJECTED"));
  await Promise.resolve();
  assert.equal(redirectedCancelled, true);
});

test("every HTTP redirect status fails as REDIRECT_REJECTED before body parsing", async () => {
  const requested = `${apiBase}/status`;
  for (let status = 300; status <= 399; status += 1) {
    let cancelled = false;
    const body = status === 304 ? null : new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("not json")); },
      cancel() { cancelled = true; },
    });
    const client = new BrowserThunderClawDirectClient(binding, authentication(), async () => responseAt(requested, body, { status }));
    await assert.rejects(client.status(), errorCode("contract", "REDIRECT_REJECTED"), String(status));
    await Promise.resolve();
    if (body !== null) assert.equal(cancelled, true, String(status));
  }
});

test("caller abort and timeout remain distinct while opaque SSL/network fetch failures map uniformly", async () => {
  const abortingFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(new DOMException("aborted", "AbortError"));
    else signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(new BrowserThunderClawDirectClient(binding, authentication(), abortingFetch).status({ signal: caller.signal }), errorCode("cancellation", "REQUEST_ABORTED"));

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler) => originalSetTimeout(handler, 0)) as typeof setTimeout;
  try {
    await assert.rejects(new BrowserThunderClawDirectClient(binding, authentication(), abortingFetch).status(), errorCode("timeout", "REQUEST_TIMEOUT"));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  await assert.rejects(new BrowserThunderClawDirectClient(binding, authentication(), async () => { throw new TypeError("SSL certificate rejected"); }).status(), errorCode("network", "NETWORK_FAILURE"));
  await assert.rejects(new BrowserThunderClawDirectClient(binding, authentication(), async () => { throw new TypeError("connection refused"); }).status(), errorCode("network", "NETWORK_FAILURE"));
});

test("local transform abort does not synthesize server cancel", async () => {
  const paths: string[] = [];
  const fetchStarted = deferred<void>();
  const fetchImpl: typeof fetch = async (input, init) => {
    paths.push(new URL(String(input)).pathname);
    fetchStarted.resolve();
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
      else init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  const controller = new AbortController();
  const running = new BrowserThunderClawDirectClient(binding, authentication(), fetchImpl).transformCompose(composeRequest(), { signal: controller.signal });
  await fetchStarted.promise;
  controller.abort();
  await assert.rejects(running, errorCode("cancellation", "REQUEST_ABORTED"));
  assert.deepEqual(paths, ["/thunderclaw/v1/compose/transform"]);
});

test("explicit compose cancel and close use exact identities and fixed routes", async () => {
  const paths: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const client = new BrowserThunderClawDirectClient(binding, authentication(), async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (path.endsWith("/cancel")) return jsonAt(String(input), { protocolVersion: 1, requestId: body.requestId, runId: body.runId, cancelled: true }, 202);
    return jsonAt(String(input), { protocolVersion: 1, requestId: body.requestId, composeId: body.composeId, composeGeneration: body.composeGeneration, closed: true });
  });
  const open: OpenComposeRequest = { protocolVersion: 1, requestId: "close-request", composeId: "compose-a", composeGeneration: 3, agentId: "agent-a" };
  await client.cancelComposeRun({ ...open, requestId: "cancel-request", runId: "run-a" });
  await client.closeCompose(open);
  assert.deepEqual(paths, ["/thunderclaw/v1/compose/cancel", "/thunderclaw/v1/compose/close"]);
  assert.deepEqual(bodies.map(({ requestId, composeId, composeGeneration, agentId, runId }) => ({ requestId, composeId, composeGeneration, agentId, runId })), [
    { requestId: "cancel-request", composeId: "compose-a", composeGeneration: 3, agentId: "agent-a", runId: "run-a" },
    { requestId: "close-request", composeId: "compose-a", composeGeneration: 3, agentId: "agent-a", runId: undefined },
  ]);
});

test("message cancellation sends and validates every exact identity", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new BrowserThunderClawDirectClient(binding, authentication(), async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return jsonAt(String(input), {
      protocolVersion: 1,
      requestId: body.requestId,
      transformRequestId: body.transformRequestId,
      runId: body.runId,
      messageHash: body.messageHash,
      cancelled: true,
    }, 202);
  });
  const request = { protocolVersion: 1 as const, requestId: "cancel-request", transformRequestId: "message-request", runId: "message-run", messageHash: "message-hash" };
  const completion = await client.cancelMessageTransform(request);
  assert.deepEqual(completion.value, { ...request, cancelled: true });
  assert.deepEqual(bodies, [request]);
});

test("agent probe and cancel use fixed routes, exact identities, and no automatic retries", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const client = new BrowserThunderClawDirectClient(binding, authentication(), async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const path = new URL(String(input)).pathname;
    calls.push({ path, body });
    if (path.endsWith("/cancel")) return jsonAt(String(input), { ...body, cancelled: true }, 202);
    return jsonAt(String(input), { protocolVersion: 1, requestId: body.requestId, probeRunId: body.probeRunId, agent: { ...probedAgent(), ignored: "discard" } });
  });
  const probeRequest = { protocolVersion: 1 as const, requestId: "probe-request", probeRunId: "probe-run", agentId: "agent-a" };
  const probe = await client.probeAgent(probeRequest);
  const cancelRequest = { ...probeRequest, requestId: "cancel-request" };
  const cancel = await client.cancelAgentProbe(cancelRequest);
  assert.deepEqual(probe.value, { protocolVersion: 1, requestId: "probe-request", probeRunId: "probe-run", agent: probedAgent() });
  assert.deepEqual(cancel.value, { ...cancelRequest, cancelled: true });
  assert.deepEqual(calls, [
    { path: "/thunderclaw/v1/agents/probe", body: probeRequest },
    { path: "/thunderclaw/v1/agents/probe/cancel", body: cancelRequest },
  ]);

  let attempts = 0;
  const failing = new BrowserThunderClawDirectClient(binding, authentication(), async (input) => {
    attempts += 1;
    return jsonAt(String(input), { error: { code: "INTERNAL_ERROR", message: "private" } }, 503);
  });
  await assert.rejects(failing.probeAgent(probeRequest), errorCode("backend", "INTERNAL_ERROR"));
  assert.equal(attempts, 1);
});
