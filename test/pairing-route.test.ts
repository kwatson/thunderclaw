import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerPairingAdministration } from "../packages/openclaw-plugin/src/pairing-admin.js";
import {
  PairingRegistry,
  claimCredentialVerifier,
  deviceCredentialVerifier,
} from "../packages/openclaw-plugin/src/pairing-registry.js";
import { createPairingRoute } from "../packages/openclaw-plugin/src/pairing-route.js";

const REQUEST_ID = "request_http_123456789012345";
const DEVICE_ID = "device_http_1234567890123456";
const CREDENTIAL_ID = "credential_http_123456789012";
const CLAIM_TOKEN = `${REQUEST_ID}.claim_secret_abcdefghijklmnopqrstuvwxyz012345`;
const DEVICE_TOKEN = `${CREDENTIAL_ID}.device_secret_abcdefghijklmnopqrstuvwxyz01234`;

async function fixture(context: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-pairing-http-"));
  let current = Date.UTC(2026, 7, 10, 12);
  const registry = PairingRegistry.open(stateDir, () => current);
  const handler = createPairingRoute({ registry, now: () => current, randomBytes: () => Buffer.alloc(7) });
  const server = createServer((request, response) => { void handler(request, response); });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  context.after(async () => { registry.close(); await rm(stateDir, { recursive: true, force: true }); });
  return {
    registry,
    base: `http://127.0.0.1:${address.port}/thunderclaw/pairing/v1`,
    advance: (milliseconds: number) => { current += milliseconds; },
  };
}

function requestBody(requestId = REQUEST_ID, credentialId = CREDENTIAL_ID) {
  const claimToken = `${requestId}.claim_secret_abcdefghijklmnopqrstuvwxyz012345`;
  const deviceToken = `${credentialId}.device_secret_abcdefghijklmnopqrstuvwxyz01234`;
  return {
    protocolVersion: 1,
    requestId,
    deviceId: DEVICE_ID,
    deviceName: "HTTP Device",
    credentialId,
    credentialVerifier: deviceCredentialVerifier(deviceToken),
    claimVerifier: claimCredentialVerifier(claimToken),
  };
}

test("public route performs approved one-time claim, rotation, and self revocation", async (context) => {
  const { registry, base } = await fixture(context);
  const issued = await fetch(`${base}/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody()),
  });
  assert.equal(issued.status, 201);
  const issueResult = await issued.json() as { approvalCode: string };
  assert.equal(issueResult.approvalCode, "AAAAA-AAAAA");
  registry.approve(REQUEST_ID, issueResult.approvalCode);

  const claim = await fetch(`${base}/claim`, { method: "POST", headers: { authorization: `Bearer ${CLAIM_TOKEN}` } });
  assert.equal(claim.status, 200);
  const replay = await fetch(`${base}/claim`, { method: "POST", headers: { authorization: `Bearer ${CLAIM_TOKEN}` } });
  assert.equal(replay.status, 401);
  assert.equal((await replay.json() as { error: { code: string } }).error.code, "AUTHENTICATION_FAILED");

  const nextId = "credential_next_123456789012";
  const nextToken = `${nextId}.next_secret_abcdefghijklmnopqrstuvwxyz012345`;
  const rotated = await fetch(`${base}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${DEVICE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, credentialId: nextId, credentialVerifier: deviceCredentialVerifier(nextToken) }),
  });
  assert.equal(rotated.status, 200);
  const oldCredential = await fetch(`${base}/revoke`, { method: "POST", headers: { authorization: `Bearer ${DEVICE_TOKEN}` } });
  assert.equal(oldCredential.status, 401);
  const revoked = await fetch(`${base}/revoke`, { method: "POST", headers: { authorization: `Bearer ${nextToken}` } });
  assert.equal(revoked.status, 200);
  assert.equal(registry.listDevices().filter((device) => device.revokedAt !== null).length, 2);
});

test("public route enforces exact JSON, body bounds, empty-body operations, and sanitized errors", async (context) => {
  const { base } = await fixture(context);
  const extra = await fetch(`${base}/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...requestBody(), extra: true }),
  });
  assert.equal(extra.status, 400);
  const query = await fetch(`${base}/status?debug=true`);
  assert.equal(query.status, 400);
  const oversized = await fetch(`${base}/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(5000) }),
  });
  assert.equal(oversized.status, 400);
  const bodyOnClaim = await fetch(`${base}/claim`, {
    method: "POST", headers: { authorization: `Bearer ${CLAIM_TOKEN}`, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(bodyOnClaim.status, 400);
  const malformedAuth = await fetch(`${base}/claim`, { method: "POST", headers: { authorization: "Bearer secret" } });
  assert.deepEqual(await malformedAuth.json(), { error: { code: "AUTHENTICATION_FAILED", message: "device authentication failed" } });
});

test("public issue route is bounded by a per-address rate window", async (context) => {
  const { base, advance } = await fixture(context);
  for (let index = 0; index < 10; index += 1) {
    const response = await fetch(`${base}/requests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody(`request_rate_${String(index).padStart(20, "0")}`, `credential_rate_${String(index).padStart(17, "0")}`)),
    });
    assert.equal(response.status, 201);
  }
  const limited = await fetch(`${base}/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody("request_rate_limit_123456789", "credential_rate_limit_12345")),
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "600");
  assert.equal((await limited.json() as { error: { code: string } }).error.code, "RATE_LIMITED");
  advance(10 * 60_000);
  const reset = await fetch(`${base}/requests`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody("request_rate_reset_123456789", "credential_rate_reset_12345")),
  });
  assert.equal(reset.status, 201);
});

test("Gateway administration uses scoped methods, exact parameters, and sanitized failures", async (context) => {
  const { registry } = await fixture(context);
  type Handler = (context: { params: Record<string, unknown>; respond: (...args: unknown[]) => void }) => void;
  const methods = new Map<string, { handler: Handler; scope: string }>();
  const api = {
    registerGatewayMethod: (name: string, handler: Handler, options: { scope: string }) => methods.set(name, { handler, scope: options.scope }),
  } as unknown as OpenClawPluginApi;
  registerPairingAdministration(api, registry);
  assert.equal(methods.get("thunderclaw.pairing.requests")?.scope, "operator.read");
  assert.equal(methods.get("thunderclaw.pairing.approve")?.scope, "operator.admin");
  assert.equal(methods.get("thunderclaw.devices.revoke")?.scope, "operator.admin");

  const call = (name: string, params: Record<string, unknown>) => {
    let response: unknown[] | undefined;
    methods.get(name)!.handler({ params, respond: (...args) => { response = args; } });
    assert.ok(response);
    return response;
  };
  assert.equal(call("thunderclaw.pairing.status", { unexpected: true })[0], false);
  assert.equal((call("thunderclaw.pairing.status", {})[1] as { available: boolean }).available, true);
  const failure = call("thunderclaw.pairing.approve", { requestId: REQUEST_ID, approvalCode: "not-a-code", extra: true });
  assert.equal(failure[0], false);
  assert.equal((failure[2] as { code: string }).code, "INVALID_REQUEST");
});
