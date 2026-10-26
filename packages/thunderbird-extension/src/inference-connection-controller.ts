import { DirectClientError, nextConnectionEpoch, sameConnectionBinding, type ConnectionBinding, type ThunderClawDirectClient } from "./direct-client-contract.js";
import { InferenceClient, inferenceFailureMessage } from "./inference-client.js";
import { canonicalizeInferenceBase, PROVIDER_PRESETS, supportsModelDiscovery, validateInferenceConfiguration, type InferenceConfiguration } from "./inference-provider.js";
import { canonicalizeApiBase } from "./endpoint-policy.js";
import { IndexedDbInferenceCredentialStore, type InferenceCredentialStore } from "./credential-store.js";
import { randomId } from "./random-id.js";

declare const browser: any;
export const INFERENCE_OPTIONS_PORT_NAME = "thunderclaw-inference-options-v1";
export const INFERENCE_SETTINGS_KEY = "thunderclaw.inferenceSettings.v1";
const MIGRATION_KEY = "thunderclaw.inferenceMigration.v1";
const LEGACY_KEYS = ["connectionSettings", "developmentNarrowCredential", "deviceIdentity", "deviceCredential", "pendingPairing", "pendingRotation", "remoteCredentialRecovery", "credentialLifecycle", "connectionEpoch", "pendingPermissionCleanup", "featureRetirement"].map((name) => `thunderclaw.${name}.v1`);

type SavedSettings = { version: 1; configuration: InferenceConfiguration; credentialId: string | null; revision: string; epoch: number; testedAt: string | null; permissionPattern: string };
export type BackgroundFeatureLease = Readonly<{ client: ThunderClawDirectClient; binding: ConnectionBinding }>;
export type FeatureRetirementHandler = (lease: BackgroundFeatureLease) => void | Promise<void>;
type ManagedClient = ThunderClawDirectClient & { listModels(options?: { signal?: AbortSignal }): Promise<string[]>; testConnection(options?: { signal?: AbortSignal }): Promise<void> };
type ControllerOptions = {
  credentialStore?: InferenceCredentialStore;
  createClient?: (configuration: InferenceConfiguration, key: string, binding: ConnectionBinding, options: { permissionCheck: () => Promise<boolean> }) => ManagedClient;
};
export type InferencePublicState = Readonly<{
  configured: boolean; configuration: InferenceConfiguration | null; hasKey: boolean; permissionGranted: boolean;
  phase: "not_configured" | "permission_required" | "key_required" | "untested" | "ready";
  epoch: number; testedAt: string | null; legacyMigration: boolean; permissionCleanupPending: boolean;
}>;

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function fail(kind: "configuration" | "permission" | "cancellation" | "contract" | "capability", code: string): never {
  throw new DirectClientError(kind, code, kind === "permission" ? "Grant access to the selected inference endpoint in settings." : kind === "cancellation" ? "The connection changed. Try the action again." : kind === "capability" ? "Enter the exact full Fireworks model ID manually." : "Save and test a valid inference connection in settings.");
}
function readSettings(value: unknown): SavedSettings | null {
  const item = record(value);
  if (!item || item.version !== 1 || typeof item.revision !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.revision)
      || (item.credentialId !== null && (typeof item.credentialId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.credentialId)))
      || !Number.isSafeInteger(item.epoch) || (item.epoch as number) < 0
      || (item.testedAt !== null && (typeof item.testedAt !== "string" || !Number.isFinite(Date.parse(item.testedAt))))) return null;
  try {
    const configuration = validateInferenceConfiguration(item.configuration, { allowLegacyThinking: true });
    const permissionPattern = canonicalizeInferenceBase(configuration.apiBase).permissionPattern;
    if (item.permissionPattern !== permissionPattern) return null;
    const previous = record(item.configuration);
    // Persist canonical settings on load, and require a new test when migrating the
    // old 8192-token budget or legacy thinking behavior. Credentials keep their scope.
    const changedRequest = previous?.maxResponseTokens === undefined
      || previous.reasoningEffort !== configuration.reasoningEffort || previous.thinking !== undefined;
    return { version: 1, configuration, credentialId: item.credentialId as string | null, revision: item.revision, epoch: item.epoch as number, testedAt: changedRequest ? null : item.testedAt as string | null, permissionPattern };
  } catch { return null; }
}
function safePattern(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("/*")) return false;
  try { return canonicalizeInferenceBase(`${value.slice(0, -2)}/v1`).permissionPattern === value; } catch { return false; }
}

