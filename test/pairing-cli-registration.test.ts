import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import plugin from "../packages/openclaw-plugin/index.js";
import {
  registerThunderClawCliMetadata,
  THUNDERCLAW_CLI_DESCRIPTOR,
} from "../packages/openclaw-plugin/src/pairing-cli-registration.js";

test("CLI descriptor owns exactly the lazy thunderclaw root and detects JSON output purely", async () => {
  let registrar: Parameters<OpenClawPluginApi["registerCli"]>[0] | undefined;
  let options: Parameters<OpenClawPluginApi["registerCli"]>[1];
  registerThunderClawCliMetadata({
    registerCli: (
      value: Parameters<OpenClawPluginApi["registerCli"]>[0],
      valueOptions?: Parameters<OpenClawPluginApi["registerCli"]>[1],
    ) => { registrar = value; options = valueOptions; },
  } as unknown as OpenClawPluginApi);
  assert.equal(typeof registrar, "function");
  assert.deepEqual(options, { descriptors: [THUNDERCLAW_CLI_DESCRIPTOR] });
  assert.deepEqual(
    { name: THUNDERCLAW_CLI_DESCRIPTOR.name, description: THUNDERCLAW_CLI_DESCRIPTOR.description, hasSubcommands: THUNDERCLAW_CLI_DESCRIPTOR.hasSubcommands },
    { name: "thunderclaw", description: "Manage ThunderClaw Thunderbird connections", hasSubcommands: true },
  );
  assert.equal(THUNDERCLAW_CLI_DESCRIPTOR.machineOutput({ argv: ["node", "openclaw", "thunderclaw", "status", "--json"], stdoutIsTTY: true }), true);
  assert.equal(THUNDERCLAW_CLI_DESCRIPTOR.machineOutput({ argv: ["node", "openclaw", "--profile", "thunderclaw", "status", "--json"], stdoutIsTTY: true }), false);
  assert.equal(THUNDERCLAW_CLI_DESCRIPTOR.machineOutput({ argv: ["node", "openclaw", "--profile", "test", "thunderclaw", "status", "--json"], stdoutIsTTY: true }), true);
  assert.equal(THUNDERCLAW_CLI_DESCRIPTOR.machineOutput({ argv: ["node", "openclaw", "--no-color", "thunderclaw", "status"], stdoutIsTTY: false }), false);
  assert.equal(THUNDERCLAW_CLI_DESCRIPTOR.machineOutput({ argv: ["node", "openclaw", "thunderclaw", "--", "--json"], stdoutIsTTY: false }), false);

  const program = new Command();
  await registrar?.({ program: program as never, parentPath: [], config: {}, logger: {} } as never);
  const root = program.commands.find((command) => command.name() === "thunderclaw");
  assert.ok(root);
  assert.deepEqual(root.commands.map((command) => command.name()), ["status", "requests", "devices"]);
  const approve = root.commands.find((command) => command.name() === "requests")?.commands
    .find((command) => command.name() === "approve");
  assert.ok(approve);
  const approveOptions = (approve as unknown as { options: Array<{ long: string }> }).options;
  const rootOptions = (root as unknown as { options: Array<{ long: string }> }).options;
  assert.deepEqual(approveOptions.map((option) => option.long), ["--code-stdin", "--yes", "--json"]);
  assert.equal(approveOptions.some((option) => option.long === "--code"), false);
  assert.equal(rootOptions.some((option) => option.long === "--url" || option.long === "--token" || option.long === "--password"), false);
  assert.match(approve.helpInformation(), /approve \[options\] <request-id>/u);
  const deny = root.commands.find((command) => command.name() === "requests")?.commands
    .find((command) => command.name() === "deny");
  const revoke = root.commands.find((command) => command.name() === "devices")?.commands
    .find((command) => command.name() === "revoke");
  assert.match(deny?.helpInformation() ?? "", /deny \[options\] <request-id>/u);
  assert.match(revoke?.helpInformation() ?? "", /revoke \[options\] <credential-id>/u);
});

test("cli-metadata registration is inert beyond the lazy descriptor", () => {
  let registrations = 0;
  const api = {
    registrationMode: "cli-metadata",
    registerCli: () => { registrations += 1; },
  } as unknown as OpenClawPluginApi;
  plugin.register?.(api);
  assert.equal(registrations, 1);
});

test("every pinned registration mode exposes only its allowed ThunderClaw surfaces", async (context) => {
  const stateDir = await mkdtemp(join(tmpdir(), "thunderclaw-registration-modes-"));
  context.after(() => rm(stateDir, { recursive: true, force: true }));
  const modes = ["full", "discovery", "tool-discovery", "setup-only", "setup-runtime", "cli-metadata"] as const;
  for (const registrationMode of modes) {
    const calls = { cli: 0, state: 0, routes: 0, gateway: 0, agent: 0, config: 0 };
    const api = {
      registrationMode,
      pluginConfig: {},
      registerCli: () => { calls.cli += 1; },
      registerHttpRoute: () => { calls.routes += 1; },
      registerGatewayMethod: () => { calls.gateway += 1; },
      runtime: {
        version: "test",
        state: { resolveStateDir: () => { calls.state += 1; return "/must-not-open"; } },
        config: { current: () => { calls.config += 1; return {}; } },
        agent: new Proxy({}, { get() { calls.agent += 1; throw new Error("agent runtime touched"); } }),
      },
    } as unknown as OpenClawPluginApi;
    if (registrationMode === "full") {
      (api.runtime.state as { resolveStateDir(): string }).resolveStateDir = () => { calls.state += 1; return stateDir; };
      plugin.register?.(api);
      assert.deepEqual(calls, { cli: 1, state: 1, routes: 2, gateway: 6, agent: 0, config: 0 });
    } else {
      plugin.register?.(api);
      assert.deepEqual(calls, {
        cli: registrationMode === "cli-metadata" || registrationMode === "discovery" ? 1 : 0,
        state: 0, routes: 0, gateway: 0, agent: 0, config: 0,
      });
    }
  }
});
