import {
  DirectClientError,
  nextConnectionEpoch,
  sameConnectionBinding,
  type AgentRecord,
  type ClientAuthentication,
  type ConnectionBinding,
  type ThunderClawDirectClient,
} from "./direct-client-contract.js";
import { BrowserThunderClawDirectClient } from "./direct-client.js";
import { canonicalizeApiBase, type CanonicalEndpoint } from "./endpoint-policy.js";
import { randomId } from "./random-id.js";
import {
  BrowserPairingClient,
  pairingVerifier,
  randomPairingValue,
  validVerifier,
  type PairingProspectiveCredential,
  type PairingRequestMaterial,
} from "./pairing-client.js";

declare const browser: any;

export const OPTIONS_PORT_NAME = "thunderclaw-options-v1";
const SETTINGS_KEY = "thunderclaw.connectionSettings.v1";
const LEGACY_DEVELOPMENT_CREDENTIAL_KEY = "thunderclaw.developmentNarrowCredential.v1";
const DEVICE_IDENTITY_KEY = "thunderclaw.deviceIdentity.v1";
const DEVICE_CREDENTIAL_KEY = "thunderclaw.deviceCredential.v1";
const PENDING_PAIRING_KEY = "thunderclaw.pendingPairing.v1";
const PENDING_ROTATION_KEY = "thunderclaw.pendingRotation.v1";
const REMOTE_RECOVERY_KEY = "thunderclaw.remoteCredentialRecovery.v1";
const CREDENTIAL_LIFECYCLE_KEY = "thunderclaw.credentialLifecycle.v1";
const EPOCH_KEY = "thunderclaw.connectionEpoch.v1";
const PENDING_PERMISSION_CLEANUP_KEY = "thunderclaw.pendingPermissionCleanup.v1";
const FEATURE_RETIREMENT_KEY = "thunderclaw.featureRetirement.v1";
const PERMISSION_CLEANUP_TIMEOUT_MS = 10_000;

type StoredSettings = {
  version: 1;
  apiBase: string;
  origin: string;
  permissionPattern: string;
  credentialId: string | null;
  connected: boolean;
  epoch: number;
};

type DeviceIdentity = {
  version: 1;
  deviceId: string;
  deviceName: string;
};

type StoredCredential = {
  version: 1;
  mode: "device_credential";
  apiBase: string;
  origin: string;
  credentialId: string;
  deviceId: string;
  deviceName: string;
  rawCredential: string;
  expiresAt: string;
};

type PendingPairing = PairingRequestMaterial & {
  version: 1;
  apiBase: string;
  origin: string;
  permissionPattern: string;
  approvalCode: string | null;
  expiresAt: string | null;
  claimAmbiguous: boolean;
};

type PendingRotation = {
  version: 1;
  apiBase: string;
  origin: string;
  permissionPattern: string;
  current: StoredCredential;
  prospective: PairingProspectiveCredential;
  startedAt: string;
};

type RemoteRecovery = {
  version: 1;
  possiblyActive: true;
  reason: string;
  apiBase: string;
  origin: string;
  permissionPattern: string;
  candidates: Array<{ credentialId: string; rawCredential: string }>;
};

type PublicState = {
  phase: "not_configured" | "disconnected" | "awaiting_approval" | "pairing_expired" | "rotation_ambiguous" | "disconnect_ambiguous" | "credential_expired" | "credential_revoked" | "authorized_untested" | "ready";
  configured: boolean;
  apiBase: string | null;
  origin: string | null;
  permissionPattern: string | null;
  permissionGranted: boolean;
  connected: boolean;
  cleanupRequired?: true;
  approvalCode?: string;
  pairingExpiresAt?: string;
  credentialExpiresAt?: string;
  remoteCredentialPossiblyActive?: true;
  forgetRemoteRevocation?: "confirmed" | "unconfirmed";
  epoch: number;
};

type OptionsOwner = object;

type ActiveAgentVerification = {
  agentId: string;
  probeRunId: string;
  binding: ConnectionBinding | null;
  client: ThunderClawDirectClient | null;
  abort: AbortController;
  owner: OptionsOwner;
  agentConfiguration: string | null;
  serverStarted: boolean;
  cancelling: boolean;
  probeSettled: boolean;
};

export type BackgroundFeatureLease = Readonly<{
  client: ThunderClawDirectClient;
  binding: ConnectionBinding;
}>;

export type FeatureRetirementHandler = (lease: BackgroundFeatureLease) => void | Promise<void>;

function ownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function pairingIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,64}$/u.test(value);
}

function validPermissionPattern(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2_048
    && /^(?:https|http):\/\/[^\s/?#]+\/\*$/u.test(value);
}

function readSettings(value: unknown): StoredSettings | null {
  const record = ownRecord(value);
  if (!record || record.version !== 1 || typeof record.apiBase !== "string" || typeof record.origin !== "string"
      || typeof record.permissionPattern !== "string" || typeof record.connected !== "boolean"
      || !Number.isSafeInteger(record.epoch) || (record.epoch as number) < 0
      || (record.credentialId !== null && !validIdentifier(record.credentialId))) return null;
  try {
    const endpoint = canonicalizeApiBase(record.apiBase);
    if (endpoint.origin !== record.origin || endpoint.permissionPattern !== record.permissionPattern) return null;
  } catch {
    return null;
  }
  return record as StoredSettings;
}

function readCredential(value: unknown, settings: StoredSettings): StoredCredential | null {
  const record = ownRecord(value);
  if (!record || !exactKeys(record, ["version", "mode", "apiBase", "origin", "credentialId", "deviceId", "deviceName", "rawCredential", "expiresAt"])
      || record.version !== 1 || record.mode !== "device_credential"
      || record.apiBase !== settings.apiBase || record.origin !== settings.origin
      || !pairingIdentifier(record.credentialId) || record.credentialId !== settings.credentialId
      || !pairingIdentifier(record.deviceId) || typeof record.deviceName !== "string" || record.deviceName.length === 0 || record.deviceName.length > 120
      || /[\u0000-\u001F\u007F]/u.test(record.deviceName)
      || typeof record.rawCredential !== "string" || !/^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})$/u.test(record.rawCredential)
      || !record.rawCredential.startsWith(`${record.credentialId}.`) || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))) return null;
  return record as StoredCredential;
}

function readIdentity(value: unknown): DeviceIdentity | null {
  const record = ownRecord(value);
  return record && exactKeys(record, ["version", "deviceId", "deviceName"])
    && record.version === 1 && pairingIdentifier(record.deviceId) && typeof record.deviceName === "string"
    && record.deviceName.length > 0 && record.deviceName.length <= 120 && !/[\u0000-\u001F\u007F]/u.test(record.deviceName)
    ? record as DeviceIdentity : null;
}

function readPendingPairing(value: unknown): PendingPairing | null {
  const record = ownRecord(value);
  if (!record || !exactKeys(record, ["version", "apiBase", "origin", "permissionPattern", "requestId", "deviceId", "deviceName",
    "claimCredential", "claimVerifier", "prospective", "approvalCode", "expiresAt", "claimAmbiguous"])
      || record.version !== 1 || typeof record.apiBase !== "string" || typeof record.origin !== "string"
      || typeof record.permissionPattern !== "string" || !pairingIdentifier(record.requestId) || !pairingIdentifier(record.deviceId)
      || typeof record.deviceName !== "string" || typeof record.claimCredential !== "string" || !validVerifier(record.claimVerifier)
      || typeof record.prospective !== "object" || record.prospective === null) return null;
  const prospective = record.prospective as Record<string, unknown>;
  if (!exactKeys(prospective, ["credentialId", "rawCredential", "credentialVerifier"])
      || !pairingIdentifier(prospective.credentialId) || typeof prospective.rawCredential !== "string" || !validVerifier(prospective.credentialVerifier)
      || !prospective.rawCredential.startsWith(`${prospective.credentialId}.`)
      || (record.approvalCode !== null && (typeof record.approvalCode !== "string" || !/^[A-Z2-7]{5}-[A-Z2-7]{5}$/u.test(record.approvalCode)))
      || (record.expiresAt !== null && (typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))))
      || typeof record.claimAmbiguous !== "boolean") return null;
  try {
    const endpoint = canonicalizeApiBase(record.apiBase);
    if (endpoint.origin !== record.origin || endpoint.permissionPattern !== record.permissionPattern) return null;
  } catch { return null; }
  return record as unknown as PendingPairing;
}

function readPendingRotation(value: unknown): PendingRotation | null {
  const record = ownRecord(value);
  if (!record || !exactKeys(record, ["version", "apiBase", "origin", "permissionPattern", "current", "prospective", "startedAt"])
      || record.version !== 1 || typeof record.apiBase !== "string" || typeof record.origin !== "string"
      || typeof record.permissionPattern !== "string" || typeof record.current !== "object" || record.current === null
      || typeof record.prospective !== "object" || record.prospective === null || typeof record.startedAt !== "string") return null;
  const current = record.current as Record<string, unknown>;
  const prospective = record.prospective as Record<string, unknown>;
  const fakeSettings: StoredSettings = { version: 1, apiBase: record.apiBase, origin: record.origin,
    permissionPattern: record.permissionPattern, credentialId: typeof current.credentialId === "string" ? current.credentialId : null, connected: true, epoch: 0 };
  if (!readCredential(current, fakeSettings) || !exactKeys(prospective, ["credentialId", "rawCredential", "credentialVerifier"])
      || !pairingIdentifier(prospective.credentialId)
      || typeof prospective.rawCredential !== "string" || !prospective.rawCredential.startsWith(`${prospective.credentialId}.`)
      || !validVerifier(prospective.credentialVerifier)) return null;
  return record as unknown as PendingRotation;
}

