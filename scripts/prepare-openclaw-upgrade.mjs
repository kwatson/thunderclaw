import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOpenClawQualification, validateOpenClawQualification, verifyOpenClawQualification } from "./openclaw-qualification.mjs";
import { assessUpgradeEvidence, validateUpgradePreflight } from "./openclaw-upgrade-policy.mjs";

export const PREPARATION_FILES = [
  "openclaw-qualification.json", "package.json", "package-lock.json", "packages/openclaw-plugin/package.json",
  "compose.spike.yaml", "README.md", "CHANGELOG.md", "docs/compatibility.md",
  "docs/installation-and-pairing.md", "docs/testing.md", "site/index.html",
];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replaceExact(file, contents, before, after, count) {
  const found = contents.split(before).length - 1;
  if (found !== count) throw new Error(`${file} expected ${count} occurrence(s) of ${JSON.stringify(before)}, found ${found}; repository is partial or drifted`);
  return contents.split(before).join(after);
}

export function nextPatchVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) throw new Error("plugin version must be canonical semver");
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function updatedQualification(previous, preflight) {
  const stableVersion = preflight.proposed.version;
  const [year, month, patch] = stableVersion.split(".").map(Number);
  return validateOpenClawQualification({
    ...previous,
    stableVersion,
    supportedRange: `>=${previous.apiFloor} <${year}.${month}.${patch + 1}-0`,
    nextReleaseFloor: `${year}.${month}.${patch + 1}-0`,
    image: { repository: preflight.proposed.image.repository, linuxAmd64Digest: preflight.proposed.image.linuxAmd64Digest },
    npm: { integrity: preflight.proposed.npm.integrity },
    provider: {
      package: preflight.proposed.providerNpm.package,
      version: stableVersion,
      integrity: preflight.proposed.providerNpm.integrity,
    },
    upstream: {
      repository: preflight.proposed.upstream.repository,
      releaseTag: preflight.proposed.upstream.releaseTag,
      releaseCommit: preflight.proposed.upstream.commit,
    },
  });
}

function updateLockfile(contents, previous, next, pluginVersion) {
  const lock = JSON.parse(contents);
  if (lock.lockfileVersion !== 3 || typeof lock.packages !== "object") throw new Error("package-lock.json must use lockfileVersion 3");
  const root = lock.packages[""];
  const plugin = lock.packages["packages/openclaw-plugin"];
  const openclaw = lock.packages["node_modules/openclaw"];
  if (!root || !plugin || !openclaw) throw new Error("package-lock.json is missing required package records");
  if (root.devDependencies?.openclaw !== `^${next.stableVersion}`
      || plugin.version !== pluginVersion
      || plugin.peerDependencies?.openclaw !== next.supportedRange
      || openclaw.version !== next.stableVersion
      || openclaw.integrity !== next.npm.integrity) {
    throw new Error("generated package-lock.json does not contain the exact prepared OpenClaw and plugin identities");
  }
  if (openclaw.resolved !== `https://registry.npmjs.org/openclaw/-/openclaw-${next.stableVersion}.tgz`) {
    throw new Error("generated package-lock.json has an unexpected OpenClaw archive URL");
  }
  return json(lock);
}

