import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "build");
const catalogIconUrl = "https://raw.githubusercontent.com/kwatson/thunderclaw/main/docs/brand/assets/raster/icons/thunderclaw-openclaw-plugin-icon-256.png";
const catalogIconSha256 = "8406cb0af05dda2a49ae926c5de6b084b8579ae45fd27c106087cd80ce9507a5";
const catalogIconMaxBytes = 256 * 1024;
const canonicalIcon = await readFile(path.join(
  root, "docs/brand/assets/raster/icons/thunderclaw-openclaw-plugin-icon-256.png",
));
if (createHash("sha256").update(canonicalIcon).digest("hex") !== catalogIconSha256) {
  throw new Error("OpenClaw catalog icon does not match its approved digest");
}
if (canonicalIcon.byteLength > catalogIconMaxBytes) {
  throw new Error("OpenClaw catalog icon exceeds the fetched-icon size limit");
}
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
  "package/assets/thunderclaw-plugin-icon.png",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/openclaw.plugin.json",
  "package/package.json",
];
const allowed = /^(?:package\/(?:LICENSE|NOTICE|README\.md|openclaw\.plugin\.json|package\.json)|package\/assets\/thunderclaw-plugin-icon\.png|package\/dist\/(?:index|src\/[a-z0-9-]+)\.(?:js|d\.ts))$/u;
if (required.some((entry) => !entries.includes(entry)) || entries.some((entry) => !allowed.test(entry))) {
  throw new Error(`Plugin archive violates the release allowlist: ${entries.join(", ")}`);
}
if (entries.some((entry) => entry.endsWith(".map") || entry.endsWith(".tsx")
    || (entry.endsWith(".ts") && !entry.endsWith(".d.ts")))) {
  throw new Error("Plugin archive contains source or source maps");
}
const archivedIcon = execFileSync("tar", ["-xOzf", archive, "package/assets/thunderclaw-plugin-icon.png"]);
if (!archivedIcon.equals(canonicalIcon)) {
  throw new Error("Plugin archive catalog icon does not match the canonical brand asset");
}
const archivedManifest = JSON.parse(execFileSync(
  "tar", ["-xOzf", archive, "package/openclaw.plugin.json"], { encoding: "utf8" },
));
if (archivedManifest.icon !== catalogIconUrl) {
  throw new Error("Plugin manifest does not reference the packaged catalog icon's public URL");
}
process.stdout.write(`${archive}\n`);