function readRemoteRecovery(value: unknown): RemoteRecovery | null {
  const record = ownRecord(value);
  if (!record || !exactKeys(record, ["version", "possiblyActive", "reason", "apiBase", "origin", "permissionPattern", "candidates"])
      || record.version !== 1 || record.possiblyActive !== true || typeof record.reason !== "string"
      || record.reason.length === 0 || record.reason.length > 120 || /[\u0000-\u001F\u007F]/u.test(record.reason)
      || typeof record.apiBase !== "string" || typeof record.origin !== "string" || typeof record.permissionPattern !== "string"
      || !Array.isArray(record.candidates) || record.candidates.length < 1 || record.candidates.length > 2) return null;
  try {
    const endpoint = canonicalizeApiBase(record.apiBase);
    if (endpoint.origin !== record.origin || endpoint.permissionPattern !== record.permissionPattern) return null;
  } catch { return null; }
  for (const value of record.candidates) {
    const candidate = ownRecord(value);
    if (!candidate || !exactKeys(candidate, ["credentialId", "rawCredential"]) || !pairingIdentifier(candidate.credentialId)
        || typeof candidate.rawCredential !== "string" || !candidate.rawCredential.startsWith(`${candidate.credentialId}.`)
        || !/^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})$/u.test(candidate.rawCredential)) return null;
  }
  return record as unknown as RemoteRecovery;
}

function recoveryRecord(reason: string, apiBase: string, origin: string, permissionPattern: string,
  rawCredentials: readonly string[]): RemoteRecovery {
  const candidates = [...new Set(rawCredentials)].map((rawCredential) => ({ credentialId: rawCredential.split(".")[0]!, rawCredential }));
  return { version: 1, possiblyActive: true, reason, apiBase, origin, permissionPattern, candidates };
}

function publicError(error: unknown): { kind: string; message: string } {
  const kind = error instanceof DirectClientError ? error.kind : "backend";
  if (error instanceof DirectClientError && error.code === "PERMISSION_REMOVAL_FAILED") {
    return { kind: "permission", message: "The device credential was retired, but Thunderbird still reports the hostname permission. Retry removal or revoke it in Add-ons Manager." };
  }
  if (error instanceof DirectClientError && error.code === "PERMISSION_CLEANUP_REQUIRED") {
    return { kind: "permission", message: "A previous hostname permission still needs cleanup. Retry Disconnect or revoke it in Add-ons Manager before authorizing." };
  }
  const messages: Record<string, string> = {
    configuration: "The ThunderClaw connection settings are invalid.",
    permission: "Thunderbird no longer grants access to the configured OpenClaw host.",
    authentication: "The ThunderClaw device credential was rejected, expired, revoked, or is unavailable.",
    capability: "The configured OpenClaw service does not support this operation.",
    network: "The configured OpenClaw service could not be reached.",
    timeout: "The OpenClaw connection timed out.",
    cancellation: "The connection check was cancelled.",
    rate_limit: "The OpenClaw service is temporarily rate limited.",
    contract: "The OpenClaw service returned an incompatible response.",
    backend: "The OpenClaw service could not complete the request.",
  };
  return { kind, message: messages[kind] ?? messages.backend };
}

type AuthorizationCleanupResult = "complete" | "background_pending";

function markAuthorizationCleanup(error: unknown, result: AuthorizationCleanupResult): Error & { permissionCleanup: AuthorizationCleanupResult } {
  const marked = error instanceof Error
    ? error
    : new DirectClientError("backend", "AUTHORIZATION_FAILED", "Authorization failed.");
  Object.defineProperty(marked, "permissionCleanup", { configurable: false, enumerable: false, value: result });
  return marked as Error & { permissionCleanup: AuthorizationCleanupResult };
}

function plain(value: string | null, maximum = 256): string | null {
  if (value === null) return null;
  return value.length <= maximum && !/[\u0000-\u001F\u007F]/u.test(value) ? value : null;
}

const COMPATIBILITY_REASON_COPY: Record<AgentRecord["compatibility"]["state"], string> = {
  unverified: "This agent has not been verified for the current configuration.",
  partially_verified: "Primary checks passed, but configured fallback evidence is incomplete.",
  verified: "This agent passed the ThunderClaw compatibility checks.",
  incompatible: "This agent did not pass the ThunderClaw compatibility checks.",
  unsupported: "This agent configuration is not supported by ThunderClaw.",
};

function sanitizeAgent(agent: AgentRecord): Record<string, unknown> {
  return {
    agentId: plain(agent.agentId),
    displayName: plain(agent.displayName),
    isDefault: agent.isDefault,
    provider: plain(agent.provider),
    model: plain(agent.model),
    compatibility: {
      state: agent.compatibility.state,
      executionMode: agent.compatibility.executionMode,
      usesPersonality: agent.compatibility.usesPersonality,
      usesMemory: agent.compatibility.usesMemory,
      toolsDisabled: agent.compatibility.toolsDisabled,
      checks: { ...agent.compatibility.checks },
      lastProbe: agent.compatibility.lastProbe === null ? null : {
        testedAt: agent.compatibility.lastProbe.testedAt,
        observedProvider: plain(agent.compatibility.lastProbe.observedProvider),
        observedModel: plain(agent.compatibility.lastProbe.observedModel),
      },
      reason: COMPATIBILITY_REASON_COPY[agent.compatibility.state],
    },
  };
}

function agentConfiguration(agent: AgentRecord): string {
  return JSON.stringify({
    agentId: agent.agentId,
    provider: agent.provider,
    model: agent.model,
    reasoning: agent.reasoning,
  });
}

export class ConnectionController {
  private settings: StoredSettings | null = null;
  private pendingPairing: PendingPairing | null = null;
  private pendingRotation: PendingRotation | null = null;
  private remoteCredentialPossiblyActive = false;
  private remoteRecovery: RemoteRecovery | null = null;
  private credentialExpiresAt: string | null = null;
  private credentialLifecycle: "expired" | "revoked" | null = null;
  private permissionGranted = false;
  private currentEpoch = 0;
  private diagnosticAbort: AbortController | null = null;
  private readonly agentVerifications = new Map<string, ActiveAgentVerification>();
  private readyEpoch: number | null = null;
  private pendingAuthorizationEpoch: number | null = null;
  private operationGeneration = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private credentialMutation: Promise<void> | null = null;
  private activeAuthorizationPermissions = new Map<number, string>();
  private pendingPermissionCleanup = new Set<string>();
  private unclaimedPermissionCandidates = new Set<string>();
  private candidateTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initialized: Promise<void>;
  private featureLease: BackgroundFeatureLease | null = null;
  private featureRetiring = false;
  private featureFenceGeneration = 0;
  private readonly featureRetirementFences = new Set<number>();
  private readonly featureRetirementHandlers = new Set<FeatureRetirementHandler>();

  constructor() {
    this.initialized = this.load();
    browser.permissions.onRemoved.addListener((removed: { origins?: unknown }) => {
      void this.permissionRemoved(removed);
    });
    browser.permissions.onAdded?.addListener((added: { origins?: unknown }) => {
      void this.permissionAdded(added);
    });
  }

  private claimOperation(): number {
    this.operationGeneration += 1;
    return this.operationGeneration;
  }

  private assertCurrent(operation: number): void {
    if (operation !== this.operationGeneration) {
      throw new DirectClientError("contract", "STALE_CONNECTION", "A newer connection action replaced this action.");
    }
  }

  private beginFeatureRetirement(): number {
    this.featureFenceGeneration += 1;
    const fence = this.featureFenceGeneration;
    this.featureRetirementFences.add(fence);
    return fence;
  }

  private endFeatureRetirement(fence: number): void {
    this.featureRetirementFences.delete(fence);
  }

  private rejectDuringFeatureRetirement(): void {
    if (this.featureRetirementFences.size > 0 || this.featureRetiring) {
      throw new DirectClientError("cancellation", "CONNECTION_RETIRING", "The previous ThunderClaw connection is retiring.");
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async exclusiveCredentialMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.credentialMutation) throw new DirectClientError("cancellation", "CREDENTIAL_ACTION_ACTIVE", "Another credential action is still in progress.");
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.credentialMutation = active;
    try { return await operation(); }
    finally {
      release();
      if (this.credentialMutation === active) this.credentialMutation = null;
    }
  }

  private async waitForCredentialMutation(): Promise<void> {
    await this.credentialMutation;
  }

