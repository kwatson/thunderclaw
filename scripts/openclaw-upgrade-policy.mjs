import { createHash } from "node:crypto";

export const PREFLIGHT_FORMAT = "thunderclaw-openclaw-upgrade-preflight-v2";
export const SOAK_MILLISECONDS = 24 * 60 * 60 * 1000;

const stableVersionPattern = /^\d{4}\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const sha256Pattern = /^sha256:[a-f0-9]{64}$/u;
const sha512Pattern = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const requiredEntrypoints = ["./plugin-sdk/agent-runtime", "./plugin-sdk/cli-argv", "./plugin-sdk/gateway-runtime", "./plugin-sdk/plugin-entry"];
const declarationFiles = ["dist/plugin-sdk/agent-runtime.d.ts", "dist/plugin-sdk/cli-argv.d.ts", "dist/plugin-sdk/gateway-runtime.d.ts", "dist/plugin-sdk/plugin-entry.d.ts"];

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, name, pattern) {
  if (typeof value !== "string" || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is missing or malformed`);
  }
  return value;
}

function instant(value, name) {
  requireString(value, name);
  const milliseconds = Date.parse(value);
  const canonical = Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "";
  if (!Number.isFinite(milliseconds) || (canonical !== value && canonical.replace(/\.000Z$/u, "Z") !== value)) {
    throw new Error(`${name} must be a canonical UTC timestamp`);
  }
  return milliseconds;
}

export function compareOpenClawVersions(left, right) {
  if (!stableVersionPattern.test(left) || !stableVersionPattern.test(right)) {
    throw new Error("OpenClaw autopilot accepts stable YYYY.M.PATCH versions only");
  }
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function validateUpgradePreflight(value) {
  if (!record(value) || value.format !== PREFLIGHT_FORMAT) {
    throw new Error(`OpenClaw preflight must use ${PREFLIGHT_FORMAT}`);
  }
  instant(value.observedAt, "preflight.observedAt");
  if (!record(value.current) || !record(value.proposed) || !record(value.sdk)) {
    throw new Error("OpenClaw preflight is missing required sections");
  }
  const currentVersion = requireString(value.current.version, "preflight.current.version", stableVersionPattern);
  requireString(value.current.releaseCommit, "preflight.current.releaseCommit", commitPattern);
  requireString(value.current.pluginVersion, "preflight.current.pluginVersion", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u);
  const proposedVersion = requireString(value.proposed.version, "preflight.proposed.version", stableVersionPattern);
  if (compareOpenClawVersions(proposedVersion, currentVersion) <= 0) {
    throw new Error("proposed OpenClaw version must be newer than the current stable version");
  }
  for (const [name, metadata] of [["npm", value.proposed.npm], ["providerNpm", value.proposed.providerNpm]]) {
    if (!record(metadata) || metadata.version !== proposedVersion) throw new Error(`${name} version is inconsistent`);
    requireString(metadata.integrity, `${name}.integrity`, sha512Pattern);
    requireString(metadata.tarball, `${name}.tarball`, /^https:\/\//u);
  }
  if (value.proposed.npm.package !== "openclaw" || value.proposed.providerNpm.package !== "@openclaw/deepseek-provider") {
    throw new Error("npm package identities are inconsistent");
  }
  const upstream = value.proposed.upstream;
  if (!record(upstream) || upstream.repository !== "openclaw/openclaw"
      || upstream.tag !== `v${proposedVersion}` || upstream.releaseTag !== upstream.tag
      || upstream.officialRelease !== true || upstream.draft !== false || upstream.prerelease !== false) {
    throw new Error("official stable OpenClaw release identity is inconsistent");
  }
  requireString(upstream.commit, "upstream.commit", commitPattern);
  requireString(upstream.releaseUrl, "upstream.releaseUrl", /^https:\/\/github\.com\/openclaw\/openclaw\/releases\//u);
  instant(upstream.publishedAt, "upstream.publishedAt");
  if (!Number.isSafeInteger(upstream.releaseId) || upstream.releaseId < 1) throw new Error("upstream.releaseId is malformed");
  if (!new Set(["annotated", "lightweight"]).has(upstream.tagKind) || typeof upstream.verifiedTag !== "boolean"
      || typeof upstream.verifiedCommit !== "boolean") {
    throw new Error("upstream tag evidence is malformed");
  }
  const image = value.proposed.image;
  if (!record(image) || image.repository !== "ghcr.io/openclaw/openclaw" || image.tag !== proposedVersion) {
    throw new Error("OpenClaw image identity is inconsistent");
  }
  requireString(image.indexDigest, "image.indexDigest", sha256Pattern);
  requireString(image.linuxAmd64Digest, "image.linuxAmd64Digest", sha256Pattern);
  if (!Array.isArray(value.sdk.requiredEntrypoints) || !Array.isArray(value.sdk.missingEntrypoints)
      || !Array.isArray(value.sdk.declarationFiles) || !Array.isArray(value.sdk.changedDeclarations)) {
    throw new Error("SDK evidence is malformed");
  }
  if (JSON.stringify(value.sdk.requiredEntrypoints) !== JSON.stringify(requiredEntrypoints)
      || JSON.stringify(value.sdk.declarationFiles) !== JSON.stringify(declarationFiles)
      || !value.sdk.missingEntrypoints.every((entry) => requiredEntrypoints.includes(entry))
      || !value.sdk.changedDeclarations.every((entry) => declarationFiles.includes(entry))) {
    throw new Error("SDK evidence does not cover the canonical required surfaces");
  }
  for (const name of ["currentHashes", "proposedHashes"]) {
    if (!record(value.sdk[name]) || JSON.stringify(Object.keys(value.sdk[name]).sort()) !== JSON.stringify([...declarationFiles].sort())
        || !Object.values(value.sdk[name]).every((digest) => typeof digest === "string" && hashPattern.test(digest))) {
      throw new Error(`SDK ${name} must contain every canonical declaration hash`);
    }
  }
  if (value.upstreamCi !== undefined && (!record(value.upstreamCi)
      || JSON.stringify(Object.keys(value.upstreamCi).sort()) !== JSON.stringify(["conclusion", "waived"].sort())
      || typeof value.upstreamCi.conclusion !== "string" || typeof value.upstreamCi.waived !== "boolean")) {
    throw new Error("upstream CI evidence is malformed");
  }
  for (const name of ["blockingFindings", "advisoryFindings", "repositoryImpact"]) {
    if (!Array.isArray(value[name]) || !value[name].every((entry) => typeof entry === "string")) {
      throw new Error(`${name} must be an array of strings`);
    }
  }
  if (value.compatibilityDecision !== "not-made") {
    throw new Error("preflight must not claim a compatibility decision");
  }
  return value;
}

export function immutableReleaseIdentity(preflight) {
  const value = validateUpgradePreflight(preflight);
  return {
    version: value.proposed.version,
    npmIntegrity: value.proposed.npm.integrity,
    providerPackage: value.proposed.providerNpm.package,
    providerIntegrity: value.proposed.providerNpm.integrity,
    imageRepository: value.proposed.image.repository,
    imageIndexDigest: value.proposed.image.indexDigest,
    linuxAmd64Digest: value.proposed.image.linuxAmd64Digest,
    upstreamRepository: value.proposed.upstream.repository,
    releaseId: value.proposed.upstream.releaseId,
    releaseTag: value.proposed.upstream.releaseTag,
    releaseCommit: value.proposed.upstream.commit,
    publishedAt: value.proposed.upstream.publishedAt,
  };
}

export function hashReleaseIdentity(identity) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function assessUpgradeEvidence({ baseline, current, now = current?.observedAt }) {
  const first = validateUpgradePreflight(baseline);
  const latest = validateUpgradePreflight(current);
  const firstIdentity = immutableReleaseIdentity(first);
  const latestIdentity = immutableReleaseIdentity(latest);
  const blockers = [];
  const advisories = [...new Set([...first.advisoryFindings, ...latest.advisoryFindings])];
  if (JSON.stringify(firstIdentity) !== JSON.stringify(latestIdentity)) blockers.push("immutable release identity changed during soak");
  if (first.current.version !== latest.current.version || first.current.releaseCommit !== latest.current.releaseCommit
      || first.current.pluginVersion !== latest.current.pluginVersion) {
    blockers.push("qualification baseline changed during soak");
  }
  if (latest.sdk.missingEntrypoints.length > 0) blockers.push(...latest.sdk.missingEntrypoints.map((entry) => `missing required export ${entry}`));
  blockers.push(...latest.blockingFindings);
  if (!latest.proposed.upstream.verifiedTag) advisories.push("upstream release tag is unsigned or unverified");
  if (!latest.proposed.upstream.verifiedCommit) advisories.push("upstream release commit is unsigned or unverified");
  if (latest.upstreamCi?.waived === true) advisories.push("upstream CI was waived");
  else if (latest.upstreamCi && latest.upstreamCi.conclusion !== "success") blockers.push("upstream CI did not succeed and was not waived");
  const firstObservedAt = instant(first.observedAt, "baseline.observedAt");
  const observedAt = instant(latest.observedAt, "current.observedAt");
  const publishedAt = instant(latest.proposed.upstream.publishedAt, "upstream.publishedAt");
  const evaluatedAt = instant(now, "now");
  if (firstObservedAt < publishedAt) blockers.push("baseline observation predates the official release");
  if (observedAt < firstObservedAt) blockers.push("revalidation observation predates the baseline observation");
  const soakCompletesAt = new Date(Math.max(publishedAt, firstObservedAt) + SOAK_MILLISECONDS).toISOString();
  const soakComplete = evaluatedAt >= Date.parse(soakCompletesAt) && observedAt >= Date.parse(soakCompletesAt);
  return {
    format: "thunderclaw-openclaw-upgrade-assessment-v1",
    decision: blockers.length > 0 ? "blocked" : soakComplete ? "ready" : "waiting",
    identity: latestIdentity,
    identitySha256: hashReleaseIdentity(latestIdentity),
    firstObservedAt: first.observedAt,
    revalidatedAt: latest.observedAt,
    soakCompletesAt,
    blockers: [...new Set(blockers)],
    advisories: [...new Set(advisories)],
  };
}
