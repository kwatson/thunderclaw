import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";

export const THUNDERCLAW_CLI_DESCRIPTOR = {
  name: "thunderclaw",
  description: "Manage ThunderClaw Thunderbird connections",
  hasSubcommands: true,
  machineOutput: ({ argv }: { argv: readonly string[]; stdoutIsTTY: boolean }) => {
    if (getRootOptionAwareCommandPath(argv, 1)[0] !== "thunderclaw") return false;
    for (const argument of argv.slice(2)) {
      if (argument === "--") return false;
      if (argument === "--json") return true;
    }
    return false;
  },
} as const;

export function registerThunderClawCliMetadata(api: OpenClawPluginApi): void {
  api.registerCli(async ({ program }) => {
    const { registerThunderClawCli } = await import("./pairing-cli.js");
    registerThunderClawCli(program);
  }, { descriptors: [THUNDERCLAW_CLI_DESCRIPTOR] });
}