  private async boundedPermission<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new DirectClientError("permission", "PERMISSION_CLEANUP_TIMEOUT", "Permission cleanup timed out.")), PERMISSION_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private async removeAndVerifyPermission(permissionPattern: string): Promise<void> {
    try {
      await this.boundedPermission(browser.permissions.remove({ origins: [permissionPattern] }));
    } catch { /* The verified postcondition below is authoritative. */ }
    let remains: boolean;
    try {
      remains = await this.boundedPermission(browser.permissions.contains({ origins: [permissionPattern] }));
    } catch {
      throw new DirectClientError("permission", "PERMISSION_REMOVAL_FAILED", "Thunderbird host permission could not be removed.");
    }
    if (remains) throw new DirectClientError("permission", "PERMISSION_REMOVAL_FAILED", "Thunderbird host permission could not be removed.");
  }

  private async persistPendingCleanup(): Promise<void> {
    const patterns = [...this.pendingPermissionCleanup].sort();
    if (patterns.length === 0) await browser.storage.local.remove(PENDING_PERMISSION_CLEANUP_KEY);
    else await browser.storage.local.set({ [PENDING_PERMISSION_CLEANUP_KEY]: patterns });
  }

  private durablyOwnsPermission(permissionPattern: string): boolean {
    return this.settings?.permissionPattern === permissionPattern
      && this.settings.connected && this.settings.credentialId !== null
      && this.pendingAuthorizationEpoch !== this.settings.epoch
      || this.pendingPairing?.permissionPattern === permissionPattern
      || this.pendingRotation?.permissionPattern === permissionPattern
      || this.remoteRecovery?.permissionPattern === permissionPattern;
  }

  private activeAuthorizationOwnsPermission(permissionPattern: string): boolean {
    return [...this.activeAuthorizationPermissions.values()].includes(permissionPattern);
  }

  private async cleanupUnownedPermission(permissionPattern: string): Promise<boolean> {
    if (this.durablyOwnsPermission(permissionPattern)) {
      this.pendingPermissionCleanup.delete(permissionPattern);
      await this.persistPendingCleanup();
      return true;
    }
    if (this.activeAuthorizationOwnsPermission(permissionPattern)) {
      this.pendingPermissionCleanup.add(permissionPattern);
      await this.persistPendingCleanup();
      return false;
    }
    try {
      await this.removeAndVerifyPermission(permissionPattern);
      if (this.settings?.permissionPattern === permissionPattern && !this.settings.connected) this.permissionGranted = false;
      this.pendingPermissionCleanup.delete(permissionPattern);
      await this.persistPendingCleanup();
      return true;
    } catch {
      this.pendingPermissionCleanup.add(permissionPattern);
      await this.persistPendingCleanup();
      return false;
    }
  }

  private async load(): Promise<void> {
    const stored = await browser.storage.local.get([
      SETTINGS_KEY, DEVICE_IDENTITY_KEY, DEVICE_CREDENTIAL_KEY, PENDING_PAIRING_KEY, PENDING_ROTATION_KEY,
      REMOTE_RECOVERY_KEY, CREDENTIAL_LIFECYCLE_KEY, LEGACY_DEVELOPMENT_CREDENTIAL_KEY, EPOCH_KEY, PENDING_PERMISSION_CLEANUP_KEY, FEATURE_RETIREMENT_KEY,
    ]);
    // The retired manual-token credential is unconditionally removed during
    // migration and is never read or converted into a device credential.
    await browser.storage.local.remove(LEGACY_DEVELOPMENT_CREDENTIAL_KEY);
    const pending = stored[PENDING_PERMISSION_CLEANUP_KEY];
    if (Array.isArray(pending)) {
      for (const pattern of pending) if (validPermissionPattern(pattern)) this.pendingPermissionCleanup.add(pattern);
    }
    const settings = readSettings(stored[SETTINGS_KEY]);
    const storedEpoch = stored[EPOCH_KEY];
    this.currentEpoch = Number.isSafeInteger(storedEpoch) && storedEpoch >= 0 ? storedEpoch : 0;
    this.pendingPairing = readPendingPairing(stored[PENDING_PAIRING_KEY]);
    this.pendingRotation = readPendingRotation(stored[PENDING_ROTATION_KEY]);
    this.remoteRecovery = readRemoteRecovery(stored[REMOTE_RECOVERY_KEY]);
    this.remoteCredentialPossiblyActive = this.remoteRecovery !== null;
    if (!this.remoteRecovery) await browser.storage.local.remove(REMOTE_RECOVERY_KEY);
    const lifecycle = ownRecord(stored[CREDENTIAL_LIFECYCLE_KEY]);
    this.credentialLifecycle = lifecycle && exactKeys(lifecycle, ["version", "status"])
      && lifecycle.version === 1 && (lifecycle.status === "expired" || lifecycle.status === "revoked") ? lifecycle.status : null;
    if (!this.credentialLifecycle) await browser.storage.local.remove(CREDENTIAL_LIFECYCLE_KEY);
    if (!this.pendingPairing) await browser.storage.local.remove(PENDING_PAIRING_KEY);
    if (!this.pendingRotation) await browser.storage.local.remove(PENDING_ROTATION_KEY);
    if (this.pendingRotation) this.remoteCredentialPossiblyActive = true;
    if (!settings) {
      this.credentialLifecycle = null;
      await browser.storage.local.remove(CREDENTIAL_LIFECYCLE_KEY);
      await browser.storage.local.remove([SETTINGS_KEY, DEVICE_CREDENTIAL_KEY]);
      if (this.pendingPairing) this.permissionGranted = await browser.permissions.contains({ origins: [this.pendingPairing.permissionPattern] });
      await this.reconcileStartupPermissions();
      return;
    }
    this.currentEpoch = Math.max(this.currentEpoch, settings.epoch);
    await browser.storage.local.set({ [EPOCH_KEY]: this.currentEpoch });
    this.settings = settings;
    this.permissionGranted = await browser.permissions.contains({ origins: [settings.permissionPattern] });
    const retirement = ownRecord(stored[FEATURE_RETIREMENT_KEY]);
    if (retirement?.version === 1 && retirement.epoch === settings.epoch) {
      const next = { ...settings, credentialId: null, connected: false, epoch: nextConnectionEpoch(this.currentEpoch) } satisfies StoredSettings;
      this.currentEpoch = next.epoch;
      this.settings = next;
      this.permissionGranted = false;
      await browser.storage.local.set({ [SETTINGS_KEY]: next, [EPOCH_KEY]: next.epoch });
      await this.preserveRemoteCredential(stored[DEVICE_CREDENTIAL_KEY], settings, "interrupted retirement");
      await browser.storage.local.remove([DEVICE_CREDENTIAL_KEY, FEATURE_RETIREMENT_KEY]);
      await this.reconcileStartupPermissions();
      return;
    }
    await browser.storage.local.remove(FEATURE_RETIREMENT_KEY);
    const credential = readCredential(stored[DEVICE_CREDENTIAL_KEY], settings);
    this.credentialExpiresAt = credential?.expiresAt ?? null;
    if (credential && this.pendingPairing?.prospective.credentialId === credential.credentialId
        && this.pendingPairing.prospective.rawCredential === credential.rawCredential) {
      // Recover the only non-atomic edge: active credential write succeeded
      // but deletion of the consumed one-time claim record did not.
      this.pendingPairing = null;
      this.remoteRecovery = null;
      this.remoteCredentialPossiblyActive = false;
      await browser.storage.local.remove([PENDING_PAIRING_KEY, REMOTE_RECOVERY_KEY]);
    }
    if (credential && this.pendingRotation?.apiBase === credential.apiBase
        && this.pendingRotation.origin === credential.origin
        && this.pendingRotation.permissionPattern === settings.permissionPattern
        && this.pendingRotation.prospective.credentialId === credential.credentialId
        && this.pendingRotation.prospective.rawCredential === credential.rawCredential
        && this.pendingRotation.current.deviceId === credential.deviceId
        && this.pendingRotation.current.deviceName === credential.deviceName) {
      // Recover a crash after the replacement binding write but before
      // removal of the dual-custody rotation journal.
      this.pendingRotation = null;
      this.remoteRecovery = null;
      this.remoteCredentialPossiblyActive = false;
      await browser.storage.local.remove([PENDING_ROTATION_KEY, REMOTE_RECOVERY_KEY]);
    }
    if (settings.connected && (!this.permissionGranted || !credential)) {
      if (credential) await this.preserveRemoteCredential(credential, settings, "permission or startup custody loss");
      await this.invalidate(false, false);
    } else if (!settings.connected) await browser.storage.local.remove(DEVICE_CREDENTIAL_KEY);
    await this.reconcileStartupPermissions();
  }

  private async reconcileStartupPermissions(): Promise<void> {
    try {
      if (typeof browser.permissions.getAll === "function") {
        const all = await this.boundedPermission(browser.permissions.getAll());
        const origins = ownRecord(all)?.origins;
        if (Array.isArray(origins)) {
          for (const pattern of origins) {
            if (!validPermissionPattern(pattern) || this.durablyOwnsPermission(pattern)) continue;
            this.pendingPermissionCleanup.add(pattern);
            // The options page can complete a user-approved permission request
            // while startup hydration is still enumerating optional origins.
            // Preserve that exact active candidate so authorizeOperation can
            // claim it instead of misclassifying it as a startup orphan.
            if ([...this.activeAuthorizationPermissions.values()].includes(pattern)) {
              this.unclaimedPermissionCandidates.add(pattern);
            }
          }
        }
      }
    } catch {
      // Persisted cleanup handles remain available for retry if enumeration fails.
    }
    for (const pattern of [...this.pendingPermissionCleanup]) await this.cleanupUnownedPermission(pattern);
  }

  private state(): PublicState {
    const authorized = this.settings?.connected === true && this.settings.credentialId !== null && this.permissionGranted
      && !this.remoteCredentialPossiblyActive && !this.pendingRotation
      && this.pendingAuthorizationEpoch !== this.settings.epoch;
    const pendingExpired = this.pendingPairing?.expiresAt !== null && this.pendingPairing !== null
      && Date.parse(this.pendingPairing.expiresAt) <= Date.now();
    const phase: PublicState["phase"] = this.pendingRotation
      ? "rotation_ambiguous"
      : this.remoteCredentialPossiblyActive && !this.pendingPairing
        ? "disconnect_ambiguous"
      : this.pendingPairing
        ? pendingExpired ? "pairing_expired" : "awaiting_approval"
      : this.credentialLifecycle === "revoked"
        ? "credential_revoked"
      : this.credentialLifecycle === "expired"
        ? "credential_expired"
      : !this.settings
      ? "not_configured"
      : !authorized
        ? "disconnected"
        : this.credentialExpired()
          ? "credential_expired"
        : this.readyEpoch === this.settings.epoch
          ? "ready"
          : "authorized_untested";
    const pendingOwnsPermission = Boolean(this.pendingPairing || this.pendingRotation || this.remoteCredentialPossiblyActive);
    const cleanupRequired = this.pendingPermissionCleanup.size > 0 || (!authorized && this.permissionGranted && !pendingOwnsPermission);
    return {
      phase,
      configured: this.settings !== null || this.pendingPairing !== null || this.pendingRotation !== null || this.remoteCredentialPossiblyActive,
      apiBase: this.pendingPairing?.apiBase ?? this.pendingRotation?.apiBase ?? this.remoteRecovery?.apiBase ?? this.settings?.apiBase ?? null,
      origin: this.pendingPairing?.origin ?? this.pendingRotation?.origin ?? this.remoteRecovery?.origin ?? this.settings?.origin ?? null,
      permissionPattern: this.pendingPairing?.permissionPattern ?? this.pendingRotation?.permissionPattern ?? this.remoteRecovery?.permissionPattern ?? this.settings?.permissionPattern ?? null,
      permissionGranted: this.permissionGranted,
      connected: phase === "ready",
      ...(this.pendingPairing?.approvalCode && !pendingExpired ? {
        approvalCode: this.pendingPairing.approvalCode,
        pairingExpiresAt: this.pendingPairing.expiresAt!,
      } : {}),
      ...(this.currentCredentialExpiry() ? { credentialExpiresAt: this.currentCredentialExpiry()! } : {}),
      ...(this.remoteCredentialPossiblyActive || this.pendingRotation ? { remoteCredentialPossiblyActive: true as const } : {}),
      ...(cleanupRequired ? { cleanupRequired: true as const } : {}),
      epoch: this.currentEpoch,
    };
  }

  private async preserveRemoteCredential(value: unknown, settings: StoredSettings, reason: string): Promise<void> {
    const credential = readCredential(value, settings);
    if (!credential) return;
    const recovery = recoveryRecord(reason, credential.apiBase, credential.origin, settings.permissionPattern, [credential.rawCredential]);
    await browser.storage.local.set({ [REMOTE_RECOVERY_KEY]: recovery });
    this.remoteRecovery = recovery;
    this.remoteCredentialPossiblyActive = true;
  }

  private currentCredentialExpiry(): string | null {
    return this.settings?.credentialId ? this.credentialExpiresAt : null;
  }

  private credentialExpired(): boolean {
    // Bound client rechecks the durable expiry before every feature lease. The
    // public state is updated by that same background-only read.
    return this.credentialExpiresAt !== null && Date.parse(this.credentialExpiresAt) <= Date.now();
  }

  private async invalidate(preservePermission: boolean, preserveRemote = true): Promise<void> {
    this.diagnosticAbort?.abort();
    this.diagnosticAbort = null;
    for (const verification of this.agentVerifications.values()) verification.abort.abort();
    this.agentVerifications.clear();
    this.readyEpoch = null;
    this.pendingAuthorizationEpoch = null;
    const retiring = this.featureLease;
    this.featureLease = null;
    this.featureRetiring = true;
    try {
      if (this.settings) await browser.storage.local.set({ [FEATURE_RETIREMENT_KEY]: { version: 1, epoch: this.settings.epoch } });
      if (retiring) {
        const cleanups = [...this.featureRetirementHandlers].map((handler) => {
          try { return Promise.resolve(handler(retiring)); }
          catch (error) { return Promise.reject(error); }
        });
        if (cleanups.length) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.allSettled(cleanups),
              new Promise<void>((resolve) => { timeout = setTimeout(resolve, PERMISSION_CLEANUP_TIMEOUT_MS); }),
            ]);
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
          }
        }
      }
      if (!this.settings) {
        await browser.storage.local.remove([DEVICE_CREDENTIAL_KEY, FEATURE_RETIREMENT_KEY]);
        return;
      }
      if (preserveRemote) {
        const stored = await browser.storage.local.get(DEVICE_CREDENTIAL_KEY);
        await this.preserveRemoteCredential(stored[DEVICE_CREDENTIAL_KEY], this.settings, "local connection invalidation");
      }
      const next: StoredSettings = {
        ...this.settings,
        credentialId: null,
        connected: false,
        epoch: nextConnectionEpoch(this.currentEpoch),
      };
      this.currentEpoch = next.epoch;
      this.settings = next;
      this.credentialExpiresAt = null;
      if (!preservePermission) this.permissionGranted = false;
      await browser.storage.local.set({ [SETTINGS_KEY]: next, [EPOCH_KEY]: this.currentEpoch });
      await browser.storage.local.remove([DEVICE_CREDENTIAL_KEY, FEATURE_RETIREMENT_KEY]);
    } finally {
      this.featureRetiring = false;
    }
  }

  private permissionRemoved(removed: { origins?: unknown }): Promise<void> {
    const origins = removed.origins;
    if (!Array.isArray(origins)) return Promise.resolve();
    const immediatelyRelevant = Boolean(this.settings && origins.includes(this.settings.permissionPattern)
      && (this.permissionGranted || this.settings.connected));
    let operation = immediatelyRelevant ? this.claimOperation() : null;
    let fence = immediatelyRelevant ? this.beginFeatureRetirement() : null;
    return (async () => {
      try {
        await this.initialized;
        await this.waitForCredentialMutation();
        let pendingChanged = false;
        for (const origin of origins) {
          if (typeof origin === "string" && this.pendingPermissionCleanup.delete(origin)) pendingChanged = true;
          const timer = typeof origin === "string" ? this.candidateTimers.get(origin) : undefined;
          if (timer !== undefined) { clearTimeout(timer); this.candidateTimers.delete(origin); }
        }
        if (pendingChanged) await this.persistPendingCleanup();
        if (!this.settings || !origins.includes(this.settings.permissionPattern)) return;
        if (!this.permissionGranted && !this.settings.connected) return;
        operation ??= this.claimOperation();
        fence ??= this.beginFeatureRetirement();
        const currentOperation = operation;
        await this.mutate(async () => {
          this.assertCurrent(currentOperation);
          if (!this.settings || !origins.includes(this.settings.permissionPattern)) return;
          await this.invalidate(false);
        });
      } finally {
        if (fence !== null) this.endFeatureRetirement(fence);
      }
    })();
  }

  private async permissionAdded(added: { origins?: unknown }): Promise<void> {
    await this.initialized;
    const origins = added.origins;
    if (!Array.isArray(origins)) return;
    await this.mutate(async () => {
      for (const origin of origins) {
        if (!validPermissionPattern(origin) || this.durablyOwnsPermission(origin)) continue;
        this.unclaimedPermissionCandidates.add(origin);
        this.pendingPermissionCleanup.add(origin);
        if (!this.candidateTimers.has(origin)) {
          const timer = setTimeout(() => {
            this.candidateTimers.delete(origin);
            void this.mutate(async () => { await this.cleanupUnownedPermission(origin); });
          }, 2_000);
          this.candidateTimers.set(origin, timer);
        }
      }
      await this.persistPendingCleanup();
    });
  }

  async getState(): Promise<PublicState> {
    await this.initialized;
    await this.waitForCredentialMutation();
    if (this.settings) {
      const granted = await browser.permissions.contains({ origins: [this.settings.permissionPattern] });
      if (!granted && this.permissionGranted) {
        const operation = this.claimOperation();
        const fence = this.beginFeatureRetirement();
        try {
          await this.mutate(async () => {
            this.assertCurrent(operation);
            if (this.settings && !(await browser.permissions.contains({ origins: [this.settings.permissionPattern] }))) await this.invalidate(false);
          });
        } finally { this.endFeatureRetirement(fence); }
      }
      else this.permissionGranted = granted;
    }
    return this.state();
  }

  private async ensureIdentity(): Promise<DeviceIdentity> {
    const stored = await browser.storage.local.get(DEVICE_IDENTITY_KEY);
    const existing = readIdentity(stored[DEVICE_IDENTITY_KEY]);
    if (existing) return existing;
    let platform = "device";
    try {
      const info = await browser.runtime.getPlatformInfo?.();
      if (typeof info?.os === "string" && /^[a-z0-9_-]{1,20}$/iu.test(info.os)) platform = info.os;
    } catch { /* A generic non-secret device label is sufficient. */ }
    const identity: DeviceIdentity = { version: 1, deviceId: randomPairingValue(24), deviceName: `Thunderbird on ${platform}` };
    await browser.storage.local.set({ [DEVICE_IDENTITY_KEY]: identity });
    return identity;
  }

  private async prospectiveCredential(): Promise<PairingProspectiveCredential> {
    const credentialId = randomPairingValue(24);
    const rawCredential = `${credentialId}.${randomPairingValue(32)}`;
    return { credentialId, rawCredential, credentialVerifier: await pairingVerifier("device", rawCredential) };
  }

  async beginPair(apiBaseInput: unknown, consentAccepted: unknown): Promise<PublicState> {
    if (consentAccepted !== true) {
      throw new DirectClientError("configuration", "CONSENT_REQUIRED", "Consent to the disclosed email data transmission is required before pairing.");
    }
    return this.exclusiveCredentialMutation(() => this.beginPairExclusive(apiBaseInput));
  }

  private async beginPairExclusive(apiBaseInput: unknown): Promise<PublicState> {
    this.rejectDuringFeatureRetirement();
    const operation = this.claimOperation();
    const endpoint = canonicalizeApiBase(apiBaseInput);
    if (this.remoteCredentialPossiblyActive) throw new DirectClientError("configuration", "REMOTE_REVOCATION_REQUIRED", "A previous device credential may still be active. Use Disconnect or Forget before pairing again.");
    this.activeAuthorizationPermissions.set(operation, endpoint.permissionPattern);
    try {
      return await this.beginPairOperation(endpoint, operation);
    } catch (error) {
      this.activeAuthorizationPermissions.delete(operation);
      const cleaned = await this.cleanupFailedPairing(endpoint.apiBase);
      throw markAuthorizationCleanup(error, cleaned ? "complete" : "background_pending");
    } finally { this.activeAuthorizationPermissions.delete(operation); }
  }

  private async beginPairOperation(endpoint: CanonicalEndpoint, operation: number): Promise<PublicState> {
    const permissionCheck = browser.permissions.contains({ origins: [endpoint.permissionPattern] });
    await this.initialized;
    const claimsFreshCandidate = this.unclaimedPermissionCandidates.has(endpoint.permissionPattern);
    const cleanupBlockers = [...this.pendingPermissionCleanup]
      .filter((pattern) => pattern !== endpoint.permissionPattern || !claimsFreshCandidate);
    if (cleanupBlockers.length > 0 || (this.settings?.connected === false && this.permissionGranted)) {
      throw new DirectClientError("permission", "PERMISSION_CLEANUP_REQUIRED", "Resolve the previous hostname permission before pairing.");
    }
    if ((this.settings?.connected && this.settings.credentialId !== null) || this.pendingRotation || this.pendingPairing) {
      throw new DirectClientError("configuration", "DISCONNECT_REQUIRED", "Disconnect or cancel the existing pairing before pairing again.");
    }
    const granted = await permissionCheck;
    this.assertCurrent(operation);
    if (!granted) throw new DirectClientError("permission", "HOST_PERMISSION_REQUIRED", "Host permission was not granted.");
    await this.mutate(async () => {
      this.assertCurrent(operation);
      this.pendingPermissionCleanup.add(endpoint.permissionPattern);
      await this.persistPendingCleanup();
    });
    const identity = await this.ensureIdentity();
    const requestId = randomPairingValue(24);
    const claimCredential = `${requestId}.${randomPairingValue(32)}`;
    const pending: PendingPairing = {
      version: 1, apiBase: endpoint.apiBase, origin: endpoint.origin, permissionPattern: endpoint.permissionPattern,
      requestId, deviceId: identity.deviceId, deviceName: identity.deviceName, claimCredential,
      claimVerifier: await pairingVerifier("claim", claimCredential), prospective: await this.prospectiveCredential(),
      approvalCode: null, expiresAt: null, claimAmbiguous: false,
    };
    await this.mutate(async () => {
      this.assertCurrent(operation);
      await browser.storage.local.set({ [PENDING_PAIRING_KEY]: pending });
      this.pendingPairing = pending;
      this.permissionGranted = true;
    });
    let issued;
    try { issued = await new BrowserPairingClient(endpoint).request(pending); }
    catch (error) {
      await browser.storage.local.remove(PENDING_PAIRING_KEY);
      this.pendingPairing = null;
      throw error;
    }
    const postWritePermission = await browser.permissions.contains({ origins: [endpoint.permissionPattern] });
    return this.mutate(async () => {
      this.assertCurrent(operation);
      if (this.pendingPairing !== pending) throw new DirectClientError("contract", "STALE_CONNECTION", "Pairing was replaced.");
      if (!postWritePermission) {
        this.permissionGranted = false;
        await browser.storage.local.remove(PENDING_PAIRING_KEY);
        this.pendingPairing = null;
        throw new DirectClientError("permission", "HOST_PERMISSION_REMOVED", "Host permission was removed during pairing.");
      }
      this.pendingPairing = { ...pending, approvalCode: issued.approvalCode, expiresAt: issued.expiresAt };
      await browser.storage.local.set({ [PENDING_PAIRING_KEY]: this.pendingPairing });
      this.unclaimedPermissionCandidates.delete(endpoint.permissionPattern);
      this.pendingPermissionCleanup.delete(endpoint.permissionPattern);
      const timer = this.candidateTimers.get(endpoint.permissionPattern);
      if (timer !== undefined) { clearTimeout(timer); this.candidateTimers.delete(endpoint.permissionPattern); }
      await this.persistPendingCleanup();
      return this.state();
    });
  }

  async claimPairing(): Promise<PublicState> {
    return this.exclusiveCredentialMutation(() => this.claimPairingExclusive());
  }

  private async claimPairingExclusive(): Promise<PublicState> {
    this.rejectDuringFeatureRetirement();
    const operation = this.claimOperation();
    await this.initialized;
    const pending = this.pendingPairing;
    if (!pending || pending.approvalCode === null || pending.expiresAt === null) throw new DirectClientError("configuration", "PAIRING_NOT_PENDING", "No pairing request is ready to claim.");
    if (!pending.claimAmbiguous && Date.parse(pending.expiresAt) <= Date.now()) throw new DirectClientError("authentication", "PAIRING_EXPIRED", "The pairing request expired. Start again.");
    const endpoint = canonicalizeApiBase(pending.apiBase);
    let device;
    const reconcileOnly = pending.claimAmbiguous;
    if (reconcileOnly) {
      device = await this.probeProspectiveCredential(pending);
      if (!device) throw new DirectClientError("network", "CLAIM_OUTCOME_AMBIGUOUS", "The claim outcome is still uncertain. Retry when the Gateway is reachable or use Forget.");
    } else {
      // Mark the prospective credential as possibly live before the one-time
      // claim leaves this process. Restart and every destructive action can
      // now reconcile or revoke it even if the response is lost.
      pending.claimAmbiguous = true;
      this.remoteCredentialPossiblyActive = true;
      this.remoteRecovery = recoveryRecord("pairing claim in flight", pending.apiBase, pending.origin,
        pending.permissionPattern, [pending.prospective.rawCredential]);
      await browser.storage.local.set({ [PENDING_PAIRING_KEY]: pending, [REMOTE_RECOVERY_KEY]: this.remoteRecovery });
      try { device = await new BrowserPairingClient(endpoint).claim(pending); }
      catch (error) {
        if (error instanceof DirectClientError && ["network", "timeout", "backend", "contract"].includes(error.kind)) {
          pending.claimAmbiguous = true;
          this.remoteCredentialPossiblyActive = true;
          this.remoteRecovery = recoveryRecord("ambiguous pairing claim", pending.apiBase, pending.origin,
            pending.permissionPattern, [pending.prospective.rawCredential]);
          await browser.storage.local.set({ [PENDING_PAIRING_KEY]: pending, [REMOTE_RECOVERY_KEY]: this.remoteRecovery });
          const recovered = await this.probeProspectiveCredential(pending).catch(() => null);
          if (recovered) device = recovered;
          else throw error;
        } else {
          const recovered = await this.probeProspectiveCredential(pending);
          if (recovered) device = recovered;
          else {
            pending.claimAmbiguous = false;
            this.remoteCredentialPossiblyActive = false;
            this.remoteRecovery = null;
            await browser.storage.local.set({ [PENDING_PAIRING_KEY]: pending });
            await browser.storage.local.remove(REMOTE_RECOVERY_KEY);
            throw error;
          }
        }
      }
    }
    const granted = await browser.permissions.contains({ origins: [pending.permissionPattern] });
    this.assertCurrent(operation);
    if (!granted) {
      pending.claimAmbiguous = true;
      this.remoteCredentialPossiblyActive = true;
      this.remoteRecovery = recoveryRecord("claimed credential after permission loss", pending.apiBase, pending.origin,
        pending.permissionPattern, [pending.prospective.rawCredential]);
      await browser.storage.local.set({ [PENDING_PAIRING_KEY]: pending, [REMOTE_RECOVERY_KEY]: this.remoteRecovery });
      throw new DirectClientError("permission", "HOST_PERMISSION_REMOVED", "Pairing may have completed remotely, but host permission was removed. Restore permission and retry Claim, or use Forget.");
    }
    return this.mutate(async () => {
      this.assertCurrent(operation);
      if (this.pendingPairing !== pending) throw new DirectClientError("contract", "STALE_CONNECTION", "Pairing was replaced.");
      const epoch = nextConnectionEpoch(this.currentEpoch);
      const settings: StoredSettings = { version: 1, apiBase: pending.apiBase, origin: pending.origin,
        permissionPattern: pending.permissionPattern, credentialId: device.credentialId, connected: true, epoch };
      const credential: StoredCredential = { version: 1, mode: "device_credential", apiBase: pending.apiBase, origin: pending.origin,
        credentialId: device.credentialId, deviceId: device.deviceId, deviceName: device.deviceName,
        rawCredential: pending.prospective.rawCredential, expiresAt: device.expiresAt };
      // One durable set makes the active binding and its credential visible
      // together; only after that succeeds is the one-time claim secret removed.
      await browser.storage.local.set({ [SETTINGS_KEY]: settings, [DEVICE_CREDENTIAL_KEY]: credential, [EPOCH_KEY]: epoch });
      await browser.storage.local.remove(PENDING_PAIRING_KEY);
      await browser.storage.local.remove(REMOTE_RECOVERY_KEY);
      await browser.storage.local.remove(CREDENTIAL_LIFECYCLE_KEY);
      this.settings = settings;
      this.pendingPairing = null;
      this.currentEpoch = epoch;
      this.credentialExpiresAt = device.expiresAt;
      this.permissionGranted = true;
      this.readyEpoch = null;
      this.pendingAuthorizationEpoch = null;
      this.remoteCredentialPossiblyActive = false;
      this.remoteRecovery = null;
      this.credentialLifecycle = null;
      return this.state();
    });
  }

  private async probeProspectiveCredential(pending: PendingPairing): Promise<{
    credentialId: string; deviceId: string; deviceName: string; expiresAt: string;
  } | null> {
    const credentialBinding = { mode: "device_credential" as const, credentialId: pending.prospective.credentialId };
    const binding: ConnectionBinding = { apiBase: pending.apiBase, origin: pending.origin,
      permissionId: pending.permissionPattern, epoch: nextConnectionEpoch(this.currentEpoch), credential: credentialBinding };
    const authentication: ClientAuthentication = { binding: credentialBinding, developmentOnly: false,
      authorize: async (writer) => writer.setBearerCredential(pending.prospective.rawCredential) };
    try {
      await new BrowserThunderClawDirectClient(binding, authentication).status();
      // Status proves the exact prospective bearer is active. Pairing registry
      // fixes identity/name and 90-day lifetime; use the bounded claim-request
      // timestamp only as a temporary expiry until the next successful rotate.
      return { credentialId: pending.prospective.credentialId, deviceId: pending.deviceId,
        deviceName: pending.deviceName, expiresAt: new Date(Date.now() + 89 * 24 * 60 * 60_000).toISOString() };
    } catch (error) {
      if (error instanceof DirectClientError && error.kind === "authentication") return null;
      throw error;
    }
  }

  async cancelPairing(): Promise<PublicState> {
    return this.exclusiveCredentialMutation(() => this.cancelPairingExclusive());
  }

  private async cancelPairingExclusive(): Promise<PublicState> {
    const operation = this.claimOperation();
    await this.initialized;
    const pending = this.pendingPairing;
    if (pending?.claimAmbiguous) {
      // A lost claim response may already have activated the prospective
      // bearer. Cancellation must revoke it before discarding local custody.
      try { await new BrowserPairingClient(canonicalizeApiBase(pending.apiBase)).revoke(pending.prospective.rawCredential); }
      catch (error) {
        if (!(error instanceof DirectClientError && ["AUTHENTICATION_FAILED", "CREDENTIAL_REVOKED", "CREDENTIAL_EXPIRED"].includes(error.code))) throw error;
      }
    }
    return this.mutate(async () => {
      this.assertCurrent(operation);
      const permission = this.pendingPairing?.permissionPattern ?? null;
      this.pendingPairing = null;
      await browser.storage.local.remove(PENDING_PAIRING_KEY);
      await browser.storage.local.remove(REMOTE_RECOVERY_KEY);
      this.remoteCredentialPossiblyActive = false;
      this.remoteRecovery = null;
      if (permission) await this.cleanupUnownedPermission(permission);
      return this.state();
    });
  }

  async cleanupFailedPairing(apiBaseInput: unknown): Promise<boolean> {
    let endpoint: CanonicalEndpoint;
    try {
      endpoint = canonicalizeApiBase(apiBaseInput);
    } catch {
      return false;
    }
    await this.initialized;
    return this.mutate(async () => {
      if (this.durablyOwnsPermission(endpoint.permissionPattern)) {
        this.pendingPermissionCleanup.delete(endpoint.permissionPattern);
        await this.persistPendingCleanup();
        return true;
      }
      if (this.activeAuthorizationOwnsPermission(endpoint.permissionPattern)) {
        this.pendingPermissionCleanup.add(endpoint.permissionPattern);
        await this.persistPendingCleanup();
        return false;
      }
      this.unclaimedPermissionCandidates.delete(endpoint.permissionPattern);
      try {
        await this.removeAndVerifyPermission(endpoint.permissionPattern);
        this.pendingPermissionCleanup.delete(endpoint.permissionPattern);
        await this.persistPendingCleanup();
        return true;
      } catch {
        this.pendingPermissionCleanup.add(endpoint.permissionPattern);
        await this.persistPendingCleanup();
        return false;
      }
    });
  }

  private async boundClient(): Promise<{ client: BrowserThunderClawDirectClient; binding: ConnectionBinding }> {
    const state = await this.getState();
    const settings = this.settings;
    if (!settings || (state.phase !== "authorized_untested" && state.phase !== "ready") || !settings.credentialId) {
      throw new DirectClientError(state.permissionGranted ? "authentication" : "permission", "CONNECTION_UNAVAILABLE", "ThunderClaw is not connected.");
    }
    const credentialBinding = { mode: "device_credential" as const, credentialId: settings.credentialId };
    const binding: ConnectionBinding = {
      apiBase: settings.apiBase,
      origin: settings.origin,
      permissionId: settings.permissionPattern,
      epoch: settings.epoch,
      credential: credentialBinding,
    };
    const authentication: ClientAuthentication = {
      binding: credentialBinding,
      developmentOnly: false,
      authorize: async (writer) => {
        const stored = await browser.storage.local.get(DEVICE_CREDENTIAL_KEY);
        const current = this.settings;
        const credential = current ? readCredential(stored[DEVICE_CREDENTIAL_KEY], current) : null;
        if (!credential || !current || !sameConnectionBinding(binding, {
          apiBase: current.apiBase,
          origin: current.origin,
          permissionId: current.permissionPattern,
          epoch: current.epoch,
          credential: { mode: "device_credential", credentialId: current.credentialId ?? "" },
        })) throw new DirectClientError("authentication", "CREDENTIAL_UNAVAILABLE", "The credential is unavailable.");
        if (Date.parse(credential.expiresAt) <= Date.now()) throw new DirectClientError("authentication", "CREDENTIAL_EXPIRED", "The credential expired.");
        writer.setBearerCredential(credential.rawCredential);
      },
    };
    return { client: new BrowserThunderClawDirectClient(binding, authentication, fetch,
      (code) => this.handleCredentialLifecycleRejection(binding, code)), binding };
  }

  private async handleCredentialLifecycleRejection(binding: ConnectionBinding, code: "CREDENTIAL_EXPIRED" | "CREDENTIAL_REVOKED"): Promise<void> {
    if (!this.isFeatureBindingCurrent(binding)) return;
    const operation = this.claimOperation();
    const fence = this.beginFeatureRetirement();
    try {
      await this.mutate(async () => {
        this.assertCurrent(operation);
        await this.invalidate(true, false);
        this.credentialLifecycle = code === "CREDENTIAL_EXPIRED" ? "expired" : "revoked";
        await browser.storage.local.set({ [CREDENTIAL_LIFECYCLE_KEY]: { version: 1, status: this.credentialLifecycle } });
      });
    } finally { this.endFeatureRetirement(fence); }
  }

  /** Background-only feature access. The credential remains inside the client. */
  async acquireFeatureLease(): Promise<BackgroundFeatureLease> {
    this.rejectDuringFeatureRetirement();
    const candidate = await this.boundClient();
    this.rejectDuringFeatureRetirement();
    if (this.featureLease && sameConnectionBinding(this.featureLease.binding, candidate.binding)) return this.featureLease;
    this.featureLease = candidate;
    return candidate;
  }

  isFeatureBindingCurrent(binding: ConnectionBinding): boolean {
    if (this.featureRetiring || this.featureRetirementFences.size > 0 || this.pendingRotation
        || this.remoteCredentialPossiblyActive || this.credentialExpired()) return false;
    const settings = this.settings;
    return Boolean(settings?.connected && settings.credentialId && this.permissionGranted
      && this.pendingAuthorizationEpoch !== settings.epoch
      && sameConnectionBinding(binding, {
        apiBase: settings.apiBase,
        origin: settings.origin,
        permissionId: settings.permissionPattern,
        epoch: settings.epoch,
        credential: { mode: "device_credential", credentialId: settings.credentialId },
      }));
  }

  addFeatureRetirementHandler(handler: FeatureRetirementHandler): () => void {
    this.featureRetirementHandlers.add(handler);
    return () => { this.featureRetirementHandlers.delete(handler); };
  }

  async diagnose(): Promise<Record<string, unknown>> {
    this.rejectDuringFeatureRetirement();
    const operation = this.claimOperation();
    const { client, binding } = await this.boundClient();
    this.assertCurrent(operation);
    this.diagnosticAbort?.abort();
    const abort = new AbortController();
    this.diagnosticAbort = abort;
    try {
      const status = await client.status({ signal: abort.signal });
      if (!sameConnectionBinding(status.binding, binding) || this.settings?.epoch !== binding.epoch) {
        throw new DirectClientError("contract", "STALE_CONNECTION", "Connection changed during diagnostics.");
      }
      this.assertCurrent(operation);
      const agents = await client.listAgents(randomId(), { signal: abort.signal });
      if (!sameConnectionBinding(agents.binding, binding) || this.settings?.epoch !== binding.epoch) {
        throw new DirectClientError("contract", "STALE_CONNECTION", "Connection changed during diagnostics.");
      }
      this.assertCurrent(operation);
      this.readyEpoch = binding.epoch;
      return {
        status: {
          protocolVersion: status.value.protocolVersion,
          plugin: status.value.plugin,
          gatewayVersion: plain(status.value.gatewayVersion),
        },
        agents: agents.value.agents.map(sanitizeAgent),
      };
    } finally {
      if (this.diagnosticAbort === abort) this.diagnosticAbort = null;
    }
  }

  async verifyAgent(agentId: string, probeRunId: string, owner: OptionsOwner = this): Promise<Record<string, unknown>> {
    this.rejectDuringFeatureRetirement();
    if (this.agentVerifications.has(probeRunId)
        || [...this.agentVerifications.values()].some((verification) => verification.agentId === agentId)) {
      throw new DirectClientError("backend", "AGENT_PROBE_ACTIVE", "This agent already has a verification in progress.");
    }
    const abort = new AbortController();
    const active: ActiveAgentVerification = {
      agentId, probeRunId, binding: null, client: null, abort, owner,
      agentConfiguration: null,
      serverStarted: false,
      cancelling: false,
      probeSettled: false,
    };
    // Reserve the exact owner/probe identity before the first await. Options
    // port closure and connection retirement can now abort even client-binding
    // and discovery preflight, before any model-calling probe may start.
    this.agentVerifications.set(probeRunId, active);
    try {
      const { client, binding } = await this.boundClient();
      if (!this.isFeatureBindingCurrent(binding)) {
        throw new DirectClientError("contract", "STALE_CONNECTION", "Connection changed before agent verification.");
      }
      if (this.agentVerifications.get(probeRunId) !== active || abort.signal.aborted) {
        throw new DirectClientError("cancellation", "STALE_AGENT_VERIFICATION", "Agent verification is no longer current.");
      }
      active.client = client;
      active.binding = binding;
      const before = await client.listAgents(randomId(), { signal: abort.signal });
      if (!sameConnectionBinding(before.binding, binding) || !this.isFeatureBindingCurrent(binding)) {
        throw new DirectClientError("contract", "STALE_CONNECTION", "Connection changed before agent verification.");
      }
      if (this.agentVerifications.get(probeRunId) !== active || abort.signal.aborted) {
        throw new DirectClientError("cancellation", "STALE_AGENT_VERIFICATION", "Agent verification is no longer current.");
      }
      const selected = before.value.agents.find((agent) => agent.agentId === agentId);
      if (!selected) throw new DirectClientError("configuration", "UNKNOWN_AGENT", "The selected agent is unavailable.");
      active.agentConfiguration = agentConfiguration(selected);
      active.serverStarted = true;
      const completion = await client.probeAgent({ protocolVersion: 1, requestId: randomId(), probeRunId, agentId }, { signal: abort.signal });
      if (this.agentVerifications.get(probeRunId) !== active || !sameConnectionBinding(completion.binding, binding)
          || !this.isFeatureBindingCurrent(binding) || completion.value.agent.agentId !== agentId
          || agentConfiguration(completion.value.agent) !== active.agentConfiguration) {
        throw new DirectClientError("contract", "STALE_AGENT_VERIFICATION", "Agent verification is no longer current.");
      }
      const refreshed = await client.listAgents(randomId(), { signal: abort.signal });
      const current = refreshed.value.agents.find((agent) => agent.agentId === agentId);
      if (this.agentVerifications.get(probeRunId) !== active || !sameConnectionBinding(refreshed.binding, binding)
          || !this.isFeatureBindingCurrent(binding) || !current
          || agentConfiguration(current) !== active.agentConfiguration) {
        throw new DirectClientError("contract", "STALE_AGENT_VERIFICATION", "Agent configuration changed during verification.");
      }
      return { agent: sanitizeAgent(current), agents: refreshed.value.agents.map(sanitizeAgent) };
    } finally {
      active.probeSettled = true;
      if (!active.cancelling && this.agentVerifications.get(probeRunId) === active) this.agentVerifications.delete(probeRunId);
    }
  }

  async cancelAgentVerification(agentId: string, probeRunId: string, owner: OptionsOwner = this): Promise<Record<string, unknown>> {
    const active = this.agentVerifications.get(probeRunId);
    if (!active || active.agentId !== agentId || active.owner !== owner) {
      throw new DirectClientError("configuration", "UNKNOWN_AGENT_PROBE", "The verification is no longer active.");
    }
    if (!active.serverStarted || active.binding === null || active.client === null) {
      active.abort.abort();
      this.agentVerifications.delete(probeRunId);
      return { probeRunId, agentId, cancelled: true };
    }
    if (!this.isFeatureBindingCurrent(active.binding)) {
      throw new DirectClientError("contract", "STALE_CONNECTION", "Connection changed during agent verification.");
    }
    active.cancelling = true;
    let acknowledged = false;
    try {
      const completion = await active.client.cancelAgentProbe({
        protocolVersion: 1, requestId: randomId(), probeRunId, agentId,
      });
      acknowledged = true;
      if (this.agentVerifications.get(probeRunId) !== active || !sameConnectionBinding(completion.binding, active.binding)
          || !this.isFeatureBindingCurrent(active.binding)) {
        throw new DirectClientError("contract", "STALE_AGENT_VERIFICATION", "Agent verification is no longer current.");
      }
      const refreshed = await active.client.listAgents(randomId());
      if (this.agentVerifications.get(probeRunId) !== active || !sameConnectionBinding(refreshed.binding, active.binding)
          || !this.isFeatureBindingCurrent(active.binding)) {
        throw new DirectClientError("contract", "STALE_AGENT_VERIFICATION", "Agent verification is no longer current.");
      }
      return { probeRunId, agentId, cancelled: true, agents: refreshed.value.agents.map(sanitizeAgent) };
    } finally {
      active.cancelling = false;
      if (acknowledged) {
        active.abort.abort();
        if (this.agentVerifications.get(probeRunId) === active) this.agentVerifications.delete(probeRunId);
      } else if (active.probeSettled && this.agentVerifications.get(probeRunId) === active) {
        this.agentVerifications.delete(probeRunId);
      }
    }
  }

  cancelLocalAgentVerifications(owner: OptionsOwner): void {
    for (const [probeRunId, active] of this.agentVerifications) {
      if (active.owner !== owner) continue;
      active.abort.abort();
      this.agentVerifications.delete(probeRunId);
    }
  }

  async rotateCredential(): Promise<PublicState> {
    return this.exclusiveCredentialMutation(() => this.rotateCredentialExclusive());
  }

  private async rotateCredentialExclusive(): Promise<PublicState> {
    this.rejectDuringFeatureRetirement();
    const operation = this.claimOperation();
    const fence = this.beginFeatureRetirement();
    try {
      await this.initialized;
      const settings = this.settings;
      if (!settings?.connected || !settings.credentialId || !this.permissionGranted) {
        throw new DirectClientError("configuration", "CONNECTION_UNAVAILABLE", "A healthy paired connection is required for rotation.");
      }
      if (this.pendingRotation) {
        const pending = this.pendingRotation;
        if (await this.probeCredential(settings, pending.prospective.credentialId, pending.prospective.rawCredential)) {
          return await this.promoteRotation(operation, pending, {
            credentialId: pending.prospective.credentialId,
            expiresAt: new Date(Date.now() + 89 * 24 * 60 * 60_000).toISOString(),
          });
        }
        if (!(await this.probeCredential(settings, pending.current.credentialId, pending.current.rawCredential))) {
          throw new DirectClientError("authentication", "ROTATION_OUTCOME_AMBIGUOUS", "Neither rotation credential could be authenticated. Use Forget and verify revocation in OpenClaw administration.");
        }
        await browser.storage.local.remove([PENDING_ROTATION_KEY, REMOTE_RECOVERY_KEY]);
        this.pendingRotation = null;
        this.remoteCredentialPossiblyActive = false;
        this.remoteRecovery = null;
      }
      const stored = await browser.storage.local.get(DEVICE_CREDENTIAL_KEY);
      const current = readCredential(stored[DEVICE_CREDENTIAL_KEY], settings);
      if (!current) throw new DirectClientError("authentication", "CREDENTIAL_UNAVAILABLE", "The credential is unavailable.");
      const prospective = await this.prospectiveCredential();
      const pending: PendingRotation = { version: 1, apiBase: settings.apiBase, origin: settings.origin,
        permissionPattern: settings.permissionPattern, current, prospective, startedAt: new Date().toISOString() };
      await browser.storage.local.set({ [PENDING_ROTATION_KEY]: pending });
      this.pendingRotation = pending;
      let device;
      try {
        device = await new BrowserPairingClient(canonicalizeApiBase(settings.apiBase)).rotate(
          current.rawCredential, prospective, { deviceId: current.deviceId, deviceName: current.deviceName },
        );
      } catch (error) {
        const ambiguous = error instanceof DirectClientError && ["network", "timeout", "backend", "contract"].includes(error.kind);
        if (!ambiguous) {
          this.pendingRotation = null;
          await browser.storage.local.remove(PENDING_ROTATION_KEY);
        } else {
          this.remoteCredentialPossiblyActive = true;
          this.remoteRecovery = recoveryRecord("ambiguous credential rotation", settings.apiBase, settings.origin,
            settings.permissionPattern, [current.rawCredential, prospective.rawCredential]);
          await browser.storage.local.set({ [REMOTE_RECOVERY_KEY]: this.remoteRecovery });
        }
        throw error;
      }
      return await this.promoteRotation(operation, pending, device);
    } finally { this.endFeatureRetirement(fence); }
  }

  private async probeCredential(settings: StoredSettings, credentialId: string, rawCredential: string): Promise<boolean> {
    const credentialBinding = { mode: "device_credential" as const, credentialId };
    const binding: ConnectionBinding = { apiBase: settings.apiBase, origin: settings.origin,
      permissionId: settings.permissionPattern, epoch: nextConnectionEpoch(this.currentEpoch), credential: credentialBinding };
    const authentication: ClientAuthentication = { binding: credentialBinding, developmentOnly: false,
      authorize: async (writer) => writer.setBearerCredential(rawCredential) };
    try { await new BrowserThunderClawDirectClient(binding, authentication).status(); return true; }
    catch (error) {
      if (error instanceof DirectClientError && error.kind === "authentication") return false;
      throw error;
    }
  }

  private async promoteRotation(operation: number, pending: PendingRotation, device: { credentialId: string; expiresAt: string }): Promise<PublicState> {
    return this.mutate(async () => {
      this.assertCurrent(operation);
      const settings = this.settings;
      if (this.pendingRotation !== pending || !settings || settings.credentialId !== pending.current.credentialId) {
        throw new DirectClientError("contract", "STALE_CONNECTION", "Rotation was replaced.");
      }
      const epoch = nextConnectionEpoch(this.currentEpoch);
      const nextSettings: StoredSettings = { ...settings, credentialId: device.credentialId, epoch };
      const nextCredential: StoredCredential = { ...pending.current, credentialId: device.credentialId,
        rawCredential: pending.prospective.rawCredential, expiresAt: device.expiresAt };
      await browser.storage.local.set({ [SETTINGS_KEY]: nextSettings, [DEVICE_CREDENTIAL_KEY]: nextCredential, [EPOCH_KEY]: epoch });
      await browser.storage.local.remove([PENDING_ROTATION_KEY, REMOTE_RECOVERY_KEY]);
      this.settings = nextSettings;
      this.currentEpoch = epoch;
      this.credentialExpiresAt = device.expiresAt;
      this.pendingRotation = null;
      this.remoteCredentialPossiblyActive = false;
      this.remoteRecovery = null;
      this.readyEpoch = null;
      this.featureLease = null;
      return this.state();
    });
  }

  private recoveryCandidates(): Array<{ apiBase: string; rawCredential: string }> {
    const candidates: Array<{ apiBase: string; rawCredential: string }> = [];
    const add = (apiBase: unknown, candidate: unknown) => {
      const record = ownRecord(candidate);
      if (typeof apiBase === "string" && typeof record?.rawCredential === "string"
          && /^([A-Za-z0-9_-]{20,64})\.([A-Za-z0-9_-]{43,128})$/u.test(record.rawCredential)) {
        candidates.push({ apiBase, rawCredential: record.rawCredential });
      }
    };
    if (this.pendingRotation) {
      add(this.pendingRotation.apiBase, this.pendingRotation.current);
      add(this.pendingRotation.apiBase, this.pendingRotation.prospective);
    }
    if (this.pendingPairing?.claimAmbiguous) add(this.pendingPairing.apiBase, this.pendingPairing.prospective);
    if (this.remoteRecovery) {
      for (const candidate of this.remoteRecovery.candidates) add(this.remoteRecovery.apiBase, candidate);
    }
    return [...new Map(candidates.map((candidate) => [candidate.rawCredential, candidate])).values()];
  }

  private async revokeCandidate(apiBase: string, rawCredential: string): Promise<void> {
    try { await new BrowserPairingClient(canonicalizeApiBase(apiBase)).revoke(rawCredential); }
    catch (error) {
      if (!(error instanceof DirectClientError && ["AUTHENTICATION_FAILED", "CREDENTIAL_REVOKED", "CREDENTIAL_EXPIRED"].includes(error.code))) throw error;
    }
  }

  async disconnect(): Promise<PublicState> {
    return this.exclusiveCredentialMutation(() => this.disconnectExclusive());
  }

  private async disconnectExclusive(): Promise<PublicState> {
    const operation = this.claimOperation();
    const fence = this.beginFeatureRetirement();
    try {
      await this.initialized;
      const settings = this.settings;
      if (settings) await browser.storage.local.set({ [FEATURE_RETIREMENT_KEY]: { version: 1, epoch: settings.epoch } });
      const candidates = this.recoveryCandidates();
      if (settings?.credentialId) {
        const stored = await browser.storage.local.get(DEVICE_CREDENTIAL_KEY);
        const credential = readCredential(stored[DEVICE_CREDENTIAL_KEY], settings);
        if (credential && !candidates.some((candidate) => candidate.rawCredential === credential.rawCredential)) {
          candidates.push({ apiBase: settings.apiBase, rawCredential: credential.rawCredential });
        }
      }
      if (candidates.length === 0) {
        if (this.pendingPermissionCleanup.size === 0 && !this.credentialLifecycle) throw new DirectClientError("authentication", "CREDENTIAL_UNAVAILABLE", "No locally held credential can be revoked. Use Forget and verify this device in OpenClaw administration.");
        return await this.mutate(async () => {
          this.assertCurrent(operation);
          if (this.credentialLifecycle && settings?.permissionPattern) {
            await this.removeAndVerifyPermission(settings.permissionPattern);
            this.permissionGranted = false;
            this.credentialLifecycle = null;
            await browser.storage.local.remove(CREDENTIAL_LIFECYCLE_KEY);
          }
          for (const pattern of [...this.pendingPermissionCleanup]) {
            if (!(await this.cleanupUnownedPermission(pattern))) throw new DirectClientError("permission", "PERMISSION_REMOVAL_FAILED", "Thunderbird host permission could not be removed.");
          }
          await browser.storage.local.remove(FEATURE_RETIREMENT_KEY);
          return this.state();
        });
      }
      try { for (const candidate of candidates) await this.revokeCandidate(candidate.apiBase, candidate.rawCredential); }
      catch (error) {
        this.remoteCredentialPossiblyActive = true;
        const recovery = this.remoteRecovery ?? recoveryRecord("ambiguous disconnect",
          settings?.apiBase ?? this.pendingPairing?.apiBase ?? this.pendingRotation!.apiBase,
          settings?.origin ?? this.pendingPairing?.origin ?? this.pendingRotation!.origin,
          settings?.permissionPattern ?? this.pendingPairing?.permissionPattern ?? this.pendingRotation!.permissionPattern,
          candidates.map((candidate) => candidate.rawCredential));
        this.remoteRecovery = recovery;
        await browser.storage.local.set({ [REMOTE_RECOVERY_KEY]: recovery });
        throw error;
      }
      return await this.mutate(async () => {
        this.assertCurrent(operation);
        const permission = settings?.permissionPattern ?? this.pendingPairing?.permissionPattern ?? this.pendingRotation?.permissionPattern ?? null;
        if (this.settings) await this.invalidate(false, false);
        await browser.storage.local.remove(REMOTE_RECOVERY_KEY);
        await browser.storage.local.remove([PENDING_ROTATION_KEY, PENDING_PAIRING_KEY]);
        this.remoteCredentialPossiblyActive = false;
        this.remoteRecovery = null;
        this.pendingRotation = null;
        this.pendingPairing = null;
        if (permission) {
          try {
            await this.removeAndVerifyPermission(permission);
            this.pendingPermissionCleanup.delete(permission);
            await this.persistPendingCleanup();
          } catch (error) {
            this.pendingPermissionCleanup.add(permission);
            await this.persistPendingCleanup();
            try { this.permissionGranted = await this.boundedPermission(browser.permissions.contains({ origins: [permission] })); }
            catch { this.permissionGranted = true; }
            throw error;
          }
        }
        for (const pattern of [...this.pendingPermissionCleanup]) {
          if (!(await this.cleanupUnownedPermission(pattern))) {
            throw new DirectClientError("permission", "PERMISSION_REMOVAL_FAILED", "Thunderbird host permission could not be removed.");
          }
        }
        return this.state();
      });
    } finally { this.endFeatureRetirement(fence); }
  }

  async forget(): Promise<PublicState> {
    return this.exclusiveCredentialMutation(() => this.forgetExclusive());
  }

  private async forgetExclusive(): Promise<PublicState> {
    const operation = this.claimOperation();
    const fence = this.beginFeatureRetirement();
    try {
      await this.initialized;
      const settings = this.settings;
      if (settings) await browser.storage.local.set({ [FEATURE_RETIREMENT_KEY]: { version: 1, epoch: settings.epoch } });
      const permission = settings?.permissionPattern ?? this.pendingPairing?.permissionPattern ?? this.pendingRotation?.permissionPattern ?? null;
      let remoteRevocation: "confirmed" | "unconfirmed" = "unconfirmed";
      const candidates = this.recoveryCandidates();
      if (settings?.credentialId) {
        const stored = await browser.storage.local.get(DEVICE_CREDENTIAL_KEY);
        const credential = readCredential(stored[DEVICE_CREDENTIAL_KEY], settings);
        if (credential && !candidates.some((candidate) => candidate.rawCredential === credential.rawCredential)) candidates.push({ apiBase: settings.apiBase, rawCredential: credential.rawCredential });
      }
      if (candidates.length > 0) {
        try {
          for (const candidate of candidates) await this.revokeCandidate(candidate.apiBase, candidate.rawCredential);
          remoteRevocation = "confirmed";
        } catch {
          remoteRevocation = "unconfirmed";
        }
      }
      return await this.mutate(async () => {
        this.assertCurrent(operation);
        if (this.settings) await this.invalidate(false, false);
        this.pendingPairing = null;
        this.pendingRotation = null;
        this.remoteCredentialPossiblyActive = false;
        this.remoteRecovery = null;
        if (permission) {
          try {
            await this.removeAndVerifyPermission(permission);
            this.pendingPermissionCleanup.delete(permission);
            await this.persistPendingCleanup();
          } catch {
            this.pendingPermissionCleanup.add(permission);
            await this.persistPendingCleanup();
            try { this.permissionGranted = await this.boundedPermission(browser.permissions.contains({ origins: [permission] })); }
            catch { this.permissionGranted = true; }
          }
        }
        for (const pattern of [...this.pendingPermissionCleanup]) {
          await this.cleanupUnownedPermission(pattern);
        }
        await browser.storage.local.remove([SETTINGS_KEY, DEVICE_CREDENTIAL_KEY, PENDING_PAIRING_KEY, PENDING_ROTATION_KEY, REMOTE_RECOVERY_KEY]);
        await browser.storage.local.remove(CREDENTIAL_LIFECYCLE_KEY);
        this.settings = null;
        this.credentialExpiresAt = null;
        this.credentialLifecycle = null;
        this.permissionGranted = permission ? await browser.permissions.contains({ origins: [permission] }) : false;
        this.readyEpoch = null;
        return { ...this.state(), forgetRemoteRevocation: remoteRevocation };
      });
    } finally { this.endFeatureRetirement(fence); }
  }

  async reconcileUnclaimedPermissions(): Promise<void> {
    await this.initialized;
    await this.mutate(async () => {
      const candidates = new Set([...this.unclaimedPermissionCandidates, ...this.pendingPermissionCleanup]);
      for (const pattern of candidates) await this.cleanupUnownedPermission(pattern);
    });
  }
}

