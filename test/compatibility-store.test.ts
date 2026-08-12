import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AgentProbeResult } from "../packages/openclaw-plugin/src/agents.js";
import {
  COMPATIBILITY_CONTRACT_VERSION,
  COMPATIBILITY_PROBE_VERSION,
  createAgentCompatibilityFingerprint,
  PINNED_OPENCLAW_COMPATIBILITY_VERSION,
  RESTRICTED_EXECUTION_POLICY_VERSION,
} from "../packages/openclaw-plugin/src/compatibility-fingerprint.js";
import { CompatibilityStore, CompatibilityStoreError } from "../packages/openclaw-plugin/src/compatibility-store.js";

async function stateDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "thunderclaw-compatibility-test-"));
}

function evidence(agentId: string, fingerprint: string): AgentProbeResult {
  return {
    agentId,
    configurationFingerprint: fingerprint,
    configuredProvider: "provider",
    configuredModel: "model",
    observedProvider: "provider",
    observedModel: "model",
    testedAt: "2026-08-08T12:00:00.000Z",
    state: "verified",
    checks: {
      credentials: "passed",
      structuredOutput: "passed",
      toolIsolation: "passed",
      cancellation: "passed",
      fallbacks: "not_applicable",
    },
    reason: "This arbitrary caller text is not persisted.",
  };
}

test("compatibility evidence is durable and only current for its exact fingerprint", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const fingerprint = "a".repeat(64);
  let store = CompatibilityStore.open(stateDir, () => Date.parse("2026-08-08T12:00:00.000Z"));
  assert.equal(store.isAvailable, true);
  store.startAttempt("probe-run-1", "main", fingerprint);
  store.finishAttempt("probe-run-1", "main", fingerprint, "completed", evidence("main", fingerprint));
  assert.equal(store.currentResults(new Map([["main", fingerprint]])).get("main")?.state, "verified");
  assert.equal(store.currentResults(new Map([["main", "b".repeat(64)]])).has("main"), false);
  store.close();

  store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, true);
  const restored = store.currentResults(new Map([["main", fingerprint]])).get("main");
  assert.equal(restored?.testedAt, "2026-08-08T12:00:00.000Z");
  assert.equal(restored?.reason, "Restricted execution, structured output, tool isolation, and cancellation checks passed.");
  store.close();
});

test("startup recovers interrupted attempts without manufacturing evidence", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const fingerprint = "c".repeat(64);
  let store = CompatibilityStore.open(stateDir);
  store.startAttempt("probe-interrupted", "main", fingerprint);
  store.close();

  store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, true);
  assert.equal(store.currentResults(new Map([["main", fingerprint]])).size, 0);
  store.close();
  const database = new DatabaseSync(join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT outcome FROM probe_attempts WHERE probe_run_id = ?").get("probe-interrupted") as { outcome: string };
  assert.equal(row.outcome, "restart_interrupted");
  database.close();
});

test("same-process opens share one live store without recovering an active attempt", async (context) => {
  const stateDir = await stateDirectory();
  const otherStateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  context.after(() => rm(otherStateDir, { recursive: true, force: true }));
  const fingerprint = "d".repeat(64);
  const first = CompatibilityStore.open(stateDir);
  first.startAttempt("probe-live-registration", "main", fingerprint);

  const nested = CompatibilityStore.open(join(stateDir, "."));
  assert.equal(nested, first, "the normalized state directory must have one process owner");
  assert.notEqual(
    CompatibilityStore.open(otherStateDir),
    first,
    "different state directories must remain isolated",
  );

  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  let database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    (database.prepare("SELECT outcome FROM probe_attempts WHERE probe_run_id = ?").get("probe-live-registration") as { outcome: string }).outcome,
    "running",
  );
  database.close();

  nested.finishAttempt(
    "probe-live-registration",
    "main",
    fingerprint,
    "completed",
    evidence("main", fingerprint),
  );
  database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(
    (database.prepare("SELECT outcome FROM probe_attempts WHERE probe_run_id = ?").get("probe-live-registration") as { outcome: string }).outcome,
    "completed",
  );
  database.close();
  first.close();
  CompatibilityStore.open(otherStateDir).close();
});