export class InferenceConnectionController {
  private readonly credentials: InferenceCredentialStore;
  private readonly createClient: NonNullable<ControllerOptions["createClient"]>;
  private readonly initialized: Promise<void>;
  private settings: SavedSettings | null = null;
  private epoch = 0;
  private generation = 0;
  private pendingMutations = 0;
  private tail: Promise<void> = Promise.resolve();
  private lease: BackgroundFeatureLease | null = null;
  private readonly handlers = new Set<FeatureRetirementHandler>();
  private readonly operations = new Set<AbortController>();
  private legacyMigration = false;
  private cleanupPatterns: string[] = [];
  private permissionGranted = false;
  constructor(private readonly api: any = browser, options: ControllerOptions = {}) {
    this.credentials = options.credentialStore ?? new IndexedDbInferenceCredentialStore();
    this.createClient = options.createClient ?? ((configuration, key, binding, clientOptions) => new InferenceClient(configuration, key, binding, clientOptions));
    this.initialized = this.load();
    this.api.permissions.onRemoved?.addListener(() => { void this.permissionChanged().catch(() => undefined); });
    this.api.permissions.onAdded?.addListener(() => { void this.permissionChanged().catch(() => undefined); });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private invalidate(): Promise<void> {
    this.generation += 1;
    this.epoch = nextConnectionEpoch(this.epoch);
    for (const operation of this.operations) operation.abort();
    const previous = this.lease;
    this.lease = null;
    return previous ? Promise.all([...this.handlers].map((handler) => Promise.resolve().then(() => handler(previous)))).then(() => undefined) : Promise.resolve();
  }
  private async mutation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingMutations += 1;
    const retirement = this.invalidate();
    try { return await this.enqueue(async () => { await this.initialized; await retirement; return operation(); }); }
    finally { this.pendingMutations -= 1; }
  }
  private async load(): Promise<void> {
    const stored = await this.api.storage.local.get([INFERENCE_SETTINGS_KEY, MIGRATION_KEY, ...LEGACY_KEYS]);
    this.settings = readSettings(stored[INFERENCE_SETTINGS_KEY]);
    this.epoch = Math.max(this.epoch, this.settings?.epoch ?? 0) + 1;
    const marker = record(stored[MIGRATION_KEY]);
    this.legacyMigration = marker?.legacyMigration === true || LEGACY_KEYS.some((key) => stored[key] !== undefined);
    this.cleanupPatterns = Array.isArray(marker?.cleanupPatterns) ? marker.cleanupPatterns.filter(safePattern) : [];
    const inspect = (value: unknown, depth = 0): void => {
      const item = record(value);
      if (!item || depth > 3) return;
      if (typeof item.apiBase === "string") {
        try { this.cleanupPatterns.push(canonicalizeApiBase(item.apiBase).permissionPattern); } catch { /* Never trust arbitrary legacy permission strings. */ }
      }
      for (const name of ["current", "prospective"]) inspect(item[name], depth + 1);
    };
    for (const key of LEGACY_KEYS) inspect(stored[key]);
    const priorCleanup = stored["thunderclaw.pendingPermissionCleanup.v1"];
    if (Array.isArray(priorCleanup)) this.cleanupPatterns.push(...priorCleanup.filter(safePattern));
    // Persist the cleanup plan before removing raw legacy material; restart can resume safely.
    this.cleanupPatterns = [...new Set(this.cleanupPatterns)].filter((pattern) => pattern !== this.settings?.permissionPattern);
    await this.saveMigration();
    await this.api.storage.local.remove(LEGACY_KEYS);
    await this.cleanupPermissions();
    await this.credentials.retainOnly(this.settings?.credentialId ?? null);
    if (this.settings) {
      this.settings = { ...this.settings, epoch: this.epoch };
      this.permissionGranted = await this.checkPermission(this.settings.permissionPattern);
      await this.persist();
    }
  }
  private saveMigration(): Promise<void> { return this.api.storage.local.set({ [MIGRATION_KEY]: { version: 1, legacyMigration: this.legacyMigration, cleanupPatterns: this.cleanupPatterns } }); }
  private async cleanupPermissions(): Promise<void> {
    const remaining: string[] = [];
    for (const pattern of this.cleanupPatterns) {
      if (pattern === this.settings?.permissionPattern) continue;
      try {
        await this.api.permissions.remove({ origins: [pattern] });
        if (await this.api.permissions.contains({ origins: [pattern] })) remaining.push(pattern);
      } catch { remaining.push(pattern); }
    }
    this.cleanupPatterns = remaining;
    await this.saveMigration();
  }
  private persist(): Promise<void> { return this.api.storage.local.set({ [INFERENCE_SETTINGS_KEY]: this.settings }); }
  private async checkPermission(pattern: string): Promise<boolean> {
    try { return await this.api.permissions.contains({ origins: [pattern] }) === true; } catch { return false; }
  }
  private async permissionChanged(): Promise<void> {
    // Fence work immediately, even when permission events race a save or a response.
    await this.mutation(async () => {
      if (this.settings) {
        this.permissionGranted = await this.checkPermission(this.settings.permissionPattern);
        this.settings = { ...this.settings, epoch: this.epoch, testedAt: this.permissionGranted ? this.settings.testedAt : null };
        await this.persist();
      }
    });
  }
  addFeatureRetirementHandler(handler: FeatureRetirementHandler): void { this.handlers.add(handler); }
  isFeatureBindingCurrent(binding: ConnectionBinding): boolean {
    return this.pendingMutations === 0 && this.permissionGranted && this.lease !== null && sameConnectionBinding(this.lease.binding, binding);
  }
  async getState(): Promise<InferencePublicState> {
    await this.initialized;
    await this.tail;
    const settings = this.settings;
    const hasKey = settings?.credentialId ? (await this.credentials.get(settings.credentialId, settings.configuration)) !== null : false;
    const granted = settings ? await this.checkPermission(settings.permissionPattern) : false;
    if (this.permissionGranted && !granted) await this.permissionChanged();
    this.permissionGranted = granted;
    const needsKey = settings && PROVIDER_PRESETS.find((preset) => preset.id === settings.configuration.provider)?.requiresKey && !hasKey;
    return Object.freeze({ configured: settings !== null, configuration: settings?.configuration ?? null, hasKey, permissionGranted: granted,
      phase: !settings ? "not_configured" : !granted ? "permission_required" : needsKey ? "key_required" : !settings.testedAt ? "untested" : "ready",
      epoch: this.epoch, testedAt: this.settings?.testedAt ?? null, legacyMigration: this.legacyMigration, permissionCleanupPending: this.cleanupPatterns.length > 0 });
  }
  async save(configuration: unknown, keyAction: "preserve" | "replace" | "remove", apiKey?: unknown): Promise<InferencePublicState> {
    const validated = validateInferenceConfiguration(configuration);
    if (!["preserve", "replace", "remove"].includes(keyAction)
        || (keyAction === "replace" && (typeof apiKey !== "string" || !apiKey || apiKey.length > 4096 || /[\s\u0000-\u001F\u007F]/u.test(apiKey)))
        || (keyAction !== "replace" && apiKey !== undefined)) fail("configuration", "INVALID_KEY_ACTION");
    await this.mutation(async () => {
      const endpoint = canonicalizeInferenceBase(validated.apiBase);
      if (!await this.checkPermission(endpoint.permissionPattern)) fail("permission", "HOST_PERMISSION_REQUIRED");
      const previous = this.settings;
      const sameEndpoint = previous?.configuration.apiBase === validated.apiBase && previous.configuration.provider === validated.provider;
      const credentialId = keyAction === "replace" ? randomId() : keyAction === "preserve" && sameEndpoint ? previous!.credentialId : null;
      if (keyAction === "replace") await this.credentials.put(credentialId!, apiKey as string, validated);
      const next: SavedSettings = { version: 1, configuration: validated, credentialId, revision: randomId(), epoch: this.epoch, testedAt: null, permissionPattern: endpoint.permissionPattern };
      await this.api.storage.local.set({ [INFERENCE_SETTINGS_KEY]: next });
      this.settings = next;
      this.permissionGranted = true;
      await this.credentials.retainOnly(credentialId);
      if (previous && previous.permissionPattern !== endpoint.permissionPattern) {
        this.cleanupPatterns.push(previous.permissionPattern);
        await this.saveMigration();
        await this.cleanupPermissions();
      }
    });
    return this.getState();
  }
  private async activeClient(requireTest: boolean): Promise<ManagedClient> {
    await this.initialized;
    await this.tail;
    if (this.pendingMutations) fail("cancellation", "CONNECTION_CHANGING");
    const generation = this.generation;
    const settings = this.settings;
    if (!settings || (requireTest && !settings.testedAt)) fail("configuration", "CONNECTION_NOT_TESTED");
    if (!await this.checkPermission(settings.permissionPattern)) { await this.permissionChanged(); fail("permission", "HOST_PERMISSION_REQUIRED"); }
    const key = settings.credentialId ? await this.credentials.get(settings.credentialId, settings.configuration) : "";
    if (PROVIDER_PRESETS.find((preset) => preset.id === settings.configuration.provider)?.requiresKey && !key) fail("configuration", "KEY_REQUIRED");
    if (generation !== this.generation || this.pendingMutations) fail("cancellation", "CONNECTION_CHANGED");
    if (this.lease) return this.lease.client as ManagedClient;
    const endpoint = canonicalizeInferenceBase(settings.configuration.apiBase);
    const binding: ConnectionBinding = Object.freeze({ apiBase: endpoint.apiBase, origin: endpoint.origin, permissionId: endpoint.permissionPattern, epoch: this.epoch,
      credential: Object.freeze({ mode: "device_credential", credentialId: settings.revision }) });
    const client = this.createClient(settings.configuration, key ?? "", binding, { permissionCheck: async () => this.isFeatureBindingCurrent(binding) && await this.checkPermission(endpoint.permissionPattern) && this.isFeatureBindingCurrent(binding) });
    this.permissionGranted = true;
    this.lease = Object.freeze({ client, binding });
    return client;
  }
  async acquireFeatureLease(): Promise<BackgroundFeatureLease> {
    const client = await this.activeClient(true);
    const lease = this.lease;
    if (!lease || lease.client !== client || !this.isFeatureBindingCurrent(lease.binding)) fail("cancellation", "CONNECTION_CHANGED");
    return lease;
  }
  private async networkAction<T>(operation: (client: ManagedClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    const client = await this.activeClient(false);
    const generation = this.generation;
    const abort = new AbortController();
    this.operations.add(abort);
    try {
      const result = await operation(client, abort.signal);
      if (generation !== this.generation || abort.signal.aborted || !this.isFeatureBindingCurrent(client.binding)) fail("cancellation", "CONNECTION_CHANGED");
      return result;
    } finally { this.operations.delete(abort); }
  }
  async listModels(draft?: unknown, apiKey?: unknown): Promise<string[]> {
    if (draft === undefined) return this.networkAction((client, signal) => client.listModels({ signal }));
    const input = record(draft);
    if (!input || typeof input.model !== "string") fail("configuration", "INVALID_DISCOVERY_CONFIGURATION");
    // GET /models requires an endpoint, not a selected inference model. This ID is never inferred or saved.
    const configuration = validateInferenceConfiguration({ ...input, model: "thunderclaw-model-discovery" });
    if (!supportsModelDiscovery(configuration.provider)) fail("capability", "MODEL_DISCOVERY_UNAVAILABLE");
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 4096 || /[\s\u0000-\u001F\u007F]/u.test(apiKey))) fail("configuration", "INVALID_DISCOVERY_KEY");
    await this.initialized; await this.tail;
    if (this.pendingMutations) fail("cancellation", "CONNECTION_CHANGING");
    const generation = this.generation;
    const endpoint = canonicalizeInferenceBase(configuration.apiBase);
    if (!await this.checkPermission(endpoint.permissionPattern)) fail("permission", "HOST_PERMISSION_REQUIRED");
    const sameScope = this.settings?.configuration.provider === configuration.provider && this.settings.configuration.apiBase === configuration.apiBase;
    const savedId = sameScope ? this.settings!.credentialId : null;
    const key = apiKey !== undefined ? apiKey as string : savedId ? await this.credentials.get(savedId, configuration) ?? "" : "";
    if (PROVIDER_PRESETS.find((preset) => preset.id === configuration.provider)?.requiresKey && !key) fail("configuration", "KEY_REQUIRED");
    if (generation !== this.generation || this.pendingMutations) fail("cancellation", "CONNECTION_CHANGED");
    const binding: ConnectionBinding = Object.freeze({ apiBase: endpoint.apiBase, origin: endpoint.origin, permissionId: endpoint.permissionPattern, epoch: this.epoch, credential: Object.freeze({ mode: "device_credential", credentialId: randomId() }) });
    const current = () => generation === this.generation && this.pendingMutations === 0;
    const client = this.createClient(configuration, key, binding, { permissionCheck: async () => current() && await this.checkPermission(endpoint.permissionPattern) && current() });
    const abort = new AbortController(); this.operations.add(abort);
    try {
      const models = await client.listModels({ signal: abort.signal });
      if (!current() || abort.signal.aborted) fail("cancellation", "CONNECTION_CHANGED");
      return models;
    } finally { this.operations.delete(abort); }
  }
  async testConnection(): Promise<InferencePublicState> {
    const generation = this.generation;
    await this.networkAction((client, signal) => client.testConnection({ signal }));
    await this.enqueue(async () => {
      if (generation !== this.generation || !this.settings) fail("cancellation", "CONNECTION_CHANGED");
      this.settings = { ...this.settings, testedAt: new Date().toISOString() };
      await this.persist();
    });
    return this.getState();
  }
  async forget(): Promise<InferencePublicState> {
    await this.mutation(async () => {
      const previous = this.settings;
      await this.api.storage.local.remove(INFERENCE_SETTINGS_KEY);
      this.settings = null;
      this.permissionGranted = false;
      await this.credentials.retainOnly(null);
      if (previous) this.cleanupPatterns.push(previous.permissionPattern);
      await this.saveMigration();
      await this.cleanupPermissions();
    });
    return this.getState();
  }
}