export function buildPreparedFiles({ files, preflight, generatedLockfile, preparedDate }) {
  validateUpgradePreflight(preflight);
  const previous = validateOpenClawQualification(JSON.parse(files["openclaw-qualification.json"]));
  if (previous.stableVersion !== preflight.current.version || previous.upstream.releaseCommit !== preflight.current.releaseCommit) {
    throw new Error("preflight current identity does not match the repository qualification ledger");
  }
  const next = updatedQualification(previous, preflight);
  const output = { ...files, "openclaw-qualification.json": json(next) };
  const rootPackage = JSON.parse(files["package.json"]);
  if (rootPackage.devDependencies?.openclaw !== `^${previous.stableVersion}`) throw new Error("root OpenClaw dependency is partial or drifted");
  rootPackage.devDependencies.openclaw = `^${next.stableVersion}`;
  output["package.json"] = json(rootPackage);
  const plugin = JSON.parse(files["packages/openclaw-plugin/package.json"]);
  if (plugin.version !== preflight.current.pluginVersion) throw new Error("plugin version is partial or drifted from preflight");
  const pluginVersion = nextPatchVersion(plugin.version);
  if (plugin.peerDependencies?.openclaw !== previous.supportedRange
      || plugin.openclaw?.compat?.pluginApi !== previous.supportedRange) {
    throw new Error("plugin OpenClaw compatibility metadata is partial or drifted");
  }
  plugin.version = pluginVersion;
  plugin.peerDependencies.openclaw = next.supportedRange;
  plugin.openclaw.compat.pluginApi = next.supportedRange;
  output["packages/openclaw-plugin/package.json"] = json(plugin);
  output["compose.spike.yaml"] = replaceExact("compose.spike.yaml", files["compose.spike.yaml"],
    `${previous.image.repository}:${previous.stableVersion}@${previous.image.linuxAmd64Digest}`,
    `${next.image.repository}:${next.stableVersion}@${next.image.linuxAmd64Digest}`, 1);
  output["README.md"] = replaceExact("README.md", files["README.md"], previous.stableVersion, next.stableVersion, 2);
  output["docs/installation-and-pairing.md"] = replaceExact("docs/installation-and-pairing.md",
    files["docs/installation-and-pairing.md"], previous.stableVersion, next.stableVersion, 1);
  output["docs/testing.md"] = replaceExact("docs/testing.md", files["docs/testing.md"], previous.stableVersion, next.stableVersion, 1);
  output["site/index.html"] = replaceExact("site/index.html", files["site/index.html"], previous.stableVersion, next.stableVersion, 1);
  let compatibility = replaceExact("docs/compatibility.md", files["docs/compatibility.md"], previous.supportedRange, next.supportedRange, 1);
  compatibility = replaceExact("docs/compatibility.md", compatibility, previous.stableVersion, next.stableVersion, 4);
  compatibility = replaceExact("docs/compatibility.md", compatibility,
    `excludes the ${previous.nextReleaseFloor.replace(/-0$/u, "")}`, `excludes the ${next.nextReleaseFloor.replace(/-0$/u, "")}`, 1);
  output["docs/compatibility.md"] = compatibility;
  const heading = `## OpenClaw plugin [${pluginVersion}] - ${preparedDate}\n\n### Changed\n\n- Qualified the stable OpenClaw \`${next.stableVersion}\` runtime and expanded bounded\n  compatibility through the \`${next.stableVersion}\` release line.\n\n`;
  const changelogMarker = files["CHANGELOG.md"].indexOf("## ");
  if (changelogMarker < 0) throw new Error("CHANGELOG.md has no component entry insertion point");
  output["CHANGELOG.md"] = `${files["CHANGELOG.md"].slice(0, changelogMarker)}${heading}${files["CHANGELOG.md"].slice(changelogMarker)}`;
  output["package-lock.json"] = updateLockfile(generatedLockfile, previous, next, pluginVersion);
  return { files: output, pluginVersion, qualification: next };
}

async function readPreparationFiles(root) {
  return Object.fromEntries(await Promise.all(PREPARATION_FILES.map(async (file) => [file, await readFile(path.join(root, file), "utf8")])));
}