test("same-process nested store open does not interrupt an active probe attempt", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const fingerprint = "d".repeat(64);
  const firstRegistrationStore = CompatibilityStore.open(stateDir);
  assert.equal(firstRegistrationStore.isAvailable, true);
  firstRegistrationStore.startAttempt("probe-same-process-reentry", "main", fingerprint);

  // Models the Gateway loading/registering the plugin again in this process
  // while the first registration's embedded-agent call is still in flight.
  const nestedRegistrationStore = CompatibilityStore.open(stateDir);
  assert.equal(nestedRegistrationStore.isAvailable, true);
  firstRegistrationStore.finishAttempt(
    "probe-same-process-reentry",
    "main",
    fingerprint,
    "completed",
    evidence("main", fingerprint),
  );
  assert.equal(
    nestedRegistrationStore.currentResults(new Map([["main", fingerprint]])).get("main")?.state,
    "verified",
  );
  firstRegistrationStore.close();

  const database = new DatabaseSync(join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite"), { readOnly: true });
  const row = database.prepare("SELECT outcome FROM probe_attempts WHERE probe_run_id = ?")
    .get("probe-same-process-reentry") as { outcome: string };
  assert.equal(row.outcome, "completed");
  database.close();
});

test("a genuinely fresh process recovers a crashed running attempt", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const storeModuleUrl = pathToFileURL(join(process.cwd(), "packages", "openclaw-plugin", "src", "compatibility-store.ts")).href;
  const childEnvironment = {
    PATH: process.env.PATH ?? "",
    NODE_NO_WARNINGS: "1",
  };
  const runChild = (source: string) => execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source, stateDir],
    {
      cwd: process.cwd(),
      env: childEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  runChild(`
    import { CompatibilityStore } from ${JSON.stringify(storeModuleUrl)};
    const store = CompatibilityStore.open(process.argv[1]);
    if (!store.isAvailable) process.exit(2);
    store.startAttempt("probe-real-process-crash", "main", "${"f".repeat(64)}");
    process.exit(0);
  `);
  let database = new DatabaseSync(join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite"), { readOnly: true });
  assert.equal(
    (database.prepare("SELECT outcome FROM probe_attempts WHERE probe_run_id = ?")
      .get("probe-real-process-crash") as { outcome: string }).outcome,
    "running",
    "the crashed process must leave durable running state for recovery",
  );
  database.close();

  runChild(`
    import { CompatibilityStore } from ${JSON.stringify(storeModuleUrl)};
    const store = CompatibilityStore.open(process.argv[1]);
    if (!store.isAvailable) process.exit(2);
    store.close();
  `);
  database = new DatabaseSync(join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite"), { readOnly: true });
  const recovered = database.prepare("SELECT outcome, finished_at_ms FROM probe_attempts WHERE probe_run_id = ?")
    .get("probe-real-process-crash") as { outcome: string; finished_at_ms: number | null };
  assert.equal(recovered.outcome, "restart_interrupted");
  assert.ok(Number.isSafeInteger(recovered.finished_at_ms));
  database.close();
});

test("future schema and unsafe filesystem objects fail closed", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  let store = CompatibilityStore.open(stateDir);
  store.close();
  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE schema_metadata SET version = 999 WHERE singleton = 1").run();
  database.close();
  store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, false);
  assert.throws(
    () => store.currentResults(new Map()),
    (error) => error instanceof CompatibilityStoreError && error.code === "COMPATIBILITY_UNAVAILABLE",
  );

  const unsafeStateDir = await stateDirectory();
  context.after(() => rm(unsafeStateDir, { recursive: true, force: true }));
  const target = await stateDirectory();
  context.after(() => rm(target, { recursive: true, force: true }));
  await symlink(target, join(unsafeStateDir, "plugins"));
  assert.equal(CompatibilityStore.open(unsafeStateDir).isAvailable, false);
});

