import assert from "node:assert/strict";
import test from "node:test";
import {
  DirectClientError,
  type BoundCompletion,
  type ConnectionBinding,
  type OpenComposeRequest,
  type OpenComposeResponse,
  type ThunderClawDirectClient,
  type TransformComposeRequest,
  type TransformComposeResponse,
} from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { DirectComposeLifecycleRegistry } from "../packages/thunderbird-extension/src/direct-client-lifecycle.js";

const binding: ConnectionBinding = {
  apiBase: "https://gateway.example/thunderclaw/v1",
  origin: "https://gateway.example",
  credential: { mode: "device_credential", credentialId: "device-a" },
  permissionId: "https://gateway.example/*",
  epoch: 11,
};
const identity = { composeId: "compose-a", composeGeneration: 1, agentId: "agent-a" };

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function completion<T>(value: T, completionBinding = binding): BoundCompletion<T> {
  return { binding: completionBinding, value };
}

function openResponse(request: OpenComposeRequest, sessionId = `session-${request.composeGeneration}`): OpenComposeResponse {
  return { protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, sessionId };
}

function transformInput(runId = "run-a") {
  return {
    requestId: `request-${runId}`,
    runId,
    action: "improve" as const,
    instruction: null,
    contextHash: "context-hash",
    targetHash: "target-hash",
    document: { subject: "Subject", recipients: [], authoredText: "draft" },
    target: { targetId: "target-a", text: "draft", start: 0, end: 5 },
    limits: { maxOperations: 1, maxOutputCharacters: 100 },
  };
}

function transformResponse(request: TransformComposeRequest): TransformComposeResponse {
  return {
    protocolVersion: 1,
    runId: request.runId,
    result: {
      version: 1,
      requestId: request.requestId,
      composeGeneration: request.composeGeneration,
      contextHash: request.contextHash,
      targetHash: request.targetHash,
      operations: [{ type: "replace_text_range", targetId: request.target.targetId, start: request.target.start, end: request.target.end, text: "clear" }],
      summary: "Improved.",
    },
    evidence: { runtimeSessionMarker: null, repairAttempted: false },
  };
}

function mockClient(overrides: Partial<ThunderClawDirectClient>): ThunderClawDirectClient {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected client call"); };
  return {
    binding,
    hello: unexpected,
    status: unexpected,
    listAgents: unexpected,
    openCompose: unexpected,
    transformCompose: unexpected,
    cancelComposeRun: unexpected,
    closeCompose: unexpected,
    transformMessage: unexpected,
    cancelMessageTransform: unexpected,
    ...overrides,
  } as ThunderClawDirectClient;
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof DirectClientError && error.code === expected;
}

test("reordered generation opens cannot replace the newest compose epoch", async () => {
  const opens = new Map<number, { request: OpenComposeRequest; response: ReturnType<typeof deferred<BoundCompletion<OpenComposeResponse>>> }>();
  const client = mockClient({
    openCompose: async (request) => {
      const response = deferred<BoundCompletion<OpenComposeResponse>>();
      opens.set(request.composeGeneration, { request, response });
      return response.promise;
    },
  });
  let id = 0;
  const lifecycle = new DirectComposeLifecycleRegistry(client, () => `generated-${++id}`);
  const first = lifecycle.open(identity);
  const second = lifecycle.open({ ...identity, composeGeneration: 2 });
  const newer = opens.get(2)!;
  newer.response.resolve(completion(openResponse(newer.request)));
  assert.equal((await second).composeGeneration, 2);
  const older = opens.get(1)!;
  older.response.resolve(completion(openResponse(older.request)));
  await assert.rejects(first, code("STALE_COMPOSE_GENERATION"));
  assert.equal(lifecycle.get(identity.composeId)?.sessionId, "session-2");
  await assert.rejects(lifecycle.open(identity), code("STALE_COMPOSE_GENERATION"));
  assert.deepEqual([...opens.keys()], [1, 2]);
});