async function alreadyPrepared(root, preflight) {
  const qualification = await readOpenClawQualification(root);
  if (qualification.stableVersion !== preflight.proposed.version) return null;
  if (qualification.upstream.releaseCommit !== preflight.proposed.upstream.commit
      || qualification.npm.integrity !== preflight.proposed.npm.integrity
      || qualification.provider.integrity !== preflight.proposed.providerNpm.integrity
      || qualification.image.linuxAmd64Digest !== preflight.proposed.image.linuxAmd64Digest) {
    throw new Error("conflicting partial preparation exists for this OpenClaw version");
  }
  const verification = await verifyOpenClawQualification({ root });
  const plugin = JSON.parse(await readFile(path.join(root, "packages/openclaw-plugin/package.json"), "utf8"));
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const pluginEntries = [...changelog.matchAll(/^## OpenClaw plugin \[([^\]]+)\]/gmu)].map((match) => match[1]);
  if (plugin.version !== nextPatchVersion(preflight.current.pluginVersion)
      || pluginEntries.length < 2 || pluginEntries[0] !== plugin.version || nextPatchVersion(pluginEntries[1]) !== plugin.version
      || !changelog.includes(`## OpenClaw plugin [${plugin.version}]`)
      || !changelog.includes(`Qualified the stable OpenClaw \`${qualification.stableVersion}\` runtime`)) {
    throw new Error("conflicting partial preparation is missing its canonical changelog entry");
  }
  return { status: "already-prepared", pluginVersion: plugin.version, qualification, verification };
}

export async function prepareOpenClawUpgrade({ root, baseline, preflight, lockfileMode = "update", generatedLockfileContents, preparedDate = preflight.observedAt.slice(0, 10), soakWaived = false }) {
  const assessment = assessUpgradeEvidence({ baseline, current: preflight });
  if (assessment.decision === "blocked" || (assessment.decision === "waiting" && soakWaived !== true)) throw new Error(`OpenClaw upgrade is not ready: ${[...assessment.blockers, assessment.decision === "waiting" ? `soak completes at ${assessment.soakCompletesAt}` : ""].filter(Boolean).join("; ")}`);
  const repeat = await alreadyPrepared(root, preflight);
  if (repeat) return { ...repeat, assessment };
  const originals = await readPreparationFiles(root);
  let generatedLockfile = originals["package-lock.json"];
  let prepared;
  if (lockfileMode === "verify") {
    if (typeof generatedLockfileContents !== "string") throw new Error("verify lockfile mode requires generatedLockfileContents");
    prepared = buildPreparedFiles({ files: originals, preflight, generatedLockfile: generatedLockfileContents, preparedDate });
  } else if (lockfileMode === "update") {
    const withoutLock = { ...originals };
    // First derive every deterministic edit using a placeholder lock that will be replaced after npm runs.
    const oldLock = JSON.parse(originals["package-lock.json"]);
    const oldPlugin = JSON.parse(originals["packages/openclaw-plugin/package.json"]);
    const targetPluginVersion = nextPatchVersion(oldPlugin.version);
    oldLock.packages[""].devDependencies.openclaw = `^${preflight.proposed.version}`;
    oldLock.packages["packages/openclaw-plugin"].version = targetPluginVersion;
    oldLock.packages["packages/openclaw-plugin"].peerDependencies.openclaw = `>=${JSON.parse(originals["openclaw-qualification.json"]).apiFloor} <${preflight.proposed.version.split(".").slice(0, 2).join(".")}.${Number(preflight.proposed.version.split(".")[2]) + 1}-0`;
    oldLock.packages["node_modules/openclaw"] = { ...oldLock.packages["node_modules/openclaw"], version: preflight.proposed.version,
      resolved: `https://registry.npmjs.org/openclaw/-/openclaw-${preflight.proposed.version}.tgz`, integrity: preflight.proposed.npm.integrity };
    try {
      prepared = buildPreparedFiles({ files: withoutLock, preflight, generatedLockfile: json(oldLock), preparedDate });
      for (const file of PREPARATION_FILES.filter((file) => file !== "package-lock.json")) await writeFile(path.join(root, file), prepared.files[file]);
      const result = spawnSync("mise", ["exec", "--", "npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", `openclaw@${preflight.proposed.version}`], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (result.status !== 0) throw new Error(`managed npm lockfile regeneration failed: ${result.stderr.trim()}`);
      generatedLockfile = await readFile(path.join(root, "package-lock.json"), "utf8");
      prepared = buildPreparedFiles({ files: originals, preflight, generatedLockfile, preparedDate });
    } catch (error) {
      for (const file of PREPARATION_FILES) await writeFile(path.join(root, file), originals[file]);
      throw error;
    }
  } else {
    throw new Error("lockfileMode must be update or verify");
  }
  let verification;
  try {
    for (const file of PREPARATION_FILES) await writeFile(path.join(root, file), prepared.files[file]);
    verification = await verifyOpenClawQualification({ root });
  } catch (error) {
    for (const file of PREPARATION_FILES) await writeFile(path.join(root, file), originals[file]);
    throw error;
  }
  return { status: "prepared", pluginVersion: prepared.pluginVersion, qualification: prepared.qualification, assessment, verification };
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || !args[index + 1] || values.has(args[index])) throw new Error("invalid or duplicate argument");
    values.set(args[index], args[index + 1]);
  }
  if (!values.has("--preflight") || !values.has("--baseline")) {
    throw new Error("Usage: prepare-openclaw-upgrade.mjs --preflight <json> --baseline <json> [--root <path>] [--lockfile-mode update|verify] [--generated-lockfile <path>] [--date YYYY-MM-DD] [--soak-waived true|false]");
  }
  return values;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const root = path.resolve(args.get("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
    const [baseline, preflight] = await Promise.all([args.get("--baseline"), args.get("--preflight")].map(async (file) => JSON.parse(await readFile(file, "utf8"))));
    const generatedLockfileContents = args.get("--generated-lockfile") ? await readFile(args.get("--generated-lockfile"), "utf8") : undefined;
    const soakWaived = args.get("--soak-waived") === undefined ? false : args.get("--soak-waived") === "true";
    if (args.get("--soak-waived") !== undefined && !["true", "false"].includes(args.get("--soak-waived"))) throw new Error("--soak-waived must be true or false");
    const result = await prepareOpenClawUpgrade({ root, baseline, preflight, lockfileMode: args.get("--lockfile-mode") ?? "update", generatedLockfileContents, preparedDate: args.get("--date"), soakWaived });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