test("semantically inconsistent persisted evidence fails closed", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const fingerprint = "e".repeat(64);
  let store = CompatibilityStore.open(stateDir);
  store.startAttempt("probe-corrupt-row", "main", fingerprint);
  store.finishAttempt(
    "probe-corrupt-row",
    "main",
    fingerprint,
    "completed",
    evidence("main", fingerprint),
  );
  store.close();

  const database = new DatabaseSync(join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite"));
  database.prepare("UPDATE current_results SET credentials = 'failed' WHERE agent_id = 'main'").run();
  database.close();

  store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, true);
  assert.throws(
    () => store.currentResults(new Map([["main", fingerprint]])),
    (error) => error instanceof CompatibilityStoreError,
  );
  assert.equal(store.isAvailable, false);
});

test("usable evidence requires an exact observed provider and model on write", async (context) => {
  for (const [suffix, mutation] of [
    ["null-provider", { observedProvider: null }],
    ["wrong-provider", { observedProvider: "other-provider" }],
    ["null-model", { observedModel: null }],
    ["wrong-model", { observedModel: "other-model" }],
  ] as const) {
    const stateDir = await stateDirectory();
    context.after(() => rm(stateDir, { recursive: true, force: true }));
    const fingerprint = createHash("sha256").update(suffix).digest("hex");
    const store = CompatibilityStore.open(stateDir);
    const probeRunId = `probe-${suffix}`;
    store.startAttempt(probeRunId, "main", fingerprint);
    assert.throws(
      () => store.finishAttempt(
        probeRunId,
        "main",
        fingerprint,
        "completed",
        { ...evidence("main", fingerprint), ...mutation },
      ),
      (error) => error instanceof CompatibilityStoreError,
      suffix,
    );
    assert.equal(store.isAvailable, false, suffix);
  }
});

