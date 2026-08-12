import { DirectClientError } from "./direct-client-contract.js";
import type { CanonicalEndpoint } from "./endpoint-policy.js";

const PAIRING_MAX_RESPONSE_BYTES = 65_536;
const PAIRING_TIMEOUT_MS = 20_000;
const REQUEST_MAX_TTL_MS = 11 * 60_000;
const CREDENTIAL_MAX_TTL_MS = 91 * 24 * 60 * 60_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/u;
const APPROVAL_CODE_PATTERN = /^[A-Z2-7]{5}-[A-Z2-7]{5}$/u;
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/u;
const REQUIRED_CAPABILITIES = Object.freeze([
  "status:read", "agents:read", "agents:probe", "compose:transform", "message:transform",
  "credential:rotate", "credential:revoke",
] as const);

type Fetch = typeof fetch;

export type PairingProspectiveCredential = Readonly<{
  credentialId: string;
  rawCredential: string;
  credentialVerifier: string;
}>;

export type PairingRequestMaterial = Readonly<{
  requestId: string;
  deviceId: string;
  deviceName: string;
  claimCredential: string;
  claimVerifier: string;
  prospective: PairingProspectiveCredential;
}>;

export type PairedDevice = Readonly<{
  credentialId: string;
  deviceId: string;
  deviceName: string;
  capabilities: readonly string[];
  expiresAt: string;
}>;

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", `${label} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", `${label} fields are invalid`);
  }
  return record;
}

function pairingBase(endpoint: CanonicalEndpoint): URL {
  return new URL(`${endpoint.origin}/thunderclaw/pairing/v1/`);
}

async function readLimited(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > PAIRING_MAX_RESPONSE_BYTES)) {
    try { await response.body?.cancel(); } catch { /* The contract failure remains authoritative. */ }
    throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The pairing response is invalid", response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The pairing response is empty", response.status);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, PAIRING_TIMEOUT_MS);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > PAIRING_MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* The size failure remains authoritative. */ }
        throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The pairing response is too large", response.status);
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (timedOut) throw new DirectClientError("timeout", "PAIRING_TIMEOUT", "The pairing response timed out", response.status);
    throw error;
  } finally { clearTimeout(timeout); reader.releaseLock(); }
  if (timedOut) throw new DirectClientError("timeout", "PAIRING_TIMEOUT", "The pairing response timed out", response.status);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The pairing response is invalid", response.status);
  }
}

function backendError(value: unknown, response: Response): DirectClientError {
  try {
    const envelope = exactRecord(value, ["error"], "error response");
    const error = exactRecord(envelope.error, ["code", "message"], "error");
    if (typeof error.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
        || typeof error.message !== "string" || error.message.length === 0 || error.message.length > 1_000
        || /[\u0000-\u001F\u007F]/u.test(error.message)) throw new Error();
    const authentication = response.status === 401 || ["CREDENTIAL_EXPIRED", "CREDENTIAL_REVOKED", "AUTHENTICATION_FAILED"].includes(error.code);
    const kind = authentication ? "authentication" : response.status === 429 ? "rate_limit" : response.status >= 500 ? "backend" : "contract";
    return new DirectClientError(kind, error.code, authentication
      ? "The ThunderClaw device credential was rejected or is no longer active."
      : kind === "rate_limit" ? "Pairing is temporarily rate limited. Try again later."
      : "ThunderClaw could not complete the pairing action.", response.status);
  } catch (error) {
    if (error instanceof DirectClientError && error.code !== "INVALID_PAIRING_RESPONSE") return error;
    return new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The pairing error response is invalid", response.status);
  }
}

export class BrowserPairingClient {
  constructor(private readonly endpoint: CanonicalEndpoint, private readonly fetchImpl: Fetch = fetch, private readonly now = Date.now) {}