function requestShape(message: unknown): { requestId: string; method: string; apiBase?: unknown; consentAccepted?: boolean; agentId?: string; probeRunId?: string } | null {
  const record = ownRecord(message);
  if (!record || !validIdentifier(record.requestId) || typeof record.method !== "string") return null;
  const allowed = record.method === "beginPair" ? new Set(["requestId", "method", "apiBase", "consentAccepted"])
    : record.method === "verifyAgent" || record.method === "cancelAgentVerification"
      ? new Set(["requestId", "method", "agentId", "probeRunId"])
      : new Set(["requestId", "method"]);
  if (!["state", "beginPair", "claimPairing", "cancelPairing", "rotateCredential", "diagnose", "verifyAgent", "cancelAgentVerification", "disconnect", "forget"].includes(record.method)
      || Object.keys(record).some((key) => !allowed.has(key))
      || (record.method === "beginPair" && (!Object.hasOwn(record, "apiBase") || typeof record.consentAccepted !== "boolean"))
      || ((record.method === "verifyAgent" || record.method === "cancelAgentVerification")
        && (!validIdentifier(record.agentId) || !validIdentifier(record.probeRunId)))) return null;
  return record as { requestId: string; method: string; apiBase?: unknown; consentAccepted?: boolean; agentId?: string; probeRunId?: string };
}