test("close before the initial open acknowledgement tombstones locally and closes a late server session", async () => {
  const opens = new Map<number, { request: OpenComposeRequest; response: ReturnType<typeof deferred<BoundCompletion<OpenComposeResponse>>> }>();
  let closeCalls = 0;
  let requestIds = 0;
  const client = mockClient({
    openCompose: async (request) => {
      const response = deferred<BoundCompletion<OpenComposeResponse>>();
      opens.set(request.composeGeneration, { request, response });
      return response.promise;
    },
    closeCompose: async (request) => {
      closeCalls += 1;
      return completion({ protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, closed: true });
    },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client, () => `request-${++requestIds}`);
  const initial = lifecycle.open(identity);
  assert.equal(requestIds, 1);
  await lifecycle.close(identity.composeId);
  assert.equal(closeCalls, 0);
  assert.equal(requestIds, 1, "close without an acknowledged session must not allocate a request ID");
  const first = opens.get(1)!;
  first.response.resolve(completion(openResponse(first.request)));
  await assert.rejects(initial, code("STALE_COMPOSE_GENERATION"));
  assert.equal(lifecycle.get(identity.composeId), undefined);

  const replacement = lifecycle.open({ ...identity, composeGeneration: 2 });
  const second = opens.get(2)!;
  second.response.resolve(completion(openResponse(second.request)));
  assert.equal((await replacement).composeGeneration, 2);
  assert.equal(closeCalls, 1);
  assert.equal(requestIds, 3);
});

test("close tombstones a pending replacement so neither relevant late open can resurrect", async () => {
  const opens = new Map<number, { request: OpenComposeRequest; response: ReturnType<typeof deferred<BoundCompletion<OpenComposeResponse>>> }>();
  let closeCalls = 0;
  const closedGenerations: number[] = [];
  let requestIds = 0;
  const client = mockClient({
    openCompose: async (request) => {
      const response = deferred<BoundCompletion<OpenComposeResponse>>();
      opens.set(request.composeGeneration, { request, response });
      return response.promise;
    },
    closeCompose: async (request) => {
      closeCalls += 1;
      closedGenerations.push(request.composeGeneration);
      return completion({ protocolVersion: 1, requestId: request.requestId, composeId: request.composeId, composeGeneration: request.composeGeneration, closed: true });
    },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client, () => `request-${++requestIds}`);
  const initial = lifecycle.open(identity);
  const replacement = lifecycle.open({ ...identity, composeGeneration: 2 });
  assert.equal(requestIds, 2);
  await lifecycle.close(identity.composeId);
  assert.equal(closeCalls, 0);
  assert.equal(requestIds, 2);

  const second = opens.get(2)!;
  second.response.resolve(completion(openResponse(second.request)));
  await assert.rejects(replacement, code("STALE_COMPOSE_GENERATION"));
  assert.equal(lifecycle.get(identity.composeId), undefined);
  const first = opens.get(1)!;
  first.response.resolve(completion(openResponse(first.request)));
  await assert.rejects(initial, code("STALE_COMPOSE_GENERATION"));
  assert.equal(lifecycle.get(identity.composeId), undefined);

  const newest = lifecycle.open({ ...identity, composeGeneration: 3 });
  const third = opens.get(3)!;
  third.response.resolve(completion(openResponse(third.request)));
  assert.equal((await newest).composeGeneration, 3);
  assert.equal(closeCalls, 2);
  assert.deepEqual(closedGenerations, [2, 1]);
  assert.equal(requestIds, 5);
});

test("open and transform reject completions from a different connection epoch", async () => {
  const staleBinding = { ...binding, epoch: binding.epoch - 1 };
  const staleOpen = mockClient({
    openCompose: async (request) => completion(openResponse(request), staleBinding),
  });
  await assert.rejects(new DirectComposeLifecycleRegistry(staleOpen).open(identity), code("STALE_CONNECTION"));

  const staleTransform = mockClient({
    openCompose: async (request) => completion(openResponse(request)),
    transformCompose: async (request) => completion(transformResponse(request), staleBinding),
  });
  const lifecycle = new DirectComposeLifecycleRegistry(staleTransform);
  await lifecycle.open(identity);
  await assert.rejects(lifecycle.transform(identity.composeId, transformInput()), code("STALE_CONNECTION"));
  assert.equal(lifecycle.get(identity.composeId)?.activeRunId, undefined);
});

test("one active run is enforced and cancellation forwards the exact captured identity", async () => {
  const transform = deferred<BoundCompletion<TransformComposeResponse>>();
  let transformRequest!: TransformComposeRequest;
  let cancelRequest: Record<string, unknown> | undefined;
  const client = mockClient({
    openCompose: async (request) => completion(openResponse(request)),
    transformCompose: async (request) => { transformRequest = request; return transform.promise; },
    cancelComposeRun: async (request) => {
      cancelRequest = request;
      return completion({ protocolVersion: 1, requestId: request.requestId, runId: request.runId, cancelled: true });
    },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client);
  await lifecycle.open(identity);
  const running = lifecycle.transform(identity.composeId, transformInput("run-a"));
  assert.equal(lifecycle.get(identity.composeId)?.activeRunId, "run-a");
  await assert.rejects(lifecycle.transform(identity.composeId, transformInput("run-b")), code("RUN_ALREADY_ACTIVE"));
  await assert.rejects(lifecycle.cancel(identity.composeId, "cancel-wrong", "run-b"), code("RUN_NOT_ACTIVE"));
  await lifecycle.cancel(identity.composeId, "cancel-a", "run-a");
  assert.deepEqual(cancelRequest, {
    protocolVersion: 1,
    requestId: "cancel-a",
    runId: "run-a",
    composeId: "compose-a",
    composeGeneration: 1,
    agentId: "agent-a",
  });
  assert.equal(lifecycle.get(identity.composeId)?.activeRunId, undefined, "exact cancel synchronously makes the run locally stale");
  transform.resolve(completion(transformResponse(transformRequest)));
  await assert.rejects(running, code("STALE_OR_MISMATCHED_RESULT"));
});

test("a late transform cannot complete after its compose state is replaced", async () => {
  const oldTransform = deferred<BoundCompletion<TransformComposeResponse>>();
  let oldRequest!: TransformComposeRequest;
  const client = mockClient({
    openCompose: async (request) => completion(openResponse(request)),
    transformCompose: async (request) => {
      oldRequest = request;
      return oldTransform.promise;
    },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client);
  await lifecycle.open(identity);
  const running = lifecycle.transform(identity.composeId, transformInput());
  await lifecycle.open({ ...identity, composeGeneration: 2 });
  oldTransform.resolve(completion(transformResponse(oldRequest)));
  await assert.rejects(running, code("STALE_OR_MISMATCHED_RESULT"));
  assert.equal(lifecycle.get(identity.composeId)?.composeGeneration, 2);
});

test("close uses the exact session generation and cannot delete a newer replacement", async () => {
  const closeAck = deferred<BoundCompletion<{ protocolVersion: 1; requestId: string; composeId: string; composeGeneration: number; closed: true }>>();
  let closeRequest!: OpenComposeRequest;
  const client = mockClient({
    openCompose: async (request) => completion(openResponse(request)),
    closeCompose: async (request) => { closeRequest = request; return closeAck.promise; },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client, () => "generated-close");
  await lifecycle.open(identity);
  const closing = lifecycle.close(identity.composeId);
  assert.equal(lifecycle.get(identity.composeId), undefined, "close invalidates local state before server acknowledgement");
  await lifecycle.open({ ...identity, composeGeneration: 2 });
  assert.deepEqual(closeRequest, { protocolVersion: 1, requestId: "generated-close", ...identity });
  closeAck.resolve(completion({ protocolVersion: 1, requestId: closeRequest.requestId, composeId: closeRequest.composeId, composeGeneration: closeRequest.composeGeneration, closed: true }));
  await closing;
  assert.equal(lifecycle.get(identity.composeId)?.composeGeneration, 2);
});

test("successful transforms preserve their connection binding in the completion", async () => {
  const client = mockClient({
    openCompose: async (request) => completion(openResponse(request)),
    transformCompose: async (request) => completion(transformResponse(request)),
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client);
  await lifecycle.open(identity);
  const result = await lifecycle.transform(identity.composeId, transformInput());
  assert.equal(result.binding, binding);
  assert.equal(result.value.operations[0]?.text, "clear");
});

test("a pending newer open immediately invalidates an older active transform", async () => {
  const transform = deferred<BoundCompletion<TransformComposeResponse>>();
  const newerOpen = deferred<BoundCompletion<OpenComposeResponse>>();
  let oldRequest!: TransformComposeRequest;
  let newRequest!: OpenComposeRequest;
  const client = mockClient({
    openCompose: async (request) => {
      if (request.composeGeneration === 1) return completion(openResponse(request));
      newRequest = request;
      return newerOpen.promise;
    },
    transformCompose: async (request) => { oldRequest = request; return transform.promise; },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client);
  await lifecycle.open(identity);
  const running = lifecycle.transform(identity.composeId, transformInput());
  const opening = lifecycle.open({ ...identity, composeGeneration: 2 });
  assert.equal(lifecycle.get(identity.composeId), undefined);
  transform.resolve(completion(transformResponse(oldRequest)));
  await assert.rejects(running, code("STALE_OR_MISMATCHED_RESULT"));
  newerOpen.resolve(completion(openResponse(newRequest)));
  assert.equal((await opening).composeGeneration, 2);
});

test("current-binding provider invalidates sessions and late completions after connection change", async () => {
  let current = binding;
  const changed = { ...binding, epoch: binding.epoch + 1 };
  const transform = deferred<BoundCompletion<TransformComposeResponse>>();
  let request!: TransformComposeRequest;
  const client = mockClient({
    openCompose: async (value) => completion(openResponse(value)),
    transformCompose: async (value) => { request = value; return transform.promise; },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client, () => "request", () => current);
  await lifecycle.open(identity);
  const running = lifecycle.transform(identity.composeId, transformInput());
  current = changed;
  assert.throws(() => lifecycle.get(identity.composeId), code("STALE_CONNECTION"));
  transform.resolve(completion(transformResponse(request)));
  await assert.rejects(running, code("STALE_CONNECTION"));
  await assert.rejects(lifecycle.open({ ...identity, composeId: "compose-b" }), code("STALE_CONNECTION"));
});

test("cancel and close stay local-first when server cleanup fails", async () => {
  const transform = deferred<BoundCompletion<TransformComposeResponse>>();
  const client = mockClient({
    openCompose: async (request) => completion(openResponse(request)),
    transformCompose: async () => transform.promise,
    cancelComposeRun: async () => { throw new Error("cancel cleanup failed"); },
    closeCompose: async () => { throw new Error("close cleanup failed"); },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client);
  await lifecycle.open(identity);
  void lifecycle.transform(identity.composeId, transformInput()).catch(() => undefined);
  const cancelling = lifecycle.cancel(identity.composeId, "cancel", "run-a");
  assert.equal(lifecycle.get(identity.composeId)?.activeRunId, undefined);
  await assert.rejects(cancelling, /cancel cleanup failed/u);
  const closing = lifecycle.close(identity.composeId);
  assert.equal(lifecycle.get(identity.composeId), undefined);
  await assert.rejects(closing, /close cleanup failed/u);
});

test("pending cancel cleanup blocks replacement runs, then releases the barrier on success or failure", async () => {
  for (const cleanupFails of [false, true]) {
    const oldTransform = deferred<BoundCompletion<TransformComposeResponse>>();
    const newTransform = deferred<BoundCompletion<TransformComposeResponse>>();
    const cancelCleanup = deferred<BoundCompletion<{ protocolVersion: 1; requestId: string; runId: string; cancelled: true }>>();
    let oldRequest!: TransformComposeRequest;
    let newRequest!: TransformComposeRequest;
    const client = mockClient({
      openCompose: async (request) => completion(openResponse(request)),
      transformCompose: async (request) => {
        if (request.runId === "run-old") { oldRequest = request; return oldTransform.promise; }
        newRequest = request;
        return newTransform.promise;
      },
      cancelComposeRun: async () => cancelCleanup.promise,
    });
    const lifecycle = new DirectComposeLifecycleRegistry(client);
    await lifecycle.open(identity);
    const oldRunning = lifecycle.transform(identity.composeId, transformInput("run-old"));
    const cancelling = lifecycle.cancel(identity.composeId, "cancel-old", "run-old");
    await assert.rejects(lifecycle.transform(identity.composeId, transformInput("run-blocked")), code("RUN_ALREADY_ACTIVE"));
    if (cleanupFails) cancelCleanup.reject(new Error("cleanup failed"));
    else cancelCleanup.resolve(completion({ protocolVersion: 1, requestId: "cancel-old", runId: "run-old", cancelled: true }));
    if (cleanupFails) await assert.rejects(cancelling, /cleanup failed/u);
    else await cancelling;

    const replacement = lifecycle.transform(identity.composeId, transformInput("run-new"));
    oldTransform.resolve(completion(transformResponse(oldRequest)));
    await assert.rejects(oldRunning, code("STALE_OR_MISMATCHED_RESULT"));
    newTransform.resolve(completion(transformResponse(newRequest)));
    assert.equal((await replacement).value.operations[0]?.text, "clear");
  }
});

test("close permanently blocks same-generation reopen while permitting a newer generation", async () => {
  const closeAck = deferred<BoundCompletion<{ protocolVersion: 1; requestId: string; composeId: string; composeGeneration: number; closed: true }>>();
  let closeRequest!: OpenComposeRequest;
  const client = mockClient({
    openCompose: async (request) => completion(openResponse(request)),
    closeCompose: async (request) => { closeRequest = request; return closeAck.promise; },
  });
  const lifecycle = new DirectComposeLifecycleRegistry(client);
  await lifecycle.open(identity);
  const closing = lifecycle.close(identity.composeId, "close-one");
  await assert.rejects(lifecycle.open(identity), code("STALE_COMPOSE_GENERATION"));
  const newer = await lifecycle.open({ ...identity, composeGeneration: 2 });
  assert.equal(newer.composeGeneration, 2);
  closeAck.resolve(completion({ protocolVersion: 1, requestId: closeRequest.requestId, composeId: closeRequest.composeId, composeGeneration: closeRequest.composeGeneration, closed: true }));
  await closing;
  await assert.rejects(lifecycle.open(identity), code("STALE_COMPOSE_GENERATION"));
  assert.equal(lifecycle.get(identity.composeId)?.composeGeneration, 2);
});

test("same-generation agent replacement and invalid generations fail before I/O", async () => {
  let opens = 0;
  const client = mockClient({ openCompose: async (request) => { opens += 1; return completion(openResponse(request)); } });
  const lifecycle = new DirectComposeLifecycleRegistry(client);
  await lifecycle.open(identity);
  await assert.rejects(lifecycle.open({ ...identity, agentId: "agent-b" }), code("AGENT_MISMATCH"));
  for (const composeGeneration of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(lifecycle.open({ ...identity, composeId: `bad-${composeGeneration}`, composeGeneration }), code("STALE_COMPOSE_GENERATION"));
  }
  assert.equal(opens, 1);
});
