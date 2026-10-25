import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const [kind, requestedPath, expectedOption, explicitVersion] = args;
if (kind !== "xpi" || !requestedPath || (args.length !== 2
    && (args.length !== 4 || expectedOption !== "--expected-version" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(explicitVersion)))) {
  throw new Error("Usage: validate-candidate-artifact.mjs xpi <artifact-path> [--expected-version X.Y.Z]");
}

const expectedSuffix = ".xpi";
if (!requestedPath.endsWith(expectedSuffix)) {
  throw new Error(`Candidate ${kind} path must end in ${expectedSuffix}`);
}
const artifact = await realpath(requestedPath);
if (!(await stat(artifact)).isFile()) throw new Error(`Candidate ${kind} must be a regular file`);

const component = "thunderbird-extension";
const componentPackage = JSON.parse(await readFile(
  path.join(root, "packages", component, "package.json"), "utf8",
));
const archiveEntries = execFileSync("unzip", ["-Z1", artifact], { encoding: "utf8" }).trim().split(/\r?\n/u);
const metadataEntry = "manifest.json";
if (archiveEntries.filter((entry) => entry === metadataEntry).length !== 1) {
  throw new Error(`Candidate ${kind} must contain exactly one ${metadataEntry}`);
}

const metadata = JSON.parse(execFileSync("unzip", ["-p", artifact, metadataEntry], { encoding: "utf8" }));
if (metadata.version !== (explicitVersion ?? componentPackage.version)) {
  throw new Error(`Candidate ${kind} version does not match the ${component} version`);
}
if (metadata.browser_specific_settings?.gecko?.id !== "thunderclaw@addons.thunderbird.net"
    || metadata.name !== "ThunderClaw") {
  throw new Error("Candidate XPI does not have the stable ThunderClaw identity");
}

const sha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
process.stdout.write(`${JSON.stringify({ component, kind, path: artifact, sha256, version: metadata.version })}\n`);