export function inferencePublicError(error: unknown): { kind: string; message: string; code?: string } {
  const kind = error instanceof DirectClientError ? error.kind : "storage";
  const safeMessage = error instanceof DirectClientError ? inferenceFailureMessage(error.code) : undefined;
  if (safeMessage && error instanceof DirectClientError) return { kind, code: error.code, message: safeMessage };
  const messages: Record<string, string> = {
    configuration: "Check the endpoint, model, output mode, and API key in settings.", permission: "Grant access to the selected inference endpoint in settings.",
    authentication: "The endpoint did not accept the API key. Replace it in settings.", rate_limit: "The inference server rate limit was reached. Try again later.", timeout: "The inference endpoint timed out.", cancellation: "The action was cancelled because the connection changed.",
    contract: "The model returned an unsupported result. Check its structured output support.", network: "The inference endpoint could not be reached.",
    backend: "The inference endpoint could not complete the request. Try again later.", storage: "ThunderClaw could not save or load local settings.",
  };
  return { kind, message: messages[kind] ?? "The inference request failed. Check the connection settings." };
}

export function installInferenceConnectionController(api: any = browser, options: ControllerOptions = {}): InferenceConnectionController {
  const controller = new InferenceConnectionController(api, options);
  api.runtime.onConnect.addListener((port: any) => {
    if (port.name !== INFERENCE_OPTIONS_PORT_NAME || port.sender?.id !== api.runtime.id || port.sender?.url !== api.runtime.getURL("options.html")) { port.disconnect(); return; }
    let open = true;
    port.onDisconnect?.addListener(() => { open = false; });
    port.onMessage.addListener((message: unknown) => {
      const input = record(message);
      const allowed = input?.method === "save" ? ["requestId", "method", "configuration", "keyAction", "apiKey", "consentAccepted"] : input?.method === "listModels" ? ["requestId", "method", "configuration", "apiKey"] : ["requestId", "method"];
      if (!input || typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.requestId)
          || (input.method === "save" && input.consentAccepted !== true)
          || !["state", "save", "listModels", "test", "forget"].includes(String(input.method)) || Object.keys(input).some((key) => !allowed.includes(key))) { port.disconnect(); return; }
      void (async () => {
        try {
          const value = input.method === "state" ? await controller.getState() : input.method === "save" ? await controller.save(input.configuration, input.keyAction as "preserve" | "replace" | "remove", input.apiKey)
            : input.method === "listModels" ? await controller.listModels(input.configuration, input.apiKey) : input.method === "test" ? await controller.testConnection() : await controller.forget();
          if (open) port.postMessage({ requestId: input.requestId, ok: true, value });
        } catch (error) { if (open) port.postMessage({ requestId: input.requestId, ok: false, error: inferencePublicError(error) }); }
      })();
    });
  });
  return controller;
}