test("usable persisted evidence with a missing or mismatched observation fails closed on read", async (context) => {
  for (const [suffix, column, value] of [
    ["null-provider", "observed_provider", null],
    ["wrong-provider", "observed_provider", "other-provider"],
    ["null-model", "observed_model", null],
    ["wrong-model", "observed_model", "other-model"],
  ] as const) {
    const stateDir = await stateDirectory();
    context.after(() => rm(stateDir, { recursive: true, force: true }));
    const fingerprint = createHash("sha256").update(`persisted-${suffix}`).digest("hex");
    let store = CompatibilityStore.open(stateDir);
    const probeRunId = `probe-persisted-${suffix}`;
    store.startAttempt(probeRunId, "main", fingerprint);
    store.finishAttempt(probeRunId, "main", fingerprint, "completed", evidence("main", fingerprint));
    store.close();

    const database = new DatabaseSync(join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite"));
    database.prepare(`UPDATE current_results SET ${column} = ? WHERE agent_id = ? AND fingerprint = ?`)
      .run(value, "main", fingerprint);
    database.close();

    store = CompatibilityStore.open(stateDir);
    assert.equal(store.isAvailable, true, suffix);
    assert.throws(
      () => store.currentResults(new Map([["main", fingerprint]])),
      (error) => error instanceof CompatibilityStoreError,
      suffix,
    );
    assert.equal(store.isAvailable, false, suffix);
  }
});

test("configuration fingerprint changes with primary and ordered fallbacks", () => {
  const makeConfig = (primary: string, fallbacks: string[]) => ({
    agents: {
      defaults: { model: { primary } },
      entries: { main: { default: true, model: { primary, fallbacks } } },
    },
  }) as OpenClawPluginApi["config"];
  const base = createAgentCompatibilityFingerprint(makeConfig("one/model", ["two/a", "three/b"]), "main");
  assert.equal(base.length, 64);
  assert.notEqual(base, createAgentCompatibilityFingerprint(makeConfig("one/changed", ["two/a", "three/b"]), "main"));
  assert.notEqual(base, createAgentCompatibilityFingerprint(makeConfig("one/model", ["three/b", "two/a"]), "main"));
});

test("configuration fingerprint commits every compatibility policy and pinned-runtime input", () => {
  const config = {
    agents: {
      defaults: { model: { primary: "one/model" } },
      entries: { main: { default: true, model: { primary: "one/model", fallbacks: ["two/a", "three/b"] } } },
    },
  } as OpenClawPluginApi["config"];
  const canonical = {
    agentId: "main",
    models: [
      { provider: "one", model: "model" },
      { provider: "two", model: "a" },
      { provider: "three", model: "b" },
    ],
    executionRoutes: [null, null, null],
    restrictedExecutionPolicyVersion: RESTRICTED_EXECUTION_POLICY_VERSION,
    probeVersion: COMPATIBILITY_PROBE_VERSION,
    compatibilityContractVersion: COMPATIBILITY_CONTRACT_VERSION,
    openClawCompatibilityVersion: PINNED_OPENCLAW_COMPATIBILITY_VERSION,
  };
  const expected = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  assert.equal(createAgentCompatibilityFingerprint(config, "main"), expected);
});

test("configuration fingerprint invalidates non-secret provider endpoint, API mode, and transport changes", () => {
  const makeConfig = (
    baseUrl: string,
    api: "openai-completions" | "openai-responses",
    transport: "sse" | "websocket" = "sse",
  ) => ({
    agents: {
      defaults: { model: { primary: "custom/model" } },
      entries: { main: { default: true } },
    },
    models: {
      providers: {
        custom: {
          baseUrl,
          api,
          params: { transport },
          apiKey: { source: "env", provider: "default", id: "SECRET_NOT_FINGERPRINTED" },
          models: [{
            id: "model",
            name: "Model",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 100,
            compat: { supportsTools: false, supportsJsonSchemaResponseFormat: true },
          }],
        },
      },
    },
  }) as OpenClawPluginApi["config"];
  const base = createAgentCompatibilityFingerprint(
    makeConfig("https://provider.example.test/v1", "openai-completions"),
    "main",
  );
  assert.notEqual(
    base,
    createAgentCompatibilityFingerprint(
      makeConfig("https://replacement.example.test/v1", "openai-completions"),
      "main",
    ),
  );
  assert.notEqual(
    base,
    createAgentCompatibilityFingerprint(
      makeConfig("https://provider.example.test/v1", "openai-completions", "websocket"),
      "main",
    ),
  );
  assert.notEqual(
    base,
    createAgentCompatibilityFingerprint(
      makeConfig("https://provider.example.test/v1", "openai-responses"),
      "main",
    ),
  );
  const changedSecretOnly = makeConfig("https://provider.example.test/v1", "openai-completions");
  changedSecretOnly.models!.providers!.custom!.apiKey = {
    source: "env",
    provider: "default",
    id: "DIFFERENT_SECRET_REFERENCE_NOT_FINGERPRINTED",
  };
  assert.equal(base, createAgentCompatibilityFingerprint(changedSecretOnly, "main"));
});

test("corrupt database bytes fail closed without silently replacing the artifact", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  let store = CompatibilityStore.open(stateDir);
  store.close();
  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  const corrupt = Buffer.from("thunderclaw-corrupt-database-canary", "utf8");
  await writeFile(databasePath, corrupt);

  store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, false);
  assert.deepEqual(await readFile(databasePath), corrupt, "opening corruption must not recreate expected state");
});

test("malformed persisted identifier rows fail closed", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const fingerprint = "e".repeat(64);
  let store = CompatibilityStore.open(stateDir);
  store.startAttempt("probe-malformed-identifier", "main", fingerprint);
  store.finishAttempt("probe-malformed-identifier", "main", fingerprint, "completed", evidence("main", fingerprint));
  store.close();

  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA ignore_check_constraints=ON");
  database.prepare("UPDATE current_results SET configured_provider = '' WHERE agent_id = ? AND fingerprint = ?")
    .run("main", fingerprint);
  database.close();

  store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, false, "quick-check or row validation must reject malformed persisted identifiers");
  assert.throws(
    () => store.currentResults(new Map([["main", fingerprint]])),
    (error) => error instanceof CompatibilityStoreError,
  );
});

