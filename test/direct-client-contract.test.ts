import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONNECTION_CLEANUP_TIMEOUT_MS,
  DIRECT_CLIENT_ERROR_KINDS,
  DIRECT_OPERATION_SPECS,
  DirectClientError,
  classifyBackendError,
  nextConnectionEpoch,
  sameConnectionBinding,
  type AgentRecord,
  type ConnectionBinding,
  type DeviceCredentialAuthentication,
} from "../packages/thunderbird-extension/src/direct-client-contract.js";
import type { ThunderClawAgentRecord } from "../packages/openclaw-plugin/src/agents.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<Condition extends true> = Condition;
type AgentCompatibilityContractMatchesPublicRoute = Assert<Equal<
  AgentRecord["compatibility"],
  ThunderClawAgentRecord["compatibility"]
>>;

test("direct operation contract maps every product operation to fixed plugin routes", async () => {
  const routeSource = await readFile(new URL("../packages/openclaw-plugin/src/route.ts", import.meta.url), "utf8");
  const currentOperations = ["hello", "status", "agents.list", "agents.probe", "agents.probe.cancel", "compose.open", "compose.transform", "compose.cancel", "compose.close", "message.transform", "message.cancel"] as const;
  for (const operation of currentOperations) {
    const spec = DIRECT_OPERATION_SPECS[operation];
    assert.equal(spec.implementedByCurrentPlugin, true, operation);
    assert.match(routeSource, new RegExp(`path === ["']\\/thunderclaw\\/v1${spec.path.replaceAll("/", "\\/")}["']`, "u"), operation);
    assert.ok(spec.timeoutMs > 0, operation);
    assert.ok(spec.maxResponseBytes > 0, operation);
  }
  assert.equal(DIRECT_OPERATION_SPECS.hello.path, DIRECT_OPERATION_SPECS.status.path);
});

test("agent probe operations have fixed bounded routes and deadlines", () => {
  assert.deepEqual(DIRECT_OPERATION_SPECS["agents.probe"], {
    method: "POST",
    path: "/agents/probe",
    timeoutMs: 195_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 262_144,
    implementedByCurrentPlugin: true,
  });
  assert.deepEqual(DIRECT_OPERATION_SPECS["agents.probe.cancel"], {
    method: "POST",
    path: "/agents/probe/cancel",
    timeoutMs: 10_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 65_536,
    implementedByCurrentPlugin: true,
  });
});

test("message cancellation is an explicit implemented server operation", () => {
  assert.deepEqual(DIRECT_OPERATION_SPECS["message.cancel"], {
    method: "POST",
    path: "/message/cancel",
    timeoutMs: 10_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 65_536,
    implementedByCurrentPlugin: true,
  });
});

test("connection bindings include every invalidation input and epochs only advance", () => {
  const original: ConnectionBinding = {
    apiBase: "https://gateway.example/thunderclaw/v1",
    origin: "https://gateway.example",
    credential: { mode: "device_credential", credentialId: "device-1" },
    permissionId: "https://gateway.example/*",
    epoch: 7,
  };
  assert.equal(CONNECTION_CLEANUP_TIMEOUT_MS, 10_000);
  assert.equal(nextConnectionEpoch(original.epoch), 8);
  assert.equal(sameConnectionBinding(original, { ...original }), true);
  assert.equal(sameConnectionBinding(original, { ...original, epoch: 8 }), false);
  assert.equal(sameConnectionBinding(original, { ...original, credential: { ...original.credential, credentialId: "device-2" } }), false);
  assert.throws(() => nextConnectionEpoch(Number.MAX_SAFE_INTEGER), (error: unknown) => error instanceof DirectClientError && error.kind === "configuration");
});

