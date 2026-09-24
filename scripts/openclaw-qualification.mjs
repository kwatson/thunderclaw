import { readFile } from "node:fs/promises";
import path from "node:path";

const versionPattern = /^\d{4}\.\d{1,2}\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const sha512Pattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateOpenClawQualification(value) {
  if (!exactKeys(value, ["format", "apiFloor", "stableVersion", "supportedRange", "nextReleaseFloor", "image", "npm", "provider", "upstream"])
      || value.format !== "thunderclaw-openclaw-qualification-v1") {
    throw new Error("OpenClaw qualification manifest must use the strict v1 schema");
  }
  if (![value.apiFloor, value.stableVersion].every((version) => typeof version === "string" && versionPattern.test(version))
      || typeof value.nextReleaseFloor !== "string" || !versionPattern.test(value.nextReleaseFloor)) {
    throw new Error("OpenClaw qualification versions are malformed");
  }
  const expectedRange = `>=${value.apiFloor} <${value.nextReleaseFloor}`;
  if (value.supportedRange !== expectedRange) {
    throw new Error(`OpenClaw supported range must be ${expectedRange}`);
  }
  const stableParts = value.stableVersion.split(".").map(Number);
  const expectedNextFloor = `${stableParts[0]}.${stableParts[1]}.${stableParts[2] + 1}-0`;
  if (value.nextReleaseFloor !== expectedNextFloor) {
    throw new Error(`OpenClaw next release floor must be ${expectedNextFloor}`);
  }
  if (!exactKeys(value.image, ["repository", "linuxAmd64Digest"])
      || value.image.repository !== "ghcr.io/openclaw/openclaw"
      || !sha256Pattern.test(value.image.linuxAmd64Digest)) {
    throw new Error("OpenClaw image qualification is malformed");
  }
  if (!exactKeys(value.npm, ["integrity"]) || !sha512Pattern.test(value.npm.integrity)) {
    throw new Error("OpenClaw npm qualification is malformed");
  }
  if (!exactKeys(value.provider, ["package", "version", "integrity"])
      || value.provider.package !== "@openclaw/deepseek-provider"
      || value.provider.version !== value.stableVersion
      || !sha512Pattern.test(value.provider.integrity)) {
    throw new Error("OpenClaw provider qualification is malformed");
  }
  if (!exactKeys(value.upstream, ["repository", "releaseTag", "releaseCommit"])
      || value.upstream.repository !== "openclaw/openclaw"
      || value.upstream.releaseTag !== `v${value.stableVersion}`
      || !commitPattern.test(value.upstream.releaseCommit)) {
    throw new Error("OpenClaw upstream qualification is malformed");
  }
  return value;
}

export async function readOpenClawQualification(root) {
  const contents = await readFile(path.join(root, "openclaw-qualification.json"), "utf8");
  return validateOpenClawQualification(JSON.parse(contents));
}

function requireText(file, contents, expected, minimum = 1) {
  const count = contents.split(expected).length - 1;
  if (count < minimum) throw new Error(`${file} does not contain the qualified value ${JSON.stringify(expected)}`);
}

export function captureOne(file, contents, pattern, expected) {
  const matches = [...contents.matchAll(pattern)];
  if (matches.length !== 1 || matches[0][1] !== expected) {
    throw new Error(`${file} active qualification value must be ${JSON.stringify(expected)}`);
  }
}

export function forbidPattern(file, contents, pattern, description) {
  if (pattern.test(contents)) throw new Error(`${file} retains a hard-coded ${description}`);
}

export function verifyDigestPinningSources({ pairing, realAgent }) {
  requireText("scripts/qualify-pairing.ts", pairing,
    "+ `@${openClawQualification.image.linuxAmd64Digest}`;");
  requireText("e2e/qualification/real-agent/run.mjs", realAgent,
    "+ `@${openClawQualification.image.linuxAmd64Digest}`;");
  requireText("e2e/qualification/real-agent/run.mjs", realAgent,
    "`${openClawQualification.image.repository}@${openClawQualification.image.linuxAmd64Digest}`");
  requireText("e2e/qualification/real-agent/run.mjs", realAgent,
    "parsedGatewayRepoDigests.includes(qualifiedGatewayRepoDigest)");
}

async function readText(root, relative) {
  return readFile(path.join(root, relative), "utf8");
}

async function readJson(root, relative) {
  return JSON.parse(await readText(root, relative));
}

