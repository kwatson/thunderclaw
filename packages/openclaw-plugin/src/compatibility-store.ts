import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { AgentProbeResult } from "./agents.js";

const SCHEMA_VERSION = 1;
const MAX_ATTEMPTS_PER_AGENT = 20;
const MAX_ATTEMPTS_TOTAL = 500;
const MAX_RESULTS_PER_AGENT = 4;
const MAX_RESULTS_TOTAL = 200;
const INITIALIZATION_MARKER = "thunderclaw-compatibility-schema-1\n";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const PROCESS_STORE_REGISTRY = Symbol.for("thunderclaw.compatibility-store.registry.v1");

function processStoreRegistry(): Map<string, CompatibilityStore> {
  const processGlobal = globalThis as unknown as {
    [key: symbol]: Map<string, CompatibilityStore> | undefined;
  };
  const existing = processGlobal[PROCESS_STORE_REGISTRY];
  if (existing instanceof Map) return existing;
  const created = new Map<string, CompatibilityStore>();
  processGlobal[PROCESS_STORE_REGISTRY] = created;
  return created;
}

function validIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && !/[\u0000-\u001F\u007F]/u.test(value);
}

export type CompatibilityAttemptOutcome =
  | "completed"
  | "cancelled"
  | "deadline"
  | "runtime_error"
  | "superseded"
  | "restart_interrupted";

export class CompatibilityStoreError extends Error {
  readonly code = "COMPATIBILITY_UNAVAILABLE";

  constructor() {
    super("compatibility evidence is unavailable");
  }
}

export class CompatibilityAttemptExistsError extends Error {
  readonly code = "PROBE_RUN_REUSED";

  constructor() {
    super("probe run identity was already used");
  }
}

type ResultRow = {
  agent_id: string;
  fingerprint: string;
  configured_provider: string;
  configured_model: string;
  observed_provider: string | null;
  observed_model: string | null;
  tested_at_ms: number;
  state: AgentProbeResult["state"];
  credentials: AgentProbeResult["checks"]["credentials"];
  structured_output: AgentProbeResult["checks"]["structuredOutput"];
  tool_isolation: AgentProbeResult["checks"]["toolIsolation"];
  cancellation: AgentProbeResult["checks"]["cancellation"];
  fallbacks: AgentProbeResult["checks"]["fallbacks"];
  reason_code: string;
};

function safeObject(path: string, kind: "directory" | "file"): boolean {
  const stat = lstatSync(path);
  return kind === "directory"
    ? stat.isDirectory() && !stat.isSymbolicLink()
    : stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
}

