import assert from "node:assert/strict";
import test from "node:test";

type ClickHandler = () => void;

class FakeElement {
  value = "";
  disabled = false;
  textContent = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  private handlers = new Map<string, ClickHandler[]>();

  addEventListener(type: string, handler: ClickHandler): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  click(during: (active: boolean) => void): void {
    during(true);
    try { for (const handler of this.handlers.get("click") ?? []) handler(); }
    finally { during(false); }
  }

  append(...children: FakeElement[]): void { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]): void { this.children = children; }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const OPTIONS_IDS = ["endpoint", "normalize", "pair", "claim", "cancel-pairing", "diagnose", "rotate", "disconnect", "forget", "state", "result", "agents", "pairing"];

test("Pair requests permission directly in the click gesture and denial performs no background pairing, storage, or network", async () => {
  const ids = OPTIONS_IDS;
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  const pair = elements.get("pair")!;
  const endpoint = elements.get("endpoint")!;
  endpoint.value = "https://gateway.example:8443/thunderclaw/v1";

  let inClick = false;
  const permissionResults: Array<() => Promise<boolean>> = [() => Promise.resolve(false)];
  const permissionCalls: unknown[] = [];
  const posted: Array<Record<string, unknown>> = [];
  const responseListeners: Array<(message: unknown) => void> = [];
  let fetchCalls = 0;
  let storageCalls = 0;
  const port = {
    postMessage(message: Record<string, unknown>) { posted.push(message); },
    onMessage: { addListener(listener: (message: unknown) => void) { responseListeners.push(listener); } },
    onDisconnect: { addListener() {} },
  };

  const descriptors = new Map(["document", "browser", "fetch"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    getElementById(id: string) { return elements.get(id) ?? null; },
    createElement() { return new FakeElement(); },
  } });
  Object.defineProperty(globalThis, "browser", { configurable: true, value: {
    runtime: { connect: () => port },
    permissions: {
      request(value: unknown) {
        assert.equal(inClick, true, "permissions.request must be invoked before the user gesture returns");
        permissionCalls.push(value);
        return permissionResults.shift()!();
      },
    },
    storage: { local: { get() { storageCalls += 1; }, set() { storageCalls += 1; }, remove() { storageCalls += 1; } } },
  } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: () => { fetchCalls += 1; throw new Error("unexpected network"); } });

  try {
    await import(`../packages/thunderbird-extension/src/options-entry.js?options-entry-test=${Date.now()}`);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].method, "state");
    pair.click((active) => { inClick = active; });
    await settle();
    await settle();
    assert.equal(posted.filter((message) => message.method === "beginPair").length, 0);

    assert.deepEqual(permissionCalls, [
      { origins: ["https://gateway.example/*"] },
    ]);
    assert.equal(storageCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("the options source sequences pairing after the direct permission promise and does not activate compose or message work", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../packages/thunderbird-extension/src/options-entry.ts", import.meta.url), "utf8");
  const handler = source.match(/pairButton\.addEventListener\("click", \(\) => \{([\s\S]*?)\n\}\);/u)?.[1] ?? "";
  assert.match(handler, /browser\.permissions\.request\(\{ origins: \[endpoint\.permissionPattern\] \}\)/u);
  assert.match(handler, /grant\.then\(async \(granted: boolean\)/u);
  assert.ok(handler.indexOf("browser.permissions.request") < handler.indexOf('request("beginPair"'));
  assert.doesNotMatch(handler.slice(0, handler.indexOf("browser.permissions.request")), /\b(?:fetch|storage|request)\s*\(/u);
  assert.doesNotMatch(source, /compose|messageDisplay|messages\./u);
  assert.match(source, /open the ThunderClaw manager using the installation's OpenClaw CLI/u);
  assert.doesNotMatch(source, /run openclaw thunderclaw/u);
  assert.match(source, /Then return here and select Claim approved pairing/u);
});

test("port loss and background cleanup status never make options revoke a possibly winning grant", async () => {
  const scenarios = [
    { name: "background-pending", response: "background_pending" as const, disconnect: false },
    { name: "port-loss", response: null, disconnect: true },
    { name: "background-complete", response: "complete" as const, disconnect: false },
  ];
  for (const scenario of scenarios) {
    const ids = OPTIONS_IDS;
    const elements = new Map(ids.map((id) => [id, new FakeElement()]));
    const endpoint = elements.get("endpoint")!;
    const result = elements.get("result")!;
    endpoint.value = "https://gateway.example:8443/thunderclaw/v1";
    let inClick = false;
    const posted: Array<Record<string, unknown>> = [];
    const responseListeners: Array<(message: unknown) => void> = [];
    const disconnectListeners: Array<() => void> = [];
    const removes: unknown[] = [];
    const contains: unknown[] = [];
    const port = {
      postMessage(message: Record<string, unknown>) { posted.push(message); },
      onMessage: { addListener(listener: (message: unknown) => void) { responseListeners.push(listener); } },
      onDisconnect: { addListener(listener: () => void) { disconnectListeners.push(listener); } },
    };
    const descriptors = new Map(["document", "browser"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      getElementById(id: string) { return elements.get(id) ?? null; },
      createElement() { return new FakeElement(); },
    } });
    Object.defineProperty(globalThis, "browser", { configurable: true, value: {
      runtime: { connect: () => port },
      permissions: {
        request(value: unknown) {
          assert.equal(inClick, true);
          assert.deepEqual(value, { origins: ["https://gateway.example/*"] });
          return Promise.resolve(true);
        },
        async remove(value: unknown) { removes.push(value); throw new Error("options must not remove permissions"); },
        async contains(value: unknown) { contains.push(value); throw new Error("options must not inspect permissions"); },
      },
    } });
    try {
      await import(`../packages/thunderbird-extension/src/options-entry.js?cleanup-test=${scenario.name}-${Date.now()}`);
      const stateRequest = posted.find((message) => message.method === "state")!;
      for (const listener of responseListeners) listener({
        requestId: stateRequest.requestId,
        ok: true,
        value: { phase: "not_configured", configured: false, permissionGranted: false },
      });
      await settle();

      elements.get("pair")!.click((active) => { inClick = active; });
      await settle();
      const authorizeRequest = posted.find((message) => message.method === "beginPair")!;
      assert.ok(authorizeRequest, `${scenario.name} posts pairing after the grant`);
      if (scenario.disconnect) {
        for (const listener of disconnectListeners) listener();
      } else {
        for (const listener of responseListeners) listener({
          requestId: authorizeRequest.requestId,
          ok: false,
          error: {
            kind: "backend",
            message: "Pairing failed.",
            permissionCleanup: scenario.response,
          },
        });
      }
      await settle();
      await settle();
      assert.equal(removes.length, 0, `${scenario.name} does not remove permissions from options`);
      assert.equal(contains.length, 0, `${scenario.name} does not inspect permissions from options`);
      if (scenario.response === "complete") {
        assert.equal(result.textContent, "Pairing failed.");
      } else {
        assert.equal(result.textContent, scenario.disconnect
          ? "The ThunderClaw settings connection closed. Background permission cleanup is pending; if it remains, revoke ThunderClaw host access in Add-ons Manager."
          : "Pairing failed. Background permission cleanup is pending; if it remains, revoke ThunderClaw host access in Add-ons Manager.");
      }
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
});

test("diagnose permission failure preserves its safe error while refreshing authoritative revoked state", async () => {
  const safeDiagnosticError = "Thunderbird no longer grants access to the configured OpenClaw host.";
  const privateRefreshDetail = "private refresh failure for secret@example.test";
  for (const refreshSucceeds of [true, false]) {
  const ids = OPTIONS_IDS;
    const elements = new Map(ids.map((id) => [id, new FakeElement()]));
    const posted: Array<Record<string, unknown>> = [];
    const responseListeners: Array<(message: unknown) => void> = [];
    const port = {
      postMessage(message: Record<string, unknown>) { posted.push(message); },
      onMessage: { addListener(listener: (message: unknown) => void) { responseListeners.push(listener); } },
      onDisconnect: { addListener() {} },
    };
    const descriptors = new Map(["document", "browser"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      getElementById(id: string) { return elements.get(id) ?? null; },
      createElement() { return new FakeElement(); },
    } });
    Object.defineProperty(globalThis, "browser", { configurable: true, value: {
      runtime: { connect: () => port },
      permissions: { request: async () => { throw new Error("unexpected permission request"); } },
    } });
    try {
      await import(`../packages/thunderbird-extension/src/options-entry.js?diagnose-revocation=${refreshSucceeds}-${Date.now()}`);
      const initialState = posted.find((message) => message.method === "state")!;
      for (const listener of responseListeners) listener({
        requestId: initialState.requestId,
        ok: true,
        value: {
          phase: "ready", configured: true, apiBase: "https://gateway.example:8443/thunderclaw/v1",
          permissionGranted: true, connected: true, epoch: 4,
        },
      });
      await settle();
      assert.equal(elements.get("state")!.textContent, "Connected — status and agents tested");
      assert.equal(elements.get("state")!.dataset.state, "connected");

      elements.get("diagnose")!.click(() => undefined);
      const diagnostic = posted.find((message) => message.method === "diagnose")!;
      assert.ok(diagnostic);
      for (const listener of responseListeners) listener({
        requestId: diagnostic.requestId,
        ok: false,
        error: { kind: "permission", message: safeDiagnosticError },
      });
      await settle();
      const stateRequests = posted.filter((message) => message.method === "state");
      assert.equal(stateRequests.length, 2, "diagnostic failure requests authoritative state exactly once");
      const refresh = stateRequests[1]!;
      for (const listener of responseListeners) listener(refreshSucceeds ? {
        requestId: refresh.requestId,
        ok: true,
        value: {
          phase: "disconnected", configured: true, apiBase: "https://gateway.example:8443/thunderclaw/v1",
          permissionGranted: false, connected: false, epoch: 5,
        },
      } : {
        requestId: refresh.requestId,
        ok: false,
        error: { kind: "backend", message: privateRefreshDetail },
      });
      await settle();
      await settle();

      assert.equal(elements.get("result")!.textContent, safeDiagnosticError, "state refresh cannot replace the original diagnostic error");
      assert.equal(elements.get("result")!.dataset.state, "error");
      assert.equal(elements.get("result")!.textContent.includes(privateRefreshDetail), false);
      if (refreshSucceeds) {
        assert.equal(elements.get("state")!.textContent, "Not connected");
        assert.equal(elements.get("state")!.dataset.state, "disconnected");
      } else {
        assert.equal(elements.get("state")!.textContent, "Connected — status and agents tested",
          "a failed refresh does not synthesize or race in unauthoritative state");
      }
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
});

test("explicit verification cancellation owns UI settlement across completion orderings", async () => {
  const agent = {
    agentId: "agent-a", displayName: "Agent A", isDefault: true, provider: "provider", model: "model",
    compatibility: {
      state: "unverified", executionMode: "restricted-agent", usesPersonality: true, usesMemory: true, toolsDisabled: true,
      checks: { configuration: "passed", credentials: "not_run", structuredOutput: "not_run", toolIsolation: "not_run", cancellation: "not_run", fallbacks: "not_run" },
      lastProbe: null, reason: "This agent has not been verified for the current configuration.",
    },
  };
  const verifiedAgent = {
    ...agent,
    compatibility: {
      ...agent.compatibility,
      state: "verified",
      checks: { configuration: "passed", credentials: "passed", structuredOutput: "passed", toolIsolation: "passed", cancellation: "passed", fallbacks: "not_run" },
      lastProbe: { testedAt: "2026-08-08T20:00:00.000Z", observedProvider: "provider", observedModel: "model" },
      reason: "This agent passed the ThunderClaw compatibility checks.",
    },
  };
  const scenarios = [
    "verify-first", "cancel-first", "preflight-no-agents", "cancel-failure",
    "cancel-failure-late-success", "cancel-failure-late-network", "cancel-failure-late-timeout",
  ] as const;
  for (const scenario of scenarios) {
    const ids = OPTIONS_IDS;
    const elements = new Map(ids.map((id) => [id, new FakeElement()]));
    const posted: Array<Record<string, unknown>> = [];
    const responseListeners: Array<(message: unknown) => void> = [];
    const port = {
      postMessage(message: Record<string, unknown>) { posted.push(message); },
      onMessage: { addListener(listener: (message: unknown) => void) { responseListeners.push(listener); } },
      onDisconnect: { addListener() {} },
    };
    const respond = (request: Record<string, unknown>, response: Record<string, unknown>) => {
      for (const listener of responseListeners) listener({ requestId: request.requestId, ...response });
    };
    const actionButton = (): FakeElement => {
      const card = elements.get("agents")!.children[0]!;
      const actions = card.children.find((child) => (child as any).className === "actions")!;
      return actions.children[0]!;
    };
    const descriptors = new Map(["document", "browser"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      getElementById(id: string) { return elements.get(id) ?? null; },
      createElement() { return new FakeElement(); },
    } });
    Object.defineProperty(globalThis, "browser", { configurable: true, value: {
      runtime: { connect: () => port },
      permissions: { request: async () => { throw new Error("unexpected permission request"); } },
    } });
    try {
      await import(`../packages/thunderbird-extension/src/options-entry.js?cancel-settlement=${scenario}-${Date.now()}`);
      const state = posted.find((message) => message.method === "state")!;
      respond(state, { ok: true, value: { phase: "ready", configured: true, permissionGranted: true, connected: true, epoch: 4 } });
      await settle();
      elements.get("diagnose")!.click(() => undefined);
      const diagnose = posted.find((message) => message.method === "diagnose")!;
      respond(diagnose, { ok: true, value: { status: { protocolVersion: 1, gatewayVersion: "test" }, agents: [agent] } });
      await settle();
      const refreshedState = posted.filter((message) => message.method === "state").at(-1)!;
      if (refreshedState !== state) {
        respond(refreshedState, { ok: true, value: { phase: "ready", configured: true, permissionGranted: true, connected: true, epoch: 4 } });
        await settle();
      }
      actionButton().click(() => undefined);
      const verify = posted.find((message) => message.method === "verifyAgent")!;
      const cancelButton = actionButton();
      assert.equal(cancelButton.textContent, "Cancel verification");
      cancelButton.click(() => undefined);
      const cancel = posted.find((message) => message.method === "cancelAgentVerification")!;
      const verifyFailure = { ok: false, error: { kind: "cancellation", message: "The connection check was cancelled." } };

      if (scenario === "verify-first") {
        respond(verify, verifyFailure);
        await settle();
        assert.notEqual(elements.get("result")!.textContent, "The connection check was cancelled.");
        respond(cancel, { ok: true, value: { agentId: "agent-a", probeRunId: cancel.probeRunId, cancelled: true, agents: [agent] } });
      } else if (scenario === "cancel-first") {
        respond(cancel, { ok: true, value: { agentId: "agent-a", probeRunId: cancel.probeRunId, cancelled: true, agents: [agent] } });
        await settle();
        respond(verify, verifyFailure);
      } else if (scenario === "preflight-no-agents") {
        respond(cancel, { ok: true, value: { agentId: "agent-a", probeRunId: cancel.probeRunId, cancelled: true } });
        await settle();
        respond(verify, verifyFailure);
      } else {
        respond(cancel, { ok: false, error: { kind: "network", message: "The configured OpenClaw service could not be reached." } });
        await settle();
        assert.equal(elements.get("result")!.textContent, "The configured OpenClaw service could not be reached.");
        assert.equal(cancelButton.disabled, false, "failed cancellation remains actionable");
        assert.match(cancelButton.textContent, /Cancel verification/u);
        if (scenario === "cancel-failure-late-success") {
          respond(verify, { ok: true, value: { agent: verifiedAgent, agents: [verifiedAgent] } });
        } else if (scenario === "cancel-failure-late-network") {
          respond(verify, { ok: false, error: { kind: "network", message: "The configured OpenClaw service could not be reached." } });
        } else if (scenario === "cancel-failure-late-timeout") {
          respond(verify, { ok: false, error: { kind: "timeout", message: "The OpenClaw connection timed out." } });
        } else respond(verify, verifyFailure);
      }
      await settle();
      await settle();
      if (scenario === "cancel-failure" || scenario === "cancel-failure-late-success") {
        assert.equal(elements.get("result")!.textContent, "The configured OpenClaw service could not be reached.", "late verify failure cannot overwrite cancel failure");
        assert.equal(elements.get("diagnose")!.disabled, false, "authoritative terminal settlement restores global controls");
        assert.equal(actionButton().textContent, scenario === "cancel-failure-late-success" ? "Retry verification" : "Verify agent");
        if (scenario === "cancel-failure-late-success") {
          const card = elements.get("agents")!.children[0]!;
          assert.equal(card.children[2]!.textContent, "Compatibility: Verified", "authoritative success evidence is rerendered");
        }
      } else if (scenario === "cancel-failure-late-network" || scenario === "cancel-failure-late-timeout") {
        assert.equal(elements.get("result")!.textContent, "The configured OpenClaw service could not be reached.", "indeterminate verify errors preserve the cancel failure");
        assert.equal(cancelButton.disabled, false, "indeterminate verification retains actionable cancellation retry");
        assert.equal(elements.get("diagnose")!.disabled, true, "global actions remain fenced while server state is indeterminate");
      } else {
        assert.equal(elements.get("result")!.textContent, "Agent verification was cancelled.");
        assert.equal(actionButton().textContent, "Verify agent", `${scenario} restores the agent action`);
      }
    } finally {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  }
});
