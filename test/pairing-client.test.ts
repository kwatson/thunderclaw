import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { DirectClientError } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { canonicalizeApiBase } from "../packages/thunderbird-extension/src/endpoint-policy.js";
import {
  BrowserPairingClient,
  pairingVerifier,
  randomPairingValue,
  type PairingRequestMaterial,
} from "../packages/thunderbird-extension/src/pairing-client.js";

const endpoint = canonicalizeApiBase("https://gateway.example:8443/thunderclaw/v1");
const requestId = "request_12345678901234567890";
const deviceId = "device_123456789012345678901";
const credentialId = "credential_123456789012345678";
const rawCredential = `${credentialId}.${"d".repeat(43)}`;
const claimCredential = `${requestId}.${"c".repeat(43)}`;
const now = Date.UTC(2026, 7, 10, 12);
const requestExpiresAt = new Date(now + 5 * 60_000).toISOString();
const credentialExpiresAt = new Date(now + 90 * 24 * 60 * 60_000).toISOString();
const requiredCapabilities = [
  "status:read", "agents:read", "agents:probe", "compose:transform", "message:transform",
  "credential:rotate", "credential:revoke",
];

function material(): PairingRequestMaterial {
  return {
    requestId,
    deviceId,
    deviceName: "Thunderbird on Test Device",
    claimCredential,
    claimVerifier: "b".repeat(64),
    prospective: { credentialId, rawCredential, credentialVerifier: "a".repeat(64) },
  };
}

function responseAt(url: string, body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}

function deviceEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    device: {
      credentialId,
      deviceId,
      deviceName: "Thunderbird on Test Device",
      capabilities: requiredCapabilities,
      expiresAt: credentialExpiresAt,
      ...overrides,
    },
  };
}

function pairingClient(fetchImpl: typeof fetch): BrowserPairingClient {
  return new BrowserPairingClient(endpoint, fetchImpl, () => now);
}

function rejects(kind: DirectClientError["kind"], code: string): (error: unknown) => boolean {
  return (error) => error instanceof DirectClientError && error.kind === kind && error.code === code;
}

test("pairing verifiers are domain-separated SHA-256 values and secrets use 256 Web Crypto bits", async () => {
  const expected = (domain: string, value: string) => createHash("sha256").update(`${domain}\0${value}`).digest("hex");
  assert.equal(await pairingVerifier("device", rawCredential), expected("thunderclaw-device-credential-v1", rawCredential));
  assert.equal(await pairingVerifier("claim", claimCredential), expected("thunderclaw-pairing-claim-v1", claimCredential));
  assert.notEqual(await pairingVerifier("device", rawCredential), await pairingVerifier("claim", rawCredential));

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let requested = 0;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues<T extends ArrayBufferView | null>(value: T): T {
        assert.ok(value instanceof Uint8Array);
        requested = value.byteLength;
        for (let index = 0; index < value.length; index += 1) value[index] = index;
        return value;
      },
    },
  });
  try {
    const generated = randomPairingValue();
    assert.equal(requested, 32);
    assert.match(generated, /^[A-Za-z0-9_-]{43}$/u);
    assert.doesNotMatch(generated, /[+/=]/u);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("request sends only exact public pairing material to the fixed origin-scoped route", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = pairingClient(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return responseAt(String(input), {
      protocolVersion: 1,
      requestId,
      approvalCode: "ABCDE-23456",
      expiresAt: requestExpiresAt,
    }, 201);
  });
  const result = await client.request(material());
  assert.deepEqual(result, { requestId, approvalCode: "ABCDE-23456", expiresAt: requestExpiresAt });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://gateway.example:8443/thunderclaw/pairing/v1/requests");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(calls[0]?.init.redirect, "manual");
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    protocolVersion: 1,
    requestId,
    deviceId,
    deviceName: "Thunderbird on Test Device",
    credentialId,
    credentialVerifier: "a".repeat(64),
    claimVerifier: "b".repeat(64),
  });
  assert.equal(String(calls[0]?.init.body).includes(rawCredential), false);
  assert.equal(String(calls[0]?.init.body).includes(claimCredential), false);
});

test("claim, rotation, and revocation use exact credentials, bodies, and fixed routes", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const nextId = "credential_next_123456789012345";
  const nextRaw = `${nextId}.${"n".repeat(43)}`;
  const client = pairingClient(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/claim")) return responseAt(String(input), deviceEnvelope());
    if (String(input).endsWith("/rotate")) return responseAt(String(input), deviceEnvelope({ credentialId: nextId }));
    return responseAt(String(input), { protocolVersion: 1, revoked: true });
  });
  await client.claim(material());
  const rotated = await client.rotate(rawCredential, {
    credentialId: nextId,
    rawCredential: nextRaw,
    credentialVerifier: "e".repeat(64),
  }, { deviceId, deviceName: "Thunderbird on Test Device" });
  await client.revoke(nextRaw);

  assert.equal(rotated.credentialId, nextId);
  assert.deepEqual(calls.map((call) => call.url), ["claim", "rotate", "revoke"].map((path) => `https://gateway.example:8443/thunderclaw/pairing/v1/${path}`));
  assert.equal(new Headers(calls[0]?.init.headers).get("authorization"), `Bearer ${claimCredential}`);
  assert.equal(calls[0]?.init.body, undefined);
  assert.equal(new Headers(calls[1]?.init.headers).get("authorization"), `Bearer ${rawCredential}`);
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    protocolVersion: 1, credentialId: nextId, credentialVerifier: "e".repeat(64),
  });
  assert.equal(String(calls[1]?.init.body).includes(nextRaw), false);
  assert.equal(new Headers(calls[2]?.init.headers).get("authorization"), `Bearer ${nextRaw}`);
  assert.equal(calls[2]?.init.body, undefined);
});