export async function verifyOpenClawQualification({ root }) {
  const qualification = await readOpenClawQualification(root);
  const { apiFloor, stableVersion, supportedRange, nextReleaseFloor, image, npm, provider } = qualification;
  const imageTag = `${image.repository}:${stableVersion}`;
  const pinnedImage = `${imageTag}@${image.linuxAmd64Digest}`;
  const providerSpec = `${provider.package}@${provider.version}`;

  const rootPackage = await readJson(root, "package.json");
  const pluginPackage = await readJson(root, "packages/openclaw-plugin/package.json");
  const lockfile = await readJson(root, "package-lock.json");
  if (rootPackage.devDependencies?.openclaw !== `^${stableVersion}`
      || pluginPackage.peerDependencies?.openclaw !== supportedRange
      || pluginPackage.openclaw?.compat?.pluginApi !== supportedRange
      || pluginPackage.openclaw?.compat?.minGatewayVersion !== apiFloor
      || pluginPackage.openclaw?.build?.openclawVersion !== apiFloor
      || pluginPackage.openclaw?.build?.pluginSdkVersion !== apiFloor) {
    throw new Error("OpenClaw package metadata disagrees with openclaw-qualification.json");
  }
  if (lockfile.packages?.[""]?.devDependencies?.openclaw !== `^${stableVersion}`
      || lockfile.packages?.["packages/openclaw-plugin"]?.peerDependencies?.openclaw !== supportedRange
      || lockfile.packages?.["node_modules/openclaw"]?.version !== stableVersion
      || lockfile.packages?.["node_modules/openclaw"]?.integrity !== npm.integrity) {
    throw new Error("OpenClaw lockfile metadata disagrees with openclaw-qualification.json");
  }

  const activeFiles = {
    compose: await readText(root, "compose.spike.yaml"),
    ciScript: await readText(root, "scripts/run-openclaw-ci.sh"),
    bootstrap: await readText(root, "scripts/bootstrap-spike.sh"),
    pairing: await readText(root, "scripts/qualify-pairing.ts"),
    realAgent: await readText(root, "e2e/qualification/real-agent/run.mjs"),
    fingerprint: await readText(root, "packages/openclaw-plugin/src/compatibility-fingerprint.ts"),
    workflow: await readText(root, ".github/workflows/ci.yml"),
    providerStager: await readText(root, "scripts/stage-openclaw-provider.mjs"),
  };
  const escapedRepository = image.repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedProvider = provider.package.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  captureOne("compose.spike.yaml", activeFiles.compose,
    new RegExp(`^\\s+image: (${escapedRepository}:\\S+)\\s*$`, "gmu"), pinnedImage);
  captureOne("packages/openclaw-plugin/src/compatibility-fingerprint.ts", activeFiles.fingerprint,
    /^export const PINNED_OPENCLAW_COMPATIBILITY_VERSION = "([^"]+)";$/gmu, apiFloor);
  captureOne(".github/workflows/ci.yml", activeFiles.workflow,
    /^\s+name: (Pinned qualified OpenClaw integration)$/gmu, "Pinned qualified OpenClaw integration");
  for (const [file, contents] of [
    ["scripts/run-openclaw-ci.sh", activeFiles.ciScript],
    ["scripts/bootstrap-spike.sh", activeFiles.bootstrap],
    ["scripts/qualify-pairing.ts", activeFiles.pairing],
    ["e2e/qualification/real-agent/run.mjs", activeFiles.realAgent],
  ]) {
    requireText(file, contents, "openclaw-qualification.json");
    forbidPattern(file, contents, new RegExp(`${escapedRepository}:\\d{4}\\.`, "u"), "OpenClaw image version");
    forbidPattern(file, contents, new RegExp(`${escapedProvider}@\\d{4}\\.`, "u"), "provider version");
  }
  verifyDigestPinningSources({ pairing: activeFiles.pairing, realAgent: activeFiles.realAgent });
  for (const [file, contents] of [
    ["scripts/run-openclaw-ci.sh", activeFiles.ciScript],
    ["scripts/bootstrap-spike.sh", activeFiles.bootstrap],
  ]) {
    requireText(file, contents, "stage-openclaw-provider.mjs");
    requireText(file, contents, "npm-pack:");
    requireText(file, contents, "NPM_CONFIG_OFFLINE=true");
  }
  requireText("scripts/stage-openclaw-provider.mjs", activeFiles.providerStager, "provider.integrity");
  requireText("scripts/stage-openclaw-provider.mjs", activeFiles.providerStager, "sha512Integrity");

  const checks = [
    ["packages/openclaw-plugin/src/openclaw-agent-sessions.d.ts", `OpenClaw ${apiFloor} publishes`, 1],
    ["README.md", `through the \`${stableVersion}\``, 2],
    ["README.md", `\`${apiFloor}\` through`, 2],
    ["docs/installation-and-pairing.md", `Stable OpenClaw \`${stableVersion}\``, 1],
    ["docs/testing.md", `runs stable \`${stableVersion}\``, 1],
    ["docs/compatibility.md", `\`${supportedRange}\``, 1],
    ["docs/compatibility.md", `excludes the ${nextReleaseFloor.replace(/-0$/u, "")}`, 1],
    ["site/index.html", `from ${apiFloor} through the ${stableVersion} release line`, 1],
  ];
  for (const [file, expected, minimum] of checks) {
    requireText(file, await readText(root, file), expected, minimum);
  }
  const activeFileCount = Object.keys(activeFiles).length;
  return { stableVersion, supportedRange, pinnedImage, providerSpec,
    checkedFiles: [...new Set(checks.map(([file]) => file))].length + activeFileCount + 4 };
}
