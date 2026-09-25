import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateReleaseState } from "./openclaw-release-state.mjs";

export const FOUNDATION_FORMAT = "thunderclaw-openclaw-autopilot-foundation-v1";
const sha40 = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const stable = /^\d{4}\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

function nextPatch(version) {
  if (!semver.test(version)) throw new Error("foundation source plugin version is malformed");
  const parts = version.split(".").map(Number); parts[2] += 1; return parts.join(".");
}

export function validateFoundationManifest(value) {
  if (!exact(value, ["format", "from", "foundation", "retireState", "policy"]) || value.format !== FOUNDATION_FORMAT) {
    throw new Error("OpenClaw foundation manifest must use the strict v1 schema");
  }
  if (!exact(value.from, ["tag", "pluginVersion", "commit", "artifactName", "artifactSha256", "artifactSize"])
      || !exact(value.foundation, ["tag", "pluginVersion", "openclawVersion"])
      || !exact(value.retireState, ["revision", "phase", "reservationId", "identitySha256"])
      || !exact(value.policy, ["releaseLane", "humanReviewRequired", "counterpartCloseoutRequired"])) {
    throw new Error("OpenClaw foundation manifest has a noncanonical schema");
  }
  if (!semver.test(value.from.pluginVersion) || value.from.tag !== `openclaw-plugin-v${value.from.pluginVersion}`
      || value.from.artifactName !== `thunderclaw-openclaw-plugin-${value.from.pluginVersion}.tgz`
      || !sha40.test(value.from.commit) || !sha256.test(value.from.artifactSha256)
      || !Number.isSafeInteger(value.from.artifactSize) || value.from.artifactSize < 1) throw new Error("foundation source trust anchor is malformed");
  if (!semver.test(value.foundation.pluginVersion) || value.foundation.pluginVersion !== nextPatch(value.from.pluginVersion)
      || value.foundation.tag !== `openclaw-plugin-v${value.foundation.pluginVersion}`
      || !stable.test(value.foundation.openclawVersion)) throw new Error("foundation target identity is malformed");
  if (!Number.isSafeInteger(value.retireState.revision) || value.retireState.revision < 0
      || value.retireState.phase !== "ready" || !/^[a-f0-9]{32}$/u.test(value.retireState.reservationId)
      || !sha256.test(value.retireState.identitySha256)) throw new Error("foundation state retirement identity is malformed");
  if (value.policy.releaseLane !== "foundation" || value.policy.humanReviewRequired !== true
      || value.policy.counterpartCloseoutRequired !== true) throw new Error("foundation policy must require human review and counterpart closeout");
  return value;
}

export function assessFoundationCloseout({ manifest: manifestValue, baselines, plugin, qualification, state: stateValue }) {
  const manifest = validateFoundationManifest(manifestValue);
  const state = stateValue;
  const baseline = baselines?.["openclaw-plugin"];
  if (!record(baseline) || baseline.tag !== manifest.foundation.tag
      || baseline.name !== `thunderclaw-openclaw-plugin-${manifest.foundation.pluginVersion}.tgz`
      || !sha256.test(baseline.sha256) || !Number.isSafeInteger(baseline.size) || baseline.size < 1) {
    throw new Error("foundation counterpart closeout has not advanced to the exact target release");
  }
  if (plugin?.version !== manifest.foundation.pluginVersion
      || qualification?.stableVersion !== manifest.foundation.openclawVersion) {
    throw new Error("foundation source has not advanced to the exact target identity");
  }
  if (state.revision !== manifest.retireState.revision || state.phase !== manifest.retireState.phase
      || state.reservationId !== manifest.retireState.reservationId
      || state.identitySha256 !== manifest.retireState.identitySha256
      || state.identity.version !== manifest.foundation.openclawVersion
      || state.baseline.current.pluginVersion !== manifest.from.pluginVersion) {
    throw new Error("durable state is not the exact reviewed foundation-era reservation");
  }
  return { rolloverAllowed: true, retiredReservationId: state.reservationId,
    retiredIdentitySha256: state.identitySha256, foundationTag: manifest.foundation.tag };
}

