import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PairingRegistry,
  PairingRegistryAuthenticationError,
  PairingRegistryConflictError,
  PairingRegistryInputError,
  PairingRegistryUnavailableError,
  approvalCodeVerifier,
  type DeviceCapability,
  type DeviceRecord,
} from "./pairing-registry.js";

const MAX_BODY_BYTES = 4096;
const MAX_REQUESTS_PER_WINDOW = 10;
const RATE_WINDOW_MS = 10 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/u;
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/u;
const CREDENTIAL_PATTERN = /^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})$/u;
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

type RateBucket = { count: number; resetsAt: number };

class PairingRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("pairing request rate limit exceeded");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type PairingRouteOptions = {
  registry: PairingRegistry;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
};

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
  return true;
}

function sendRateLimit(res: ServerResponse, error: PairingRateLimitError): true {
  const payload = JSON.stringify({ error: { code: "RATE_LIMITED", message: error.message } });
  res.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "retry-after": String(error.retryAfterSeconds),
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new PairingRegistryInputError("content type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new PairingRegistryInputError("request body is too large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new PairingRegistryInputError("request body is not valid JSON"); }
}

async function requireEmptyBody(req: IncomingMessage): Promise<void> {
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (size > 0) throw new PairingRegistryInputError("request body must be empty");
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PairingRegistryInputError("request must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new PairingRegistryInputError("request fields are invalid");
  }
  return record;
}

function string(record: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = record[key];
  if (typeof value !== "string" || (pattern && !pattern.test(value))) throw new PairingRegistryInputError(`invalid ${key}`);
  return value;
}

function credential(req: IncomingMessage): { credentialId: string; credential: string } {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new PairingRegistryAuthenticationError("AUTHENTICATION_FAILED");
  const value = header.slice(7);
  const match = CREDENTIAL_PATTERN.exec(value);
  if (!match) throw new PairingRegistryAuthenticationError("AUTHENTICATION_FAILED");
  return { credentialId: match[1]!, credential: value };
}

function approvalCode(bytes: Buffer): string {
  if (bytes.length !== 7) throw new Error("approval code entropy source returned the wrong length");
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  bits >>= 6n;
  let value = "";
  for (let index = 0; index < 10; index += 1) {
    value = CODE_ALPHABET[Number(bits & 31n)] + value;
    bits >>= 5n;
  }
  return value;
}

function publicDevice(device: DeviceRecord) {
  return {
    credentialId: device.credentialId,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    capabilities: device.capabilities,
    expiresAt: device.expiresAt,
  };
}

function errorResponse(res: ServerResponse, error: unknown): true {
  if (error instanceof PairingRateLimitError) return sendRateLimit(res, error);
  if (error instanceof PairingRegistryInputError) return sendJson(res, 400, { error: { code: error.code, message: error.message } });
  if (error instanceof PairingRegistryAuthenticationError) return sendJson(res, 401, { error: { code: error.code, message: error.message } });
  if (error instanceof PairingRegistryConflictError) return sendJson(res, 409, { error: { code: error.code, message: error.message } });
  if (error instanceof PairingRegistryUnavailableError) return sendJson(res, 503, { error: { code: error.code, message: error.message } });
  return sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: "pairing operation failed" } });
}

export function createPairingRoute(options: PairingRouteOptions) {
  const now = options.now ?? Date.now;
  const entropy = options.randomBytes ?? randomBytes;
  const rateBuckets = new Map<string, RateBucket>();

  function enforceRateLimit(req: IncomingMessage): void {
    const current = now();
    const address = req.socket.remoteAddress ?? "unknown";
    const existing = rateBuckets.get(address);
    const bucket = !existing || existing.resetsAt <= current
      ? { count: 0, resetsAt: current + RATE_WINDOW_MS }
      : existing;
    bucket.count += 1;
    rateBuckets.set(address, bucket);
    if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
      throw new PairingRateLimitError(Math.max(1, Math.ceil((bucket.resetsAt - current) / 1000)));
    }
    if (rateBuckets.size > 1024) {
      for (const [key, candidate] of rateBuckets) if (candidate.resetsAt <= current) rateBuckets.delete(key);
      while (rateBuckets.size > 2048) rateBuckets.delete(rateBuckets.keys().next().value as string);
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.search !== "") throw new PairingRegistryInputError("query parameters are not supported");
      if (req.method === "GET" && url.pathname === "/thunderclaw/pairing/v1/status") {
        return sendJson(res, 200, {
          protocolVersion: 1,
          pairingAvailable: options.registry.isAvailable,
          credentialFormat: "bearer-device-v1",
        });
      }
      if (req.method === "POST" && url.pathname === "/thunderclaw/pairing/v1/requests") {
        enforceRateLimit(req);
        const record = exactRecord(await readJson(req), ["protocolVersion", "requestId", "deviceId", "deviceName", "credentialId", "credentialVerifier", "claimVerifier"]);
        if (record.protocolVersion !== 1) throw new PairingRegistryInputError("unsupported protocolVersion");
        const code = approvalCode(entropy(7));
        const issued = options.registry.issue({
          requestId: string(record, "requestId", ID_PATTERN),
          deviceId: string(record, "deviceId", ID_PATTERN),
          deviceName: string(record, "deviceName"),
          credentialId: string(record, "credentialId", ID_PATTERN),
          credentialVerifier: string(record, "credentialVerifier", VERIFIER_PATTERN),
          claimVerifier: string(record, "claimVerifier", VERIFIER_PATTERN),
          approvalCodeVerifier: approvalCodeVerifier(code),
        });
        return sendJson(res, 201, {
          protocolVersion: 1,
          requestId: issued.requestId,
          approvalCode: `${code.slice(0, 5)}-${code.slice(5)}`,
          expiresAt: issued.expiresAt,
        });
      }
      if (req.method === "POST" && url.pathname === "/thunderclaw/pairing/v1/claim") {
        const auth = credential(req);
        await requireEmptyBody(req);
        const device = options.registry.claim(auth.credentialId, auth.credential);
        return sendJson(res, 200, { protocolVersion: 1, device: publicDevice(device) });
      }
      if (req.method === "POST" && url.pathname === "/thunderclaw/pairing/v1/rotate") {
        const auth = credential(req);
        options.registry.authenticate(auth.credentialId, auth.credential, "credential:rotate");
        const record = exactRecord(await readJson(req), ["protocolVersion", "credentialId", "credentialVerifier"]);
        if (record.protocolVersion !== 1) throw new PairingRegistryInputError("unsupported protocolVersion");
        const device = options.registry.rotate(
          auth.credentialId,
          string(record, "credentialId", ID_PATTERN),
          string(record, "credentialVerifier", VERIFIER_PATTERN),
        );
        return sendJson(res, 200, { protocolVersion: 1, device: publicDevice(device) });
      }
      if (req.method === "POST" && url.pathname === "/thunderclaw/pairing/v1/revoke") {
        const auth = credential(req);
        await requireEmptyBody(req);
        options.registry.authenticate(auth.credentialId, auth.credential, "credential:revoke");
        options.registry.revoke(auth.credentialId, "self");
        return sendJson(res, 200, { protocolVersion: 1, revoked: true });
      }
      return sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown pairing route" } });
    } catch (error) {
      return errorResponse(res, error);
    }
  };
}

export function createDeviceAuthenticator(registry: PairingRegistry) {
  return (req: IncomingMessage, capability: DeviceCapability): DeviceRecord => {
    const auth = credential(req);
    return registry.authenticate(auth.credentialId, auth.credential, capability);
  };
}