test("failed evidence commit is atomic and exposes no ephemeral result", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const fingerprint = "1".repeat(64);
  const store = CompatibilityStore.open(stateDir);
  store.startAttempt("probe-atomic", "main", fingerprint);
  const invalid = { ...evidence("main", fingerprint), observedProvider: "x".repeat(129) };
  assert.throws(
    () => store.finishAttempt("probe-atomic", "main", fingerprint, "completed", invalid),
    (error) => error instanceof CompatibilityStoreError,
  );
  assert.equal(store.isAvailable, false);

  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((database.prepare("SELECT count(*) AS count FROM current_results").get() as { count: number }).count, 0);
  assert.equal((database.prepare("SELECT outcome FROM probe_attempts WHERE probe_run_id = 'probe-atomic'").get() as { outcome: string }).outcome, "running");
  database.close();
});

test("a compatibility database missing after initialization fails closed", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  let store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, true);
  store.close();
  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  await unlink(databasePath);

  store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, false, "expected durable state must not be silently recreated after deletion");
});

test("writer contention observes the short wait bound and fails closed", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  const store = CompatibilityStore.open(stateDir);
  assert.equal(store.isAvailable, true);
  const lockHolder = new DatabaseSync(databasePath);
  lockHolder.exec("BEGIN IMMEDIATE");
  const startedAt = Date.now();
  assert.throws(
    () => store.startAttempt("probe-lock-contention", "main", "2".repeat(64)),
    (error) => error instanceof CompatibilityStoreError,
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 150, `lock wait was unexpectedly short: ${elapsed}ms`);
  assert.ok(elapsed < 1_000, `lock wait exceeded the short bound: ${elapsed}ms`);
  assert.equal(store.isAvailable, false);
  lockHolder.exec("ROLLBACK");
  lockHolder.close();
});

test("attempt and result history stay globally and per-agent bounded without persisting caller detail", async (context) => {
  const stateDir = await stateDirectory();
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  let clock = Date.parse("2026-08-08T12:00:00.000Z");
  const store = CompatibilityStore.open(stateDir, () => clock++);
  const callerCanary = "Bearer credential-history-canary@example.test";
  for (let agentIndex = 0; agentIndex < 26; agentIndex += 1) {
    const agentId = `agent-${agentIndex}`;
    for (let attemptIndex = 0; attemptIndex < 21; attemptIndex += 1) {
      const ordinal = agentIndex * 21 + attemptIndex + 1;
      const fingerprint = ordinal.toString(16).padStart(64, "0");
      const probeRunId = `probe-${agentIndex}-${attemptIndex}`;
      store.startAttempt(probeRunId, agentId, fingerprint);
      store.finishAttempt(probeRunId, agentId, fingerprint, "completed", {
        ...evidence(agentId, fingerprint),
        testedAt: new Date(clock).toISOString(),
        reason: callerCanary,
      });
    }
  }
  store.close();

  const databasePath = join(stateDir, "plugins", "thunderclaw", "compatibility.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const attempts = database.prepare("SELECT count(*) AS count FROM probe_attempts").get() as { count: number };
  const maximumAttempts = database.prepare("SELECT max(count) AS count FROM (SELECT count(*) AS count FROM probe_attempts GROUP BY agent_id)").get() as { count: number };
  const results = database.prepare("SELECT count(*) AS count FROM current_results").get() as { count: number };
  const maximumResults = database.prepare("SELECT max(count) AS count FROM (SELECT count(*) AS count FROM current_results GROUP BY agent_id)").get() as { count: number };
  database.close();
  assert.equal(attempts.count, 500);
  assert.equal(maximumAttempts.count, 20);
  assert.ok(results.count <= 200);
  assert.equal(maximumResults.count, 4);
  assert.equal((await readFile(databasePath)).includes(Buffer.from(callerCanary, "utf8")), false);
});