export function installOptionsConnectionController(): ConnectionController {
  const controller = new ConnectionController();
    browser.runtime.onConnect.addListener((port: any) => {
    const optionsUrl = browser.runtime.getURL("options.html");
    if (port.name !== OPTIONS_PORT_NAME || port.sender?.id !== browser.runtime.id || port.sender?.url !== optionsUrl) {
      port.disconnect();
      return;
    }
    const owner: OptionsOwner = {};
    let portOpen = true;
    const postResponse = (message: unknown): void => { if (portOpen) port.postMessage(message); };
    port.onMessage.addListener((message: unknown) => {
      const request = requestShape(message);
      if (!request) {
        port.disconnect();
        return;
      }
      void (async () => {
        try {
          let value: unknown;
          if (request.method === "state") value = await controller.getState();
          else if (request.method === "beginPair") value = await controller.beginPair(request.apiBase, request.consentAccepted);
          else if (request.method === "claimPairing") value = await controller.claimPairing();
          else if (request.method === "cancelPairing") value = await controller.cancelPairing();
          else if (request.method === "rotateCredential") value = await controller.rotateCredential();
          else if (request.method === "diagnose") value = await controller.diagnose();
          else if (request.method === "verifyAgent") value = await controller.verifyAgent(request.agentId!, request.probeRunId!, owner);
          else if (request.method === "cancelAgentVerification") value = await controller.cancelAgentVerification(request.agentId!, request.probeRunId!, owner);
          else if (request.method === "disconnect") value = await controller.disconnect();
          else value = await controller.forget();
          postResponse({ requestId: request.requestId, ok: true, value });
        } catch (error) {
          const sanitized = publicError(error);
          if (request.method === "beginPair") {
            const signaled = ownRecord(error)?.permissionCleanup;
            const cleanup = signaled === "complete" || signaled === "background_pending"
              ? signaled
              : await controller.cleanupFailedPairing(request.apiBase) ? "complete" : "background_pending";
            postResponse({
              requestId: request.requestId,
              ok: false,
              error: { ...sanitized, permissionCleanup: cleanup },
            });
          } else {
            postResponse({ requestId: request.requestId, ok: false, error: sanitized });
          }
        }
      })();
    });
    port.onDisconnect?.addListener(() => {
      portOpen = false;
      controller.cancelLocalAgentVerifications(owner);
      void controller.reconcileUnclaimedPermissions();
    });
  });
  return controller;
}
