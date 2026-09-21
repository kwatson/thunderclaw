import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOpenClawQualification } from "./openclaw-qualification.mjs";

const requiredEntrypoints = [
  "./plugin-sdk/agent-runtime",
  "./plugin-sdk/cli-argv",
  "./plugin-sdk/gateway-runtime",
  "./plugin-sdk/plugin-entry",
];
const declarationFiles = [
  "dist/plugin-sdk/agent-runtime.d.ts",
  "dist/plugin-sdk/cli-argv.d.ts",
  "dist/plugin-sdk/gateway-runtime.d.ts",
  "dist/plugin-sdk/plugin-entry.d.ts",
];
const qualificationSurfaces = [
  "openclaw-qualification.json",
  "package.json",
  "package-lock.json",
  "packages/openclaw-plugin/package.json",
  "compose.spike.yaml",
  ".github/workflows/ci.yml",
  "scripts/run-openclaw-ci.sh",
  "scripts/bootstrap-spike.sh",
  "scripts/stage-openclaw-provider.mjs",
  "scripts/qualify-pairing.ts",
  "packages/openclaw-plugin/src/compatibility-fingerprint.ts",
  "packages/openclaw-plugin/src/openclaw-agent-sessions.d.ts",
  "e2e/qualification/real-agent/run.mjs",
  "README.md",
  "docs/compatibility.md",
  "docs/installation-and-pairing.md",
  "docs/testing.md",
  "site/index.html",
];

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${program} failed with status ${result.status}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function selectLinuxAmd64Digest(manifest) {
  const matches = manifest?.manifests?.filter((entry) => entry?.platform?.os === "linux"
    && entry?.platform?.architecture === "amd64" && /^sha256:[a-f0-9]{64}$/u.test(entry.digest)) ?? [];
  if (matches.length !== 1) throw new Error("OpenClaw image index must contain exactly one linux/amd64 manifest");
  return matches[0].digest;
}

export function summarizeSdkExports(packageManifest) {
  const exports = packageManifest?.exports;
  if (exports === null || typeof exports !== "object" || Array.isArray(exports)) {
    throw new Error("OpenClaw package has no exports map");
  }
  const missingEntrypoints = requiredEntrypoints.filter((entrypoint) => !(entrypoint in exports) || exports[entrypoint] === undefined);
  return { requiredEntrypoints, missingEntrypoints };
}

async function declarationHashes(root) {
  return Object.fromEntries(await Promise.all(declarationFiles.map(async (relative) => {
    const contents = await readFile(path.join(root, relative));
    return [relative, sha256(contents)];
  })));
}

function readArchiveEntry(archive, entry) {
  const result = spawnSync("tar", ["-xOf", archive, entry], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`OpenClaw archive is missing required entry ${entry}`);
  return result.stdout;
}

function npmMetadata(packageName, version) {
  const result = JSON.parse(command("npm", ["view", `${packageName}@${version}`, "version", "dist.integrity", "dist.tarball", "--json"]));
  if (result.version !== version || typeof result["dist.integrity"] !== "string" || typeof result["dist.tarball"] !== "string") {
    throw new Error(`${packageName}@${version} returned incomplete npm metadata`);
  }
  return { version: result.version, integrity: result["dist.integrity"], tarball: result["dist.tarball"] };
}

export function evaluateReleaseTag(refObject, annotatedTag) {
  if (refObject?.type === "commit" && /^[a-f0-9]{40}$/u.test(refObject.sha)) {
    return { commit: refObject.sha, verifiedTag: false, tagKind: "lightweight" };
  }
  if (refObject?.type !== "tag" || !/^[a-f0-9]{40}$/u.test(refObject.sha)
      || annotatedTag?.sha !== refObject.sha || annotatedTag?.object?.type !== "commit"
      || !/^[a-f0-9]{40}$/u.test(annotatedTag.object.sha)) {
    throw new Error("OpenClaw release ref must be one annotated tag pointing directly to a commit");
  }
  return {
    commit: annotatedTag.object.sha,
    verifiedTag: annotatedTag.verification?.verified === true,
    tagKind: "annotated",
  };
}

function githubReleaseIdentity(repository, version) {
  const tag = `v${version}`;
  const refObject = JSON.parse(command("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`])).object;
  const annotatedTag = refObject?.type === "tag"
    ? JSON.parse(command("gh", ["api", `repos/${repository}/git/tags/${refObject.sha}`]))
    : undefined;
  return { repository, tag, ...evaluateReleaseTag(refObject, annotatedTag) };
}

async function proposedPackage(directory, version) {
  const packed = JSON.parse(command("npm", ["pack", `openclaw@${version}`, "--json", "--pack-destination", directory]));
  if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== "string") {
    throw new Error("npm pack did not return exactly one OpenClaw archive");
  }
  const archive = path.join(directory, packed[0].filename);
  const manifest = JSON.parse(readArchiveEntry(archive, "package/package.json").toString("utf8"));
  const declarations = Object.fromEntries(declarationFiles.map((relative) => [
    relative,
    sha256(readArchiveEntry(archive, `package/${relative}`)),
  ]));
  return {
    manifest,
    declarations,
  };
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--version" || !/^\d{4}\.\d{1,2}\.\d+$/u.test(args[1])) {
    throw new Error("Usage: preflight-openclaw-upgrade.mjs --version <YYYY.M.PATCH>");
  }
  return args[1];
}

async function preflight(version) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const current = await readOpenClawQualification(root);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-openclaw-preflight-"));
  try {
    const [openclawNpm, providerNpm] = [
      npmMetadata("openclaw", version),
      npmMetadata(current.provider.package, version),
    ];
    const upstream = githubReleaseIdentity(current.upstream.repository, version);
    const imageManifest = JSON.parse(command("docker", ["buildx", "imagetools", "inspect",
      `${current.image.repository}:${version}`, "--format", "{{json .Manifest}}"]));
    const image = {
      repository: current.image.repository,
      tag: version,
      indexDigest: imageManifest.digest,
      linuxAmd64Digest: selectLinuxAmd64Digest(imageManifest),
    };
    const proposed = await proposedPackage(temporary, version);
    const installedManifest = JSON.parse(await readFile(path.join(root, "node_modules/openclaw/package.json"), "utf8"));
    const installedDeclarations = await declarationHashes(path.join(root, "node_modules/openclaw"));
    const sdk = summarizeSdkExports(proposed.manifest);
    const changedDeclarations = declarationFiles.filter((file) => installedDeclarations[file] !== proposed.declarations[file]);
    const blockingFindings = [
      ...sdk.missingEntrypoints.map((entrypoint) => `missing required export ${entrypoint}`),
      ...(upstream.verifiedTag ? [] : ["upstream release tag is not verified"]),
      ...(installedManifest.version === current.stableVersion ? [] : ["installed OpenClaw does not match the current qualification manifest"]),
    ];
    return {
      format: "thunderclaw-openclaw-upgrade-preflight-v1",
      current: { version: current.stableVersion, releaseCommit: current.upstream.releaseCommit },
      proposed: { version, npm: openclawNpm, providerNpm, upstream, image },
      sdk: { ...sdk, declarationFiles, changedDeclarations, currentHashes: installedDeclarations, proposedHashes: proposed.declarations },
      repositoryImpact: qualificationSurfaces,
      blockingFindings,
      compatibilityDecision: "not-made",
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await preflight(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.blockingFindings.length > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
