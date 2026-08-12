const ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/u;
const MAX_DEVICE_NAME_CHARACTERS = 120;
const MAX_REQUESTS = 1000;
const MAX_DEVICES = 500;

export const DEVICE_CAPABILITIES = [
  "status:read",
  "agents:read",
  "agents:probe",
  "compose:transform",
  "message:transform",
  "credential:rotate",
  "credential:revoke",
] as const;

export type PairingCliRequest = {
  requestId: string;
  deviceId: string;
  deviceName: string;
  credentialId: string;
  state: "pending" | "approved";
  createdAt: string;
  expiresAt: string;
};

export type PairingCliDevice = {
  credentialId: string;
  deviceId: string;
  deviceName: string;
  capabilities: readonly (typeof DEVICE_CAPABILITIES)[number][];
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  replacedBy: string | null;
};

export type PairingCliStatus = { protocolVersion: 1; available: boolean };
export type PairingCliRequests = { protocolVersion: 1; requests: PairingCliRequest[] };
export type PairingCliDevices = { protocolVersion: 1; devices: PairingCliDevice[] };

export class PairingCliResponseError extends Error {
  readonly code = "INVALID_GATEWAY_RESPONSE";

  constructor() {
    super("Gateway returned an invalid ThunderClaw response");
  }
}

function fail(): never {
  throw new PairingCliResponseError();
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    const descriptor = descriptors[key];
    return !descriptor || !("value" in descriptor) || descriptor.enumerable !== true;
  })) fail();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function boundedArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys.some((key) => {
    if (key === "length") return false;
    return typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length;
  })) fail();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) fail();
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail();
  return value;
}

function deviceName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_DEVICE_NAME_CHARACTERS) fail();
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) fail();
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || new Date(milliseconds).toISOString() !== value) fail();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function protocolVersion(value: unknown): 1 {
  if (value !== 1) fail();
  return 1;
}

export function validateIdentifier(value: unknown): string {
  return identifier(value);
}

export function validatePairingStatus(value: unknown): PairingCliStatus {
  const record = exactObject(value, ["protocolVersion", "available"]);
  if (typeof record.available !== "boolean") fail();
  return { protocolVersion: protocolVersion(record.protocolVersion), available: record.available };
}

function validatePairingRequest(value: unknown): PairingCliRequest {
  const record = exactObject(value, [
    "requestId", "deviceId", "deviceName", "credentialId", "state", "createdAt", "expiresAt",
  ]);
  if (record.state !== "pending" && record.state !== "approved") fail();
  const createdAt = timestamp(record.createdAt);
  const expiresAt = timestamp(record.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) fail();
  return {
    requestId: identifier(record.requestId),
    deviceId: identifier(record.deviceId),
    deviceName: deviceName(record.deviceName),
    credentialId: identifier(record.credentialId),
    state: record.state,
    createdAt,
    expiresAt,
  };
}

export function validatePairingRequests(value: unknown): PairingCliRequests {
  const record = exactObject(value, ["protocolVersion", "requests"]);
  const requests = boundedArray(record.requests, MAX_REQUESTS);
  const validated = requests.map(validatePairingRequest);
  if (new Set(validated.map((request) => request.requestId)).size !== validated.length
    || new Set(validated.map((request) => request.credentialId)).size !== validated.length) fail();
  return {
    protocolVersion: protocolVersion(record.protocolVersion),
    requests: validated,
  };
}

function validateCapabilities(value: unknown): PairingCliDevice["capabilities"] {
  const capabilities = boundedArray(value, DEVICE_CAPABILITIES.length);
  if (capabilities.length !== DEVICE_CAPABILITIES.length
    || capabilities.some((capability, index) => capability !== DEVICE_CAPABILITIES[index])) fail();
  return [...DEVICE_CAPABILITIES];
}

function validatePairingDevice(value: unknown): PairingCliDevice {
  const record = exactObject(value, [
    "credentialId", "deviceId", "deviceName", "capabilities", "createdAt", "expiresAt",
    "lastUsedAt", "revokedAt", "replacedBy",
  ]);
  const credentialId = identifier(record.credentialId);
  const createdAt = timestamp(record.createdAt);
  const expiresAt = timestamp(record.expiresAt);
  const lastUsedAt = nullableTimestamp(record.lastUsedAt);
  const revokedAt = nullableTimestamp(record.revokedAt);
  const replacedBy = record.replacedBy === null ? null : identifier(record.replacedBy);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) fail();
  if (lastUsedAt !== null && Date.parse(lastUsedAt) < Date.parse(createdAt)) fail();
  if (revokedAt !== null && Date.parse(revokedAt) < Date.parse(createdAt)) fail();
  if (replacedBy !== null && (replacedBy === credentialId || revokedAt === null)) fail();
  return {
    credentialId,
    deviceId: identifier(record.deviceId),
    deviceName: deviceName(record.deviceName),
    capabilities: validateCapabilities(record.capabilities),
    createdAt,
    expiresAt,
    lastUsedAt,
    revokedAt,
    replacedBy,
  };
}

export function validatePairingDevices(value: unknown): PairingCliDevices {
  const record = exactObject(value, ["protocolVersion", "devices"]);
  const devices = boundedArray(record.devices, MAX_DEVICES);
  const validated = devices.map(validatePairingDevice);
  if (new Set(validated.map((device) => device.credentialId)).size !== validated.length) fail();
  return {
    protocolVersion: protocolVersion(record.protocolVersion),
    devices: validated,
  };
}

function validateMutation(value: unknown, field: "approved" | "denied" | "revoked"): { protocolVersion: 1 } & Record<typeof field, true> {
  const record = exactObject(value, ["protocolVersion", field]);
  if (record[field] !== true) fail();
  return { protocolVersion: protocolVersion(record.protocolVersion), [field]: true } as { protocolVersion: 1 } & Record<typeof field, true>;
}

export const validateApproval = (value: unknown) => validateMutation(value, "approved");
export const validateDenial = (value: unknown) => validateMutation(value, "denied");
export const validateRevocation = (value: unknown) => validateMutation(value, "revoked");

export function normalizeApprovalCode(value: string): string {
  const upper = value.toUpperCase();
  if (!/^(?:[A-Z2-7]{10}|[A-Z2-7]{5}-[A-Z2-7]{5})$/u.test(upper)) {
    throw new Error("Approval code must contain ten Base32 characters, with an optional hyphen");
  }
  const normalized = upper.replace("-", "");
  return `${normalized.slice(0, 5)}-${normalized.slice(5)}`;
}
