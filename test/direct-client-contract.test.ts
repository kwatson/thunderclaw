import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CONNECTION_CLEANUP_TIMEOUT_MS,
  DIRECT_CLIENT_ERROR_KINDS,
  DirectClientError,
  classifyBackendError,
  nextConnectionEpoch,
  sameConnectionBinding,
  type ConnectionBinding,
  type DeviceCredentialAuthentication,
} from "../packages/thunderbird-extension/src/direct-client-contract.js";
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