  private async call(path: "requests" | "claim" | "rotate" | "revoke", body: unknown, credential?: string): Promise<unknown> {
    const base = pairingBase(this.endpoint);
    const url = new URL(path, base);
    if (url.origin !== this.endpoint.origin || url.pathname !== `/thunderclaw/pairing/v1/${path}` || url.search || url.hash) {
      throw new DirectClientError("configuration", "INVALID_PAIRING_ROUTE", "The pairing route is invalid");
    }
    const headers = new Headers({ accept: "application/json" });
    let encoded: string | undefined;
    if (body !== undefined) {
      encoded = JSON.stringify(body);
      headers.set("content-type", "application/json");
    }
    if (credential !== undefined) {
      if (!/^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})$/u.test(credential)) {
        throw new DirectClientError("authentication", "INVALID_CREDENTIAL", "The device credential is invalid");
      }
      headers.set("authorization", `Bearer ${credential}`);
    }
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAIRING_TIMEOUT_MS);
    try {
      const fetchRequest = this.fetchImpl;
      response = await fetchRequest(url.href, { method: "POST", headers, body: encoded, redirect: "manual", signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new DirectClientError("timeout", "PAIRING_TIMEOUT", "The pairing request timed out");
      throw new DirectClientError("network", "NETWORK_FAILURE", "The OpenClaw Gateway is unavailable");
    } finally { clearTimeout(timeout); }
    if ((response.status >= 300 && response.status <= 399) || response.redirected || response.type === "opaqueredirect" || response.url !== url.href) {
      try { await response.body?.cancel(); } catch { /* Location failure remains authoritative. */ }
      throw new DirectClientError("contract", "REDIRECT_REJECTED", "Pairing rejected an unexpected response location", response.status);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const cacheControl = response.headers.get("cache-control")?.toLowerCase().split(",").map((value) => value.trim()) ?? [];
    if (!contentType.startsWith("application/json") || !cacheControl.includes("no-store")) {
      try { await response.body?.cancel(); } catch { /* Contract failure remains authoritative. */ }
      throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The pairing response content type is invalid", response.status);
    }
    const parsed = await readLimited(response);
    if (!response.ok) throw backendError(parsed, response);
    return parsed;
  }

  async request(material: PairingRequestMaterial): Promise<{ requestId: string; approvalCode: string; expiresAt: string }> {
    const value = await this.call("requests", {
      protocolVersion: 1, requestId: material.requestId, deviceId: material.deviceId, deviceName: material.deviceName,
      credentialId: material.prospective.credentialId, credentialVerifier: material.prospective.credentialVerifier,
      claimVerifier: material.claimVerifier,
    });
    const record = exactRecord(value, ["protocolVersion", "requestId", "approvalCode", "expiresAt"], "pairing response");
    if (record.protocolVersion !== 1 || record.requestId !== material.requestId || typeof record.approvalCode !== "string"
        || !APPROVAL_CODE_PATTERN.test(record.approvalCode) || typeof record.expiresAt !== "string"
        || !canonicalFutureDate(record.expiresAt, this.now(), REQUEST_MAX_TTL_MS)) {
      throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The pairing response is invalid");
    }
    return { requestId: record.requestId as string, approvalCode: record.approvalCode as string, expiresAt: record.expiresAt as string };
  }

  async claim(material: PairingRequestMaterial): Promise<PairedDevice> {
    const value = await this.call("claim", undefined, material.claimCredential);
    return this.device(value, material.prospective.credentialId, material.deviceId, material.deviceName);
  }

  async rotate(currentCredential: string, prospective: PairingProspectiveCredential, expected: Pick<PairingRequestMaterial, "deviceId" | "deviceName">): Promise<PairedDevice> {
    const value = await this.call("rotate", {
      protocolVersion: 1, credentialId: prospective.credentialId, credentialVerifier: prospective.credentialVerifier,
    }, currentCredential);
    return this.device(value, prospective.credentialId, expected.deviceId, expected.deviceName);
  }

  async revoke(credential: string): Promise<void> {
    const value = exactRecord(await this.call("revoke", undefined, credential), ["protocolVersion", "revoked"], "revocation response");
    if (value.protocolVersion !== 1 || value.revoked !== true) {
      throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The revocation response is invalid");
    }
  }

  private device(value: unknown, credentialId: string, deviceId: string, deviceName: string): PairedDevice {
    const envelope = exactRecord(value, ["protocolVersion", "device"], "credential response");
    const device = exactRecord(envelope.device, ["credentialId", "deviceId", "deviceName", "capabilities", "expiresAt"], "paired device");
    const capabilities = Array.isArray(device.capabilities) ? device.capabilities : null;
    if (envelope.protocolVersion !== 1 || device.credentialId !== credentialId || device.deviceId !== deviceId || device.deviceName !== deviceName
        || capabilities === null || capabilities.length !== REQUIRED_CAPABILITIES.length
        || REQUIRED_CAPABILITIES.some((capability, index) => capabilities[index] !== capability)
        || !canonicalFutureDate(device.expiresAt, this.now(), CREDENTIAL_MAX_TTL_MS)) {
      throw new DirectClientError("contract", "INVALID_PAIRING_RESPONSE", "The paired device response is invalid");
    }
    return Object.freeze({ credentialId, deviceId, deviceName, capabilities: Object.freeze([...REQUIRED_CAPABILITIES]), expiresAt: device.expiresAt as string });
  }
}

export async function pairingVerifier(domain: "device" | "claim", credential: string): Promise<string> {
  if (domain === "device" && !/^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})$/u.test(credential)) {
    throw new DirectClientError("authentication", "INVALID_CREDENTIAL", "The prospective device credential is invalid");
  }
  if (domain === "claim" && !/^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})$/u.test(credential)) {
    throw new DirectClientError("authentication", "INVALID_CREDENTIAL", "The claim credential is invalid");
  }
  const prefix = domain === "device" ? "thunderclaw-device-credential-v1" : "thunderclaw-pairing-claim-v1";
  const input = new TextEncoder().encode(`${prefix}\0${credential}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomPairingValue(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function validVerifier(value: unknown): value is string { return typeof value === "string" && VERIFIER_PATTERN.test(value); }

function canonicalFutureDate(value: unknown, now: number, maximumTtl: number): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value && parsed > now && parsed <= now + maximumTtl;
}