export function assessFoundationMigration({ manifest: manifestValue, baselines, plugin, qualification, tag, commit, tree, sourceTagCommit, manifestAbsentAtSource }) {
  const manifest = validateFoundationManifest(manifestValue);
  const baseline = baselines?.["openclaw-plugin"];
  if (!record(baseline) || baseline.tag !== manifest.from.tag || baseline.name !== manifest.from.artifactName
      || baseline.sha256 !== manifest.from.artifactSha256 || baseline.size !== manifest.from.artifactSize) {
    throw new Error("published counterpart baseline is not the declared one-use foundation source anchor");
  }
  if (sourceTagCommit !== manifest.from.commit || manifestAbsentAtSource !== true) {
    throw new Error("foundation migration is not rooted in the declared pre-foundation release");
  }
  if (tag !== manifest.foundation.tag || plugin?.version !== manifest.foundation.pluginVersion
      || qualification?.stableVersion !== manifest.foundation.openclawVersion
      || !sha40.test(commit) || !sha40.test(tree)) throw new Error("foundation release identity differs from the reviewed migration");
  return { releaseLane: "foundation", humanReviewRequired: true, counterpartCloseoutRequired: true,
    fromTag: manifest.from.tag, tag, pluginVersion: plugin.version, openclawVersion: qualification.stableVersion, commit, tree };
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  return result.stdout.trim();
}

export async function verifyFoundationMigration({ root, tag, commit }) {
  const [manifest, baselines, plugin, qualification] = await Promise.all([
    "openclaw-autopilot-foundation.json", "e2e/qualification/counterpart-baselines.json",
    "packages/openclaw-plugin/package.json", "openclaw-qualification.json",
  ].map(async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"))));
  const targetCommit = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (targetCommit !== commit) throw new Error("foundation target commit is not exact");
  const sourceTagCommit = git(root, ["rev-parse", "--verify", `${manifest.from.tag}^{commit}`]);
  if (spawnSync("git", ["merge-base", "--is-ancestor", sourceTagCommit, commit], { cwd: root }).status !== 0) {
    throw new Error("foundation source tag is not an ancestor of the target");
  }
  const absent = spawnSync("git", ["cat-file", "-e", `${sourceTagCommit}:openclaw-autopilot-foundation.json`], { cwd: root }).status !== 0;
  return assessFoundationMigration({ manifest, baselines, plugin, qualification, tag, commit,
    tree: git(root, ["show", "-s", "--format=%T", commit]), sourceTagCommit, manifestAbsentAtSource: absent });
}

export async function verifyFoundationCloseout({ root, stateFile }) {
  const [manifest, baselines, plugin, qualification, state] = await Promise.all([
    path.join(root, "openclaw-autopilot-foundation.json"), path.join(root, "e2e/qualification/counterpart-baselines.json"),
    path.join(root, "packages/openclaw-plugin/package.json"), path.join(root, "openclaw-qualification.json"), stateFile,
  ].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  return assessFoundationCloseout({ manifest, baselines, plugin, qualification, state: validateReleaseState(state) });
}

function option(args, name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const root = path.resolve(option(process.argv, "--root") ?? "."); const tag = option(process.argv, "--tag"); const commit = option(process.argv, "--commit");
    const closeoutState = option(process.argv, "--closeout-state");
    if (closeoutState) process.stdout.write(`${JSON.stringify(await verifyFoundationCloseout({ root, stateFile: path.resolve(closeoutState) }))}\n`);
    else {
      if (!tag || !commit) throw new Error("Usage: verify-openclaw-foundation.mjs --tag TAG --commit SHA [--root PATH] | --closeout-state FILE [--root PATH]");
      process.stdout.write(`${JSON.stringify(await verifyFoundationMigration({ root, tag, commit }))}\n`);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