test("credentials and claim secrets are strictly shaped before any pairing I/O", async () => {
  let fetches = 0;
  const client = pairingClient(async () => {
    fetches += 1;
    throw new Error("must not fetch");
  });
  for (const credential of ["secret", `${credentialId}.short`, `${credentialId}.${"x".repeat(42)}`, `${credentialId}.${"x".repeat(129)}`]) {
    await assert.rejects(client.revoke(credential), rejects("authentication", "INVALID_CREDENTIAL"));
  }
  for (const credential of ["secret", `${requestId}.short`, `${requestId}.${"x".repeat(42)}`, `${requestId}.${"x".repeat(129)}`]) {
    await assert.rejects(client.claim({ ...material(), claimCredential: credential }), rejects("authentication", "INVALID_CREDENTIAL"));
  }
  assert.equal(fetches, 0);
});

test("paired device responses bind exact identity, capabilities, and future expiry", async () => {
  const cases: Array<Record<string, unknown>> = [
    { credentialId: "credential_other_1234567890123" },
    { deviceId: "device_other_123456789012345" },
    { deviceName: "Another device" },
    { capabilities: [...requiredCapabilities].reverse() },
    { capabilities: requiredCapabilities.slice(0, -1) },
    { capabilities: [...requiredCapabilities, "gateway:admin"] },
    { expiresAt: "2000-01-01T00:00:00.000Z" },
    { expiresAt: "not-a-date" },
  ];
  for (const changed of cases) {
    const client = pairingClient(async (input) => responseAt(String(input), deviceEnvelope(changed)));
    await assert.rejects(client.claim(material()), rejects("contract", "INVALID_PAIRING_RESPONSE"));
  }
});

test("redirects, cross-origin final URLs, malformed bodies, and response overflow fail closed", async () => {
  const cases: Array<(url: string) => Response> = [
    (url) => responseAt(url, { protocolVersion: 1 }, 302),
    () => responseAt("https://attacker.example/thunderclaw/pairing/v1/requests", { protocolVersion: 1 }),
    (url) => responseAt(url, { protocolVersion: 1 }, 200, { "content-length": "01" }),
    (url) => responseAt(url, { protocolVersion: 1 }, 200, { "content-length": "65537" }),
    (url) => {
      const response = new Response("x".repeat(65_537), { status: 200 });
      Object.defineProperty(response, "url", { configurable: true, value: url });
      return response;
    },
  ];
  for (const make of cases) {
    const client = pairingClient(async (input) => make(String(input)));
    await assert.rejects(client.request(material()), (error: unknown) => error instanceof DirectClientError
      && (error.code === "REDIRECT_REJECTED" || error.code === "INVALID_PAIRING_RESPONSE"));
  }
});

test("pairing errors expose lifecycle classification but never backend secret-bearing messages", async () => {
  const backendSecret = "Bearer server-secret for private@example.test";
  for (const [status, code, kind] of [
    [401, "AUTHENTICATION_FAILED", "authentication"],
    [401, "CREDENTIAL_EXPIRED", "authentication"],
    [401, "CREDENTIAL_REVOKED", "authentication"],
    [429, "RATE_LIMITED", "rate_limit"],
    [503, "PAIRING_UNAVAILABLE", "backend"],
  ] as const) {
    const client = pairingClient(async (input) => responseAt(String(input), {
      error: { code, message: backendSecret },
    }, status));
    await assert.rejects(client.request(material()), (error: unknown) => {
      assert.ok(error instanceof DirectClientError);
      assert.equal(error.kind, kind);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(backendSecret), false);
      assert.equal(JSON.stringify(error).includes(backendSecret), false);
      return true;
    });
  }
});

test("pairing response-body stalls time out and cancel the body after headers arrive", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let cancelled = false;
  Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: (handler: TimerHandler) => originalSetTimeout(handler, 0) });
  Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: originalClearTimeout });
  try {
    const client = pairingClient(async (input) => {
      const body = new ReadableStream<Uint8Array>({
        pull() { /* Deliberately never enqueue or close after response headers. */ },
        cancel() { cancelled = true; },
      });
      const response = new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      Object.defineProperty(response, "url", { configurable: true, value: String(input) });
      return response;
    });
    await assert.rejects(client.request(material()), rejects("timeout", "PAIRING_TIMEOUT"));
    await new Promise((resolve) => originalSetTimeout(resolve, 0));
    assert.equal(cancelled, true);
  } finally {
    Object.defineProperty(globalThis, "setTimeout", { configurable: true, value: originalSetTimeout });
    Object.defineProperty(globalThis, "clearTimeout", { configurable: true, value: originalClearTimeout });
  }
});
