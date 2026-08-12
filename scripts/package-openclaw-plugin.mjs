import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "build");
await mkdir(outputRoot, { recursive: true });

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("pack:plugin must run through npm");
const packed = JSON.parse(execFileSync(process.execPath, [
  npmCli,
  "pack",
  "--workspace",
  "@thunderclaw/openclaw-plugin",
  "--pack-destination",
  outputRoot,
  "--json",
], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
const filename = packed[0]?.filename;
if (typeof filename !== "string" || path.basename(filename) !== filename || !filename.endsWith(".tgz")) {
  throw new Error("npm pack did not return one safe plugin archive filename");
}

const archive = path.join(outputRoot, filename);
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean).sort();
const required = [
  "package/LICENSE",
  "package/NOTICE",
  "package/README.md",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/openclaw.plugin.json",
  "package/package.json",
];
const allowed = /^(?:package\/(?:LICENSE|NOTICE|README\.md|openclaw\.plugin\.json|package\.json)|package\/dist\/(?:index|src\/[a-z0-9-]+)\.(?:js|d\.ts))$/u;
if (required.some((entry) => !entries.includes(entry)) || entries.some((entry) => !allowed.test(entry))) {
  throw new Error(`Plugin archive violates the release allowlist: ${entries.join(", ")}`);
}
if (entries.some((entry) => entry.endsWith(".map") || entry.endsWith(".tsx")
    || (entry.endsWith(".ts") && !entry.endsWith(".d.ts")))) {
  throw new Error("Plugin archive contains source or source maps");
}
process.stdout.write(`${archive}\n`);
