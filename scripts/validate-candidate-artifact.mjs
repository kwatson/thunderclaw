import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [kind, requestedPath] = process.argv.slice(2);
if ((kind !== "xpi" && kind !== "plugin-tgz") || !requestedPath || process.argv.length !== 4) {
  throw new Error("Usage: validate-candidate-artifact.mjs <xpi|plugin-tgz> <artifact-path>");
}

const expectedSuffix = kind === "xpi" ? ".xpi" : ".tgz";
if (!requestedPath.endsWith(expectedSuffix)) {
  throw new Error(`Candidate ${kind} path must end in ${expectedSuffix}`);
}
const artifact = await realpath(requestedPath);
if (!(await stat(artifact)).isFile()) throw new Error(`Candidate ${kind} must be a regular file`);

const repositoryPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const archiveEntries = kind === "xpi"
  ? execFileSync("unzip", ["-Z1", artifact], { encoding: "utf8" }).trim().split(/\r?\n/u)
  : execFileSync("tar", ["-tzf", artifact], { encoding: "utf8" }).trim().split(/\r?\n/u);
const metadataEntry = kind === "xpi" ? "manifest.json" : "package/package.json";
if (archiveEntries.filter((entry) => entry === metadataEntry).length !== 1) {
  throw new Error(`Candidate ${kind} must contain exactly one ${metadataEntry}`);
}

const metadata = JSON.parse(execFileSync(
  kind === "xpi" ? "unzip" : "tar",
  kind === "xpi" ? ["-p", artifact, metadataEntry] : ["-xOzf", artifact, metadataEntry],
  { encoding: "utf8" },
));
if (metadata.version !== repositoryPackage.version) {
  throw new Error(`Candidate ${kind} version does not match the ThunderClaw repository version`);
}
if (kind === "xpi") {
  if (metadata.browser_specific_settings?.gecko?.id !== "thunderclaw@addons.thunderbird.net"
      || metadata.name !== "ThunderClaw") {
    throw new Error("Candidate XPI does not have the stable ThunderClaw identity");
  }
} else {
  if (metadata.name !== "@thunderclaw/openclaw-plugin") {
    throw new Error("Candidate plugin archive does not have the ThunderClaw package identity");
  }
  const pluginManifestEntry = "package/openclaw.plugin.json";
  if (archiveEntries.filter((entry) => entry === pluginManifestEntry).length !== 1) {
    throw new Error(`Candidate plugin-tgz must contain exactly one ${pluginManifestEntry}`);
  }
  const pluginManifest = JSON.parse(execFileSync(
    "tar", ["-xOzf", artifact, pluginManifestEntry], { encoding: "utf8" },
  ));
  if (pluginManifest.id !== "thunderclaw" || pluginManifest.name !== "ThunderClaw") {
    throw new Error("Candidate plugin archive does not have the ThunderClaw plugin identity");
  }
}

const sha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
process.stdout.write(`${JSON.stringify({ kind, path: artifact, sha256, version: metadata.version })}\n`);
