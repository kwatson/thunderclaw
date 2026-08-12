import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfiguredFallbacks } from "../packages/openclaw-plugin/src/agents.js";
import { createAgentRunnerWithFallbacks } from "../packages/openclaw-plugin/src/fallback.js";

type RunAgent = OpenClawPluginApi["runtime"]["agent"]["runEmbeddedAgent"];
type RunParams = Parameters<RunAgent>[0];

const config = {
  agents: {
    defaults: { model: { primary: "capture/unavailable" } },
    entries: {
      main: {
        default: true,
        model: {
          primary: "capture/unavailable",
          fallbacks: ["deepseek/deepseek-v4-pro"],
        },
      },
    },
  },
} as OpenClawPluginApi["config"];

const baseParams = {
  agentId: "main",
  sessionId: "thunderclaw:test-session",
  sessionKey: "thunderclaw:test-session:key",
  sessionManager: {},
  workspaceDir: "/tmp/synthetic-workspace",
  config,
  runId: "test-run",
  prompt: "synthetic prompt",
  promptMode: "full",
  disableTools: true,
  disableTrajectory: true,
  timeoutMs: 1000,
} as RunParams;

test("resolves configured per-agent fallback refs", () => {
  assert.deepEqual(resolveConfiguredFallbacks(config, "main"), [
    "deepseek/deepseek-v4-pro",
  ]);
});

test("runner retries a failed primary with the configured fallback", async () => {
  const calls: RunParams[] = [];
  const sessionManager = {} as RunParams["sessionManager"];
  const runAgent = createAgentRunnerWithFallbacks({
    runAgent: async (params) => {
      calls.push(params);
      if (calls.length === 1) throw new Error("synthetic primary failure");
      return {
        payloads: [],
        meta: {
          durationMs: 1,
          agentMeta: { provider: "deepseek", model: "deepseek-v4-pro" },
        },
      } as never;
    },
  });

  const result = await runAgent({ ...baseParams, sessionManager });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.modelFallbacksOverride?.length, 0);
  assert.equal(calls[1]?.provider, "deepseek");
  assert.equal(calls[1]?.model, "deepseek-v4-pro");
  assert.equal(calls[1]?.runId, "test-run:fallback-1");
  assert.equal(calls[1]?.sessionId, baseParams.sessionId);
  assert.equal(calls[1]?.sessionManager, sessionManager);
  assert.equal(result.meta.executionTrace?.fallbackUsed, true);
  assert.equal(result.meta.executionTrace?.winnerProvider, "deepseek");
});

test("runner does not enter a fallback after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const runAgent = createAgentRunnerWithFallbacks({
    runAgent: async () => {
      calls += 1;
      controller.abort();
      throw new Error("synthetic cancellation");
    },
  });

  await assert.rejects(() => runAgent({
    ...baseParams,
    abortSignal: controller.signal,
  }));
  assert.equal(calls, 1);
});

test("runner resolves fallbacks only from the operation config snapshot", async () => {
  const replacementConfig = {
    agents: {
      defaults: { model: { primary: "replacement/primary" } },
      entries: {
        main: {
          default: true,
          model: {
            primary: "replacement/primary",
            fallbacks: ["replacement/fallback"],
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
  const calls: RunParams[] = [];
  const runAgent = createAgentRunnerWithFallbacks({
    runAgent: async (params) => {
      calls.push(params);
      assert.equal(params.config, replacementConfig);
      if (calls.length === 1) throw new Error("synthetic primary failure");
      return { payloads: [], meta: { durationMs: 1 } } as never;
    },
  });
  await runAgent({ ...baseParams, config: replacementConfig });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.provider, "replacement");
  assert.equal(calls[1]?.model, "fallback");
});