function safeObjectExists(path: string, kind: "directory" | "file"): boolean {
  try {
    if (!safeObject(path, kind)) throw new Error("unsafe filesystem object");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ensureDirectory(path: string, privateMode: boolean): void {
  try {
    if (!safeObject(path, "directory")) throw new Error("unsafe directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  if (privateMode && process.platform !== "win32") chmodSync(path, 0o700);
}

function ensurePrivateDatabaseFiles(databasePath: string): void {
  if (process.platform === "win32") return;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

function fixedReason(code: string): string {
  switch (code) {
    case "core_passed":
      return "Restricted execution, structured output, tool isolation, and cancellation checks passed.";
    case "fallbacks_not_run":
      return "Core checks passed, but the configured fallback chain has not been exercised.";
    case "restricted_check_failed":
      return "One or more restricted compatibility checks failed.";
    default:
      throw new CompatibilityStoreError();
  }
}

function reasonCode(result: AgentProbeResult): string {
  if (result.state === "verified") return "core_passed";
  if (result.state === "partially_verified") return "fallbacks_not_run";
  return "restricted_check_failed";
}

function assertBounded(value: string | null, maximum: number): void {
  if (
    value !== null &&
    (value.length < 1 || value.length > maximum || /[\u0000-\u001F\u007F]/u.test(value))
  ) throw new CompatibilityStoreError();
}

function validateEvidenceForWrite(result: AgentProbeResult): void {
  if (!validIdentifier(result.agentId) || !HASH_PATTERN.test(result.configurationFingerprint)) {
    throw new CompatibilityStoreError();
  }
  assertBounded(result.configuredProvider, 128);
  assertBounded(result.configuredModel, 256);
  assertBounded(result.observedProvider, 128);
  assertBounded(result.observedModel, 256);
  const required = [
    result.checks.credentials,
    result.checks.structuredOutput,
    result.checks.toolIsolation,
    result.checks.cancellation,
  ];
  if (required.some((check) => check !== "passed" && check !== "failed")) {
    throw new CompatibilityStoreError();
  }
  const failed = required.includes("failed") || result.checks.fallbacks === "failed";
  const expectedState = failed
    ? "incompatible"
    : result.checks.fallbacks === "not_run"
      ? "partially_verified"
      : "verified";
  if (result.state !== expectedState) throw new CompatibilityStoreError();
  if (
    result.state !== "incompatible" &&
    (result.observedProvider !== result.configuredProvider ||
      result.observedModel !== result.configuredModel)
  ) {
    throw new CompatibilityStoreError();
  }
}

function validateResultRow(row: ResultRow): AgentProbeResult {
  if (!validIdentifier(row.agent_id) || !HASH_PATTERN.test(row.fingerprint)) {
    throw new CompatibilityStoreError();
  }
  assertBounded(row.configured_provider, 128);
  assertBounded(row.configured_model, 256);
  assertBounded(row.observed_provider, 128);
  assertBounded(row.observed_model, 256);
  if (!Number.isSafeInteger(row.tested_at_ms) || row.tested_at_ms < 0) {
    throw new CompatibilityStoreError();
  }
  if (!["verified", "partially_verified", "incompatible"].includes(row.state)) {
    throw new CompatibilityStoreError();
  }
  const requiredChecks = [row.credentials, row.structured_output, row.tool_isolation, row.cancellation];
  if (requiredChecks.some((check) => check !== "passed" && check !== "failed")) {
    throw new CompatibilityStoreError();
  }
  if (!["passed", "failed", "not_run", "not_applicable"].includes(row.fallbacks)) {
    throw new CompatibilityStoreError();
  }
  const result: AgentProbeResult = {
    agentId: row.agent_id,
    configurationFingerprint: row.fingerprint,
    configuredProvider: row.configured_provider,
    configuredModel: row.configured_model,
    observedProvider: row.observed_provider,
    observedModel: row.observed_model,
    testedAt: new Date(row.tested_at_ms).toISOString(),
    state: row.state,
    checks: {
      credentials: row.credentials,
      structuredOutput: row.structured_output,
      toolIsolation: row.tool_isolation,
      cancellation: row.cancellation,
      fallbacks: row.fallbacks,
    },
    reason: fixedReason(row.reason_code),
  };
  validateEvidenceForWrite(result);
  if (reasonCode(result) !== row.reason_code) throw new CompatibilityStoreError();
  return result;
}

function initializeDatabase(database: DatabaseSync, created: boolean, now: number): void {
  database.exec("PRAGMA busy_timeout=250");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA trusted_schema=OFF");
  const quickCheck = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (!quickCheck || Object.values(quickCheck)[0] !== "ok") throw new CompatibilityStoreError();

  if (created) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(`
        CREATE TABLE schema_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
        ) STRICT;
        CREATE TABLE probe_attempts (
          probe_run_id TEXT PRIMARY KEY CHECK (length(probe_run_id) BETWEEN 1 AND 128),
          agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
          fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
          started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
          finished_at_ms INTEGER CHECK (finished_at_ms IS NULL OR finished_at_ms >= started_at_ms),
          outcome TEXT NOT NULL CHECK (outcome IN ('running','completed','cancelled','deadline','runtime_error','superseded','restart_interrupted'))
        ) STRICT;
        CREATE INDEX probe_attempts_agent_started ON probe_attempts(agent_id, started_at_ms DESC);
        CREATE TABLE current_results (
          agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
          fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
          configured_provider TEXT NOT NULL CHECK (length(configured_provider) BETWEEN 1 AND 128),
          configured_model TEXT NOT NULL CHECK (length(configured_model) BETWEEN 1 AND 256),
          observed_provider TEXT CHECK (observed_provider IS NULL OR length(observed_provider) BETWEEN 1 AND 128),
          observed_model TEXT CHECK (observed_model IS NULL OR length(observed_model) BETWEEN 1 AND 256),
          tested_at_ms INTEGER NOT NULL CHECK (tested_at_ms >= 0),
          state TEXT NOT NULL CHECK (state IN ('verified','partially_verified','incompatible')),
          credentials TEXT NOT NULL CHECK (credentials IN ('passed','failed')),
          structured_output TEXT NOT NULL CHECK (structured_output IN ('passed','failed')),
          tool_isolation TEXT NOT NULL CHECK (tool_isolation IN ('passed','failed')),
          cancellation TEXT NOT NULL CHECK (cancellation IN ('passed','failed')),
          fallbacks TEXT NOT NULL CHECK (fallbacks IN ('passed','failed','not_run','not_applicable')),
          reason_code TEXT NOT NULL CHECK (reason_code IN ('core_passed','fallbacks_not_run','restricted_check_failed')),
          PRIMARY KEY (agent_id, fingerprint)
        ) STRICT;
        CREATE INDEX current_results_tested ON current_results(tested_at_ms DESC);
      `);
      database.prepare("INSERT INTO schema_metadata(singleton, version, created_at_ms) VALUES (1, ?, ?)")
        .run(SCHEMA_VERSION, now);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } else {
    const metadata = database.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").get() as
      | { version: number }
      | undefined;
    if (!metadata || metadata.version !== SCHEMA_VERSION) throw new CompatibilityStoreError();
  }
  const journalMode = database.prepare("PRAGMA journal_mode=WAL").get() as Record<string, unknown> | undefined;
  if (!journalMode || Object.values(journalMode)[0] !== "wal") throw new CompatibilityStoreError();
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA secure_delete=ON");
  database.exec("PRAGMA journal_size_limit=1048576");
  database.exec("PRAGMA wal_autocheckpoint=100");
  database.prepare("UPDATE probe_attempts SET outcome = 'restart_interrupted', finished_at_ms = ? WHERE outcome = 'running'")
    .run(now);
}

export class CompatibilityStore {
  private available: boolean;
  private database: DatabaseSync | null;
  private readonly now: () => number;
  private readonly registryKey: string;

  private constructor(database: DatabaseSync | null, now: () => number, registryKey: string) {
    this.database = database;
    this.available = database !== null;
    this.now = now;
    this.registryKey = registryKey;
  }

  static open(stateDir: string, now: () => number = Date.now): CompatibilityStore {
    const registryKey = resolve(stateDir);
    const registry = processStoreRegistry();
    const processOwned = registry.get(registryKey);
    if (processOwned) return processOwned;
    let database: DatabaseSync | null = null;
    let store: CompatibilityStore;
    try {
      if (!safeObject(registryKey, "directory")) throw new Error("unsafe state directory");
      const pluginsDir = join(registryKey, "plugins");
      ensureDirectory(pluginsDir, false);
      const pluginDir = join(pluginsDir, "thunderclaw");
      ensureDirectory(pluginDir, true);
      const databasePath = join(pluginDir, "compatibility.sqlite");
      const markerPath = join(pluginsDir, "thunderclaw.compatibility.initialized");
      const databaseExists = safeObjectExists(databasePath, "file");
      const markerExists = safeObjectExists(markerPath, "file");
      if (databaseExists !== markerExists) throw new CompatibilityStoreError();
      if (markerExists) {
        if (readFileSync(markerPath, "utf8") !== INITIALIZATION_MARKER) {
          throw new CompatibilityStoreError();
        }
        if (process.platform !== "win32") chmodSync(markerPath, 0o600);
      }
      const created = !databaseExists;
      database = new DatabaseSync(databasePath);
      if (!safeObject(databasePath, "file")) throw new CompatibilityStoreError();
      ensurePrivateDatabaseFiles(databasePath);
      initializeDatabase(database, created, now());
      ensurePrivateDatabaseFiles(databasePath);
      if (created) {
        writeFileSync(markerPath, INITIALIZATION_MARKER, { encoding: "utf8", flag: "wx", mode: 0o600 });
        if (!safeObject(markerPath, "file")) throw new CompatibilityStoreError();
      }
      store = new CompatibilityStore(database, now, registryKey);
    } catch {
      try { database?.close(); } catch { /* fail closed */ }
      store = new CompatibilityStore(null, now, registryKey);
    }
    registry.set(registryKey, store);
    return store;
  }

  get isAvailable(): boolean {
    return this.available;
  }

  private use<T>(operation: (database: DatabaseSync) => T): T {
    if (!this.available || !this.database) throw new CompatibilityStoreError();
    try {
      return operation(this.database);
    } catch (error) {
      if (error instanceof CompatibilityAttemptExistsError) throw error;
      this.available = false;
      try { this.database.close(); } catch { /* fail closed */ }
      this.database = null;
      if (error instanceof CompatibilityStoreError) throw error;
      throw new CompatibilityStoreError();
    }
  }

  currentResults(fingerprints: ReadonlyMap<string, string>): ReadonlyMap<string, AgentProbeResult> {
    return this.use((database) => {
      const rows = database.prepare("SELECT * FROM current_results ORDER BY tested_at_ms DESC LIMIT ?")
        .all(MAX_RESULTS_TOTAL + 1) as unknown as ResultRow[];
      if (rows.length > MAX_RESULTS_TOTAL) throw new CompatibilityStoreError();
      const results = new Map<string, AgentProbeResult>();
      for (const row of rows) {
        const result = validateResultRow(row);
        if (fingerprints.get(result.agentId) === result.configurationFingerprint && !results.has(result.agentId)) {
          results.set(result.agentId, result);
        }
      }
      return results;
    });
  }

  startAttempt(probeRunId: string, agentId: string, fingerprint: string): void {
    if (!validIdentifier(probeRunId) || !validIdentifier(agentId) || !HASH_PATTERN.test(fingerprint)) {
      throw new CompatibilityStoreError();
    }
    this.use((database) => {
      if (database.prepare("SELECT 1 AS present FROM probe_attempts WHERE probe_run_id = ?").get(probeRunId)) {
        throw new CompatibilityAttemptExistsError();
      }
      database.prepare("INSERT INTO probe_attempts(probe_run_id, agent_id, fingerprint, started_at_ms, outcome) VALUES (?, ?, ?, ?, 'running')")
        .run(probeRunId, agentId, fingerprint, this.now());
    });
  }

  finishAttempt(
    probeRunId: string,
    agentId: string,
    fingerprint: string,
    outcome: CompatibilityAttemptOutcome,
    result?: AgentProbeResult,
  ): void {
    this.use((database) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const updated = database.prepare(`
          UPDATE probe_attempts SET outcome = ?, finished_at_ms = ?
          WHERE probe_run_id = ? AND agent_id = ? AND fingerprint = ? AND outcome = 'running'
        `).run(outcome, this.now(), probeRunId, agentId, fingerprint);
        if (updated.changes !== 1) throw new CompatibilityStoreError();
        if (outcome === "completed") {
          if (!result || result.agentId !== agentId || result.configurationFingerprint !== fingerprint) {
            throw new CompatibilityStoreError();
          }
          validateEvidenceForWrite(result);
          const testedAt = Date.parse(result.testedAt);
          if (!Number.isSafeInteger(testedAt) || testedAt < 0) throw new CompatibilityStoreError();
          database.prepare(`
            INSERT INTO current_results(
              agent_id, fingerprint, configured_provider, configured_model,
              observed_provider, observed_model, tested_at_ms, state, credentials,
              structured_output, tool_isolation, cancellation, fallbacks, reason_code
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(agent_id, fingerprint) DO UPDATE SET
              configured_provider=excluded.configured_provider,
              configured_model=excluded.configured_model,
              observed_provider=excluded.observed_provider,
              observed_model=excluded.observed_model,
              tested_at_ms=excluded.tested_at_ms,
              state=excluded.state,
              credentials=excluded.credentials,
              structured_output=excluded.structured_output,
              tool_isolation=excluded.tool_isolation,
              cancellation=excluded.cancellation,
              fallbacks=excluded.fallbacks,
              reason_code=excluded.reason_code
          `).run(
            agentId, fingerprint, result.configuredProvider, result.configuredModel,
            result.observedProvider, result.observedModel, testedAt, result.state,
            result.checks.credentials, result.checks.structuredOutput,
            result.checks.toolIsolation, result.checks.cancellation,
            result.checks.fallbacks, reasonCode(result),
          );
        }
        this.prune(database, agentId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  private prune(database: DatabaseSync, agentId: string): void {
    const statements: Array<[StatementSync, Array<string | number | null>]> = [
      [database.prepare("DELETE FROM probe_attempts WHERE probe_run_id IN (SELECT probe_run_id FROM probe_attempts WHERE agent_id = ? AND outcome <> 'running' ORDER BY started_at_ms DESC LIMIT -1 OFFSET ?)"), [agentId, MAX_ATTEMPTS_PER_AGENT]],
      [database.prepare("DELETE FROM probe_attempts WHERE probe_run_id IN (SELECT probe_run_id FROM probe_attempts WHERE outcome <> 'running' ORDER BY started_at_ms DESC LIMIT -1 OFFSET ?)"), [MAX_ATTEMPTS_TOTAL]],
      [database.prepare("DELETE FROM current_results WHERE rowid IN (SELECT rowid FROM current_results WHERE agent_id = ? ORDER BY tested_at_ms DESC LIMIT -1 OFFSET ?)"), [agentId, MAX_RESULTS_PER_AGENT]],
      [database.prepare("DELETE FROM current_results WHERE rowid IN (SELECT rowid FROM current_results ORDER BY tested_at_ms DESC LIMIT -1 OFFSET ?)"), [MAX_RESULTS_TOTAL]],
    ];
    for (const [statement, parameters] of statements) statement.run(...parameters);
  }

  close(): void {
    try { this.database?.close(); } finally {
      this.database = null;
      this.available = false;
      const registry = processStoreRegistry();
      if (registry.get(this.registryKey) === this) registry.delete(this.registryKey);
    }
  }
}