test("authentication contract admits only background-owned device credentials", async () => {
  const authorize = async () => undefined;
  const production = {
    binding: { mode: "device_credential", credentialId: "device-id" },
    developmentOnly: false,
    authorize,
  } satisfies DeviceCredentialAuthentication;
  assert.equal(production.developmentOnly, false);
  assert.equal("credential" in production.binding, false);
  const source = await readFile(new URL("../packages/thunderbird-extension/src/direct-client-contract.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DevelopmentNarrowTokenAuthentication|development_narrow_token/u);
});

test("agent compatibility freezes every public v1 safety field", async () => {
  const source = await readFile(new URL("../packages/openclaw-plugin/src/agents.ts", import.meta.url), "utf8");
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
    },
    lastProbe: {
      testedAt: "2026-08-08T00:00:00.000Z",
      observedProvider: "provider",
      observedModel: "model",
    },
    reason: "Restricted checks passed.",
  } as const satisfies AgentRecord["compatibility"];

  assert.deepEqual(Object.keys(compatibility).sort(), [
    "checks",
    "executionMode",
    "lastProbe",
    "reason",
    "state",
    "toolsDisabled",
    "usesMemory",
    "usesPersonality",
  ]);
  for (const field of ["executionMode", "usesPersonality", "usesMemory", "toolsDisabled", "checks", "lastProbe", "reason"]) {
    assert.match(source, new RegExp(`\\b${field}:`, "u"));
  }
});

test("error taxonomy reflects honest browser and structured-backend semantics", () => {
  assert.equal(DIRECT_CLIENT_ERROR_KINDS.includes("network"), true);
  assert.equal((DIRECT_CLIENT_ERROR_KINDS as readonly string[]).includes("tls"), false);
  const cases: Array<[string[], DirectClientError["kind"]]> = [
    [["UNAUTHORIZED", "AUTHENTICATION_REQUIRED", "AUTHENTICATION_FAILED", "INVALID_CREDENTIAL", "CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "AUTH_DEVICE_EXPIRED"], "authentication"],
    [["PERMISSION_DENIED", "INSUFFICIENT_PERMISSION", "FORBIDDEN"], "permission"],
    [["RATE_LIMITED", "RATE_LIMIT_EXCEEDED"], "rate_limit"],
    [["RUN_TIMEOUT", "PROBE_TIMEOUT"], "timeout"],
    [["RUN_CANCELLED", "CANCELLED", "PROBE_CANCELLED", "CANCEL_FUTURE_OPERATION"], "cancellation"],
    [["UNKNOWN_AGENT", "UNSUPPORTED_AGENT", "NOT_FOUND", "PROBE_ALREADY_ACTIVE", "PROBE_CAPACITY_EXCEEDED"], "capability"],
    [["INVALID_REQUEST", "REQUEST_TOO_LARGE", "MALFORMED_JSON", "UNSUPPORTED_PROTOCOL", "AGENT_MISMATCH", "RUN_ALREADY_ACTIVE", "RUN_NOT_ACTIVE", "COMPOSE_NOT_OPEN", "INVALID_AGENT_OUTPUT", "UNSAFE_AGENT_OUTPUT", "EMPTY_AGENT_OUTPUT", "OUTPUT_TOO_LARGE", "INVALID_BACKEND_RESPONSE", "UNSAFE_BACKEND_RESPONSE", "STALE_OR_MISMATCHED_RESULT", "STALE_COMPOSE_GENERATION", "PROBE_NOT_ACTIVE", "PROBE_SUPERSEDED", "STALE_FUTURE_IDENTITY"], "contract"],
    [["PROBE_FAILED", "COMPATIBILITY_UNAVAILABLE", "INTERNAL_ERROR", "INVALID_TOKEN", "CAPABILITY_DENIED", "UNKNOWN_CODE"], "backend"],
  ];
  for (const [codes, kind] of cases) {
    for (const code of codes) assert.equal(classifyBackendError(code, 400), kind, code);
  }
  assert.equal(classifyBackendError("UNKNOWN_CODE", 403), "backend", "HTTP 403 alone does not prove permission semantics");
  assert.equal(classifyBackendError("UNKNOWN_CODE", 429), "rate_limit");
});
