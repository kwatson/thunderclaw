import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { discoverThunderClawAgents } from "./src/agents.js";
import { CompatibilityStore } from "./src/compatibility-store.js";
import { createAgentRunnerWithFallbacks } from "./src/fallback.js";
import { runAgentCompatibilityProbe } from "./src/probe.js";
import { createThunderClawRoute, getProcessRouteOperationalState } from "./src/route.js";
import { registerPairingAdministration } from "./src/pairing-admin.js";
import { PairingRegistry } from "./src/pairing-registry.js";
import { createDeviceAuthenticator, createPairingRoute } from "./src/pairing-route.js";
import { registerThunderClawCliMetadata } from "./src/pairing-cli-registration.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "thunderclaw",
  name: "ThunderClaw",
  description: "Secure Thunderbird email transformations with paired-device access",
  register(api) {
    if (api.registrationMode === "cli-metadata" || api.registrationMode === "discovery" || api.registrationMode === "full") {
      registerThunderClawCliMetadata(api);
    }
    if (api.registrationMode !== "full") return;

    const pluginConfig = api.pluginConfig ?? {};

    const runEmbeddedAgent = (params: Parameters<typeof api.runtime.agent.runEmbeddedAgent>[0]) =>
      api.runtime.agent.runEmbeddedAgent(params);
    const runAgent = createAgentRunnerWithFallbacks({
      runAgent: runEmbeddedAgent,
    });
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const compatibilityStore = CompatibilityStore.open(stateDir);
    const pairingRegistry = PairingRegistry.open(stateDir);
    const operationalState = getProcessRouteOperationalState(stateDir);

    api.registerHttpRoute({
      path: "/thunderclaw/pairing/v1",
      auth: "plugin",
      match: "prefix",
      handler: createPairingRoute({ registry: pairingRegistry }),
    });

    api.registerHttpRoute({
      path: "/thunderclaw/v1",
      auth: "plugin",
      match: "prefix",
      handler: createThunderClawRoute({
        authenticateDevice: createDeviceAuthenticator(pairingRegistry),
        runtimeVersion: api.runtime.version,
        getConfig: () => api.runtime.config.current() as OpenClawPluginApi["config"],
        sessionTtlMs:
          typeof pluginConfig.sessionTtlMs === "number" ? pluginConfig.sessionTtlMs : 30 * 60_000,
        maxRequestBytes:
          typeof pluginConfig.maxRequestBytes === "number" ? pluginConfig.maxRequestBytes : 256_000,
        listAgents: (config, probeResults) =>
          discoverThunderClawAgents(config, api.runtime.agent, probeResults),
        compatibilityStore,
        operationalState,
        probeAgent: (config, agentId, configurationFingerprint, abortSignal) =>
          runAgentCompatibilityProbe({
            agentId,
            configurationFingerprint,
            config,
            createSessionManager: () => SessionManager.inMemory(),
            resolveWorkspaceDir: (selectedAgentId) =>
              api.runtime.agent.resolveAgentWorkspaceDir(config, selectedAgentId),
            runAgent: runEmbeddedAgent,
            abortSignal,
          }),
        createSessionManager: () => SessionManager.inMemory(),
        resolveWorkspaceDir: (config, agentId) =>
          api.runtime.agent.resolveAgentWorkspaceDir(config, agentId),
        runAgent,
      }),
    });
    registerPairingAdministration(api, pairingRegistry);
  },
});

export default plugin;
