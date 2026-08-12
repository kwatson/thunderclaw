import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVICE_CAPABILITIES,
  normalizeApprovalCode,
  PairingCliResponseError,
  validateApproval,
  validatePairingDevices,
  validatePairingRequests,
  validatePairingStatus,
} from "../packages/openclaw-plugin/src/pairing-cli-contract.js";

const request = {
  requestId: "request_contract_123456789",
  deviceId: "device_contract_1234567890",
  deviceName: "Thunderbird",
  credentialId: "credential_contract_123456",
  state: "pending",
  createdAt: "2026-08-11T23:30:00.000Z",
  expiresAt: "2026-08-11T23:40:00.000Z",
};

const device = {
  credentialId: "credential_contract_123456",
  deviceId: "device_contract_1234567890",
  deviceName: "Thunderbird",
  capabilities: [...DEVICE_CAPABILITIES],
  createdAt: "2026-08-11T23:30:00.000Z",
  expiresAt: "2026-11-09T23:30:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  replacedBy: null,
};

test("CLI validators accept only exact protocol-v1 response projections", () => {
  assert.deepEqual(validatePairingStatus({ protocolVersion: 1, available: true }), { protocolVersion: 1, available: true });
  assert.deepEqual(validatePairingRequests({ protocolVersion: 1, requests: [request] }).requests, [request]);
  assert.deepEqual(validatePairingDevices({ protocolVersion: 1, devices: [device] }).devices, [device]);
  assert.deepEqual(validateApproval({ protocolVersion: 1, approved: true }), { protocolVersion: 1, approved: true });

  for (const value of [
    { protocolVersion: 2, available: true },
    { protocolVersion: 1, available: true, extra: "leak" },
    { protocolVersion: 1 },
    Object.assign(Object.create({ inherited: true }), { protocolVersion: 1, available: true }),
  ]) {
    assert.throws(() => validatePairingStatus(value), PairingCliResponseError);
  }
});

test("request validation rejects invalid identifiers, states, dates, names, fields, and oversized arrays", () => {
  const invalid = [
    { ...request, requestId: "short" },
    { ...request, state: "denied" },
    { ...request, deviceName: "x".repeat(121) },
    { ...request, createdAt: "2026-08-11T23:30:00Z" },
    { ...request, expiresAt: request.createdAt },
    { ...request, approvalCodeVerifier: "must-not-leak" },
  ];
  for (const entry of invalid) {
    assert.throws(() => validatePairingRequests({ protocolVersion: 1, requests: [entry] }), PairingCliResponseError);
  }
  assert.throws(
    () => validatePairingRequests({ protocolVersion: 1, requests: Array.from({ length: 1001 }, () => request) }),
    PairingCliResponseError,
  );
  const maximum = Array.from({ length: 1000 }, (_, index) => ({
    ...request,
    requestId: `request_${String(index).padStart(20, "0")}`,
    credentialId: `credential_${String(index).padStart(20, "0")}`,
  }));
  assert.equal(validatePairingRequests({ protocolVersion: 1, requests: maximum }).requests.length, 1000);
  assert.throws(() => validatePairingRequests({ protocolVersion: 1, requests: [request, request] }), PairingCliResponseError);
});

test("device validation enforces fixed capabilities, nullability, consistency, and limits", () => {
  const invalid = [
    { ...device, capabilities: DEVICE_CAPABILITIES.slice(0, -1) },
    { ...device, capabilities: [...DEVICE_CAPABILITIES].reverse() },
    { ...device, lastUsedAt: "yesterday" },
    { ...device, lastUsedAt: "2026-08-10T23:30:00.000Z" },
    { ...device, replacedBy: "credential_replaced_1234567", revokedAt: null },
    { ...device, replacedBy: device.credentialId, revokedAt: "2026-08-12T00:00:00.000Z" },
    { ...device, verifier: "secret" },
  ];
  for (const entry of invalid) {
    assert.throws(() => validatePairingDevices({ protocolVersion: 1, devices: [entry] }), PairingCliResponseError);
  }
  assert.throws(
    () => validatePairingDevices({ protocolVersion: 1, devices: Array.from({ length: 501 }, () => device) }),
    PairingCliResponseError,
  );
  const maximum = Array.from({ length: 500 }, (_, index) => ({
    ...device,
    credentialId: `credential_${String(index).padStart(20, "0")}`,
  }));
  assert.equal(validatePairingDevices({ protocolVersion: 1, devices: maximum }).devices.length, 500);
  assert.throws(() => validatePairingDevices({ protocolVersion: 1, devices: [device, device] }), PairingCliResponseError);
});

test("validator never invokes hostile accessors", () => {
  let accessed = false;
  const hostile = { protocolVersion: 1 } as { protocolVersion: number; available?: boolean };
  Object.defineProperty(hostile, "available", {
    enumerable: true,
    get() { accessed = true; return true; },
  });
  assert.throws(() => validatePairingStatus(hostile), PairingCliResponseError);
  assert.equal(accessed, false);

  const hostileArray = [request];
  Object.defineProperty(hostileArray, "0", {
    enumerable: true,
    get() { accessed = true; return request; },
  });
  assert.throws(() => validatePairingRequests({ protocolVersion: 1, requests: hostileArray }), PairingCliResponseError);
  assert.equal(accessed, false);
});

test("approval code normalization accepts case and one optional hyphen without trimming", () => {
  assert.equal(normalizeApprovalCode("abcde-fghij"), "ABCDE-FGHIJ");
  assert.equal(normalizeApprovalCode("abcdefghij"), "ABCDE-FGHIJ");
  for (const value of [" ABCDE-FGHIJ", "ABCDE-FGHIJ ", "ABCDE--FGHIJ", "ABCDE-FGHI1", "ABC"]) {
    assert.throws(() => normalizeApprovalCode(value));
  }
});
