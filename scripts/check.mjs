import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function checkCommands(scope = "all") {
  if (scope === "site") return [["run", "build:site"]];
  const commands = [["test"], ["run", "typecheck"]];
  if (scope === "internal") return commands;
  if (scope !== "all") throw new Error("Scope must be all, internal, or site");
  return [...commands, ["run", "build:extension"], ["run", "pack:source"], ["run", "build:site"]];
}

export function runChecks(scope = "all", run = (args) => spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "inherit", shell: process.platform === "win32" }).status) {
  for (const args of checkCommands(scope)) {
    const status = run(args);
    if (status !== 0) throw new Error(`npm ${args.join(" ")} failed${status === null ? " to start" : ` (exit ${status})`}`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write("Usage: npm run check -- [--scope all|internal|site]\nall: tests, types, extension, reviewer source, site (default)\ninternal: tests and types\nsite: site build\n");
    } else {
    if (args.length && (args.length !== 2 || args[0] !== "--scope")) throw new Error("Usage: npm run check -- [--scope all|internal|site]");
    runChecks(args[1]);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
