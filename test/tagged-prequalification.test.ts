import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyReleaseStateIntent, createReleaseState } from "../scripts/openclaw-release-state.mjs";
import { authenticateTaggedPrequalification, verifyTaggedPrequalification } from "../scripts/verify-tagged-prequalification.mjs";
import { calculateAutomationFingerprint } from "../scripts/release-automation-fingerprint.mjs";
import { classifyOpenClawRelease } from "../scripts/classify-openclaw-release.mjs";

const pluginBytes = Buffer.from("synthetic exact qualified plugin; no product archive");
const counterpartBytes = Buffer.from("synthetic exact pinned counterpart; no extension archive");
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function preflight(observedAt = "2026-09-26T00:00:00.000Z") {
  return {
    format: "thunderclaw-openclaw-upgrade-preflight-v2",
    observedAt,
    current: { version: "2026.9.5", releaseCommit: sha("1"), pluginVersion: "0.1.9" },
    proposed: {
      version: "2026.9.6",
      npm: { package: "openclaw", version: "2026.9.6", integrity: `sha512-${"A".repeat(86)}==`, tarball: "https://registry.npmjs.org/openclaw.tgz" },
      providerNpm: { package: "@openclaw/deepseek-provider", version: "2026.9.6", integrity: `sha512-${"B".repeat(86)}==`, tarball: "https://registry.npmjs.org/provider.tgz" },
      upstream: { repository: "openclaw/openclaw", tag: "v2026.9.6", releaseTag: "v2026.9.6", commit: sha("2"),
        verifiedTag: false, verifiedCommit: false, tagKind: "lightweight", officialRelease: true, releaseId: 77,
        releaseUrl: "https://github.com/openclaw/openclaw/releases/tag/v2026.9.6", publishedAt: "2026-09-24T00:00:00.000Z", draft: false, prerelease: false },
      image: { repository: "ghcr.io/openclaw/openclaw", tag: "2026.9.6", indexDigest: `sha256:${digest("3")}`, linuxAmd64Digest: `sha256:${digest("4")}` },
    },
    sdk: {
      requiredEntrypoints: ["./plugin-sdk/agent-runtime", "./plugin-sdk/cli-argv", "./plugin-sdk/gateway-runtime", "./plugin-sdk/plugin-entry"],
      missingEntrypoints: [],
      declarationFiles: ["dist/plugin-sdk/agent-runtime.d.ts", "dist/plugin-sdk/cli-argv.d.ts", "dist/plugin-sdk/gateway-runtime.d.ts", "dist/plugin-sdk/plugin-entry.d.ts"],
      changedDeclarations: [],
      currentHashes: Object.fromEntries(["agent-runtime", "cli-argv", "gateway-runtime", "plugin-entry"].map((name) => [`dist/plugin-sdk/${name}.d.ts`, digest("8")])),
      proposedHashes: Object.fromEntries(["agent-runtime", "cli-argv", "gateway-runtime", "plugin-entry"].map((name) => [`dist/plugin-sdk/${name}.d.ts`, digest("9")])),
    },
    repositoryImpact: [], blockingFindings: [], advisoryFindings: ["unsigned tag is advisory"], compatibilityDecision: "not-made",
  };
}

function fixture() {
  const reservationId = "a".repeat(32);
  const baseSha = sha("b");
  let state = createReleaseState(preflight(), { reservationId, baseSha });
  const apply = (type: string, payload: Record<string, unknown>) => {
    const outcome = applyReleaseStateIntent(state, { format: "thunderclaw-openclaw-autopilot-intent-v1",
      intentId: `${state.revision}-${type}`, expectedRevision: state.revision, type, at: "2026-09-27T00:00:00.000Z", payload });
    assert.equal(outcome.decision, "applied");
    state = outcome.state;
  };
  apply("reobserve", { preflight: preflight("2026-09-27T00:00:00.000Z"), baseSha });
  const automation = { controllerWorkflowSha: digest("1"), qualificationWorkflowSha: digest("2"), releaseWorkflowSha: digest("3"), classifierSha: digest("4") };
  const counterpart = { repository: "kwatson/thunderclaw", tag: "thunderbird-extension-v0.1.2",
    name: "thunderclaw-thunderbird-0.1.2.xpi", sha256: hash(counterpartBytes), size: counterpartBytes.length };
  const preparation = { reservationId, pluginVersion: "0.1.10", preparedDate: "2026-09-27", baseSha,
    branch: "automation/openclaw-2026.9.6", prNumber: 42, candidateSha: sha("c"), candidateTree: sha("d"),
    tag: "openclaw-plugin-v0.1.10", classificationEvidenceSha256: digest("6"), counterpart, automation };
  apply("record-preparation", preparation);
  apply("record-qualification-dispatch", { requestId: "7".repeat(32), workflow: ".github/workflows/qualify-openclaw-autopilot.yml",
    workflowCommit: sha("8"), workflowSha256: automation.qualificationWorkflowSha, dispatchedAt: "2026-09-27T00:00:00.000Z" });
  const result = {
    format: "thunderclaw-openclaw-autopilot-result-v1", repository: "kwatson/thunderclaw", repositoryId: 1234,
    workflow: ".github/workflows/qualify-openclaw-autopilot.yml", workflowCommit: sha("8"),
    workflowSha256: automation.qualificationWorkflowSha, event: "workflow_dispatch",
    runId: 99, runAttempt: 2, requestId: "7".repeat(32), reservationId, version: "2026.9.6",
    identitySha256: state.identitySha256, baseSha, tag: preparation.tag,
    candidate: { ref: preparation.branch, sha: preparation.candidateSha, tree: preparation.candidateTree },
    counterpart, classification: { decision: "compatibility-only", evidenceSha256: preparation.classificationEvidenceSha256 },
    candidateArtifactSha256: hash(pluginBytes),
    automation,
    gates: { deterministic: "success", "openclaw-integration": "success", "pair-qualification": "success",
      "thunderbird-linux": "success", "native-windows": "success", "native-macos": "success" }, decision: "pass",
  };
  const resultSha256 = hash(JSON.stringify(result));
  apply("record-qualification", { requestId: result.requestId, workflow: result.workflow, workflowCommit: result.workflowCommit,
    workflowSha256: automation.qualificationWorkflowSha, runId: result.runId, runAttempt: result.runAttempt,
    headSha: preparation.candidateSha, headBranch: preparation.branch, event: "workflow_dispatch", conclusion: "success",
    evidenceSha256: resultSha256, classificationEvidenceSha256: preparation.classificationEvidenceSha256,
    candidateArtifactSha256: result.candidateArtifactSha256, counterpart });
  apply("record-merge", { mergeSha: sha("e"), mergeTree: preparation.candidateTree, tag: preparation.tag });
  apply("record-tag", { tag: preparation.tag, commit: sha("e"), tree: preparation.candidateTree });
  const run = { id: 99, run_attempt: 2, event: "workflow_dispatch", status: "completed", conclusion: "success",
    head_sha: sha("8"), head_branch: "main", path: ".github/workflows/qualify-openclaw-autopilot.yml@refs/heads/main",
    repository: { full_name: "kwatson/thunderclaw", id: 1234 } };
  const context = { repository: "kwatson/thunderclaw", repositoryId: 1234, tag: preparation.tag,
    commit: sha("e"), tree: preparation.candidateTree, pluginVersion: preparation.pluginVersion };
  const classification = { decision: "compatibility-only", findings: [], evidenceSha256: preparation.classificationEvidenceSha256 };
  return { state, stateCommit: sha("f"), result, resultSha256, run, context, classification, automation, counterpart };
}

function reuseFixture() {
  const classificationInput = fixture();
  const { repository, tag } = classificationInput.context;
  return { classificationInput, pluginBytes, counterpartBytes, counterpartName: classificationInput.counterpart.name,
    entry: { reuseRequested: true, component: "openclaw-plugin", releaseLane: "automatic", event: "push",
      repository, tag, ref: `refs/tags/${tag}`, workflowRef: `${repository}/.github/workflows/release-openclaw-plugin.yml@refs/tags/${tag}` },
    jobs: ["Bind immutable source and trusted workflow", "Deterministic tests, types, and packages", "Pinned OpenClaw integration", "Thunderbird Linux qualification", "Native Windows qualification", "Native macOS qualification", "Protected exact-pair real-agent qualification", "Bind successful qualification result"].map((name) => ({ name, status: "completed", conclusion: "success" })),
  };
}

test("tagged prequalification binds actual files to independently classified complete gate evidence", () => {
  const input = reuseFixture();
  const receipt = verifyTaggedPrequalification(input);
  assert.equal(receipt.decision, "pass");
  assert.equal(receipt.plugin.sha256, hash(pluginBytes));
  assert.equal(receipt.counterpart.sha256, hash(counterpartBytes));
  assert.equal(receipt.qualification.runAttempt, input.classificationInput.run.run_attempt);
  assert.equal(receipt.reservationId, input.classificationInput.result.reservationId);
  assert.equal(JSON.stringify(receipt).includes(pluginBytes.toString()), false);
  assert.equal(JSON.stringify(receipt).includes(counterpartBytes.toString()), false);
});

test("tagged prequalification rejects altered bytes, pin, source, reservation, attempt and machinery", () => {
  for (const mutate of [
    (value: any) => { value.pluginBytes = Buffer.from("altered plugin"); },
    (value: any) => { value.counterpartBytes = Buffer.from("altered counterpart"); },
    (value: any) => { value.counterpartName = "other.xpi"; },
    (value: any) => { value.classificationInput.counterpart.size++; },
    (value: any) => { value.classificationInput.context.tree = sha("0"); },
    (value: any) => { value.classificationInput.context.commit = sha("0"); },
    (value: any) => { value.classificationInput.result.requestId = "0".repeat(32); },
    (value: any) => { value.classificationInput.result.reservationId = "0".repeat(32); },
    (value: any) => { value.classificationInput.run.id++; },
    (value: any) => { value.classificationInput.run.run_attempt++; },
    (value: any) => { value.classificationInput.automation.classifierSha = digest("0"); },
    (value: any) => { value.classificationInput.automation.releaseWorkflowSha = digest("0"); },
    (value: any) => { value.classificationInput.classification.decision = "blocked"; },
  ]) {
    const input = reuseFixture(); mutate(input); assert.throws(() => verifyTaggedPrequalification(input));
  }
});

test("tagged prequalification rejects waived, missing, duplicate and nonterminal actual gates", () => {
  for (const index of reuseFixture().jobs.keys()) {
    for (const conclusion of ["failure", "cancelled", "skipped", "action_required"]) {
      const input = reuseFixture(); input.jobs[index]!.conclusion = conclusion;
      assert.throws(() => verifyTaggedPrequalification(input), /successful recorded job/u);
    }
    const missing = reuseFixture(); missing.jobs.splice(index, 1);
    assert.throws(() => verifyTaggedPrequalification(missing), /successful recorded job/u);
    const duplicate = reuseFixture(); duplicate.jobs.push(duplicate.jobs[index]!);
    assert.throws(() => verifyTaggedPrequalification(duplicate), /successful recorded job/u);
    const unfinished = reuseFixture(); unfinished.jobs[index]!.status = "in_progress";
    assert.throws(() => verifyTaggedPrequalification(unfinished), /successful recorded job/u);
  }
  const skipped = reuseFixture(); skipped.classificationInput.result.gates["pair-qualification"] = "skipped";
  assert.throws(() => verifyTaggedPrequalification(skipped), /without skips or waivers/u);
});

test("reuse rejects pretag automatic, manual, extension and untrusted caller entry points", async () => {
  for (const change of [{ reuseRequested: false }, { event: "workflow_dispatch" }, { event: "pull_request_target" },
    { ref: "refs/heads/main" }, { component: "thunderbird-extension" }, { releaseLane: "manual" },
    { releaseLane: "foundation" }, { workflowRef: "attacker/repo/.github/workflows/release-openclaw-plugin.yml@refs/tags/openclaw-plugin-v0.1.10" },
    { workflowRef: "kwatson/thunderclaw/.github/workflows/qualify-openclaw-autopilot.yml@refs/heads/main" }]) {
    const input = reuseFixture(); Object.assign(input.entry, change);
    assert.throws(() => verifyTaggedPrequalification(input), /explicit automatic plugin release tag push/u);
  }
  let commands = 0;
  await assert.rejects(authenticateTaggedPrequalification({ root: ".", plugin: "unused", counterpart: "unused", environment: {},
    execute: (() => { commands++; throw new Error("canary secret should not be emitted"); }) as any }), /explicit automatic plugin release tag push/u);
  assert.equal(commands, 0, "untrusted entry must be rejected before API, git or file access");
});

test("automatic tagged workflow verifies proof while manual and default pair paths retain full trials", async () => {
  const plugin = await readFile(new URL("../.github/workflows/release-openclaw-plugin.yml", import.meta.url), "utf8");
  const pair = await readFile(new URL("../.github/workflows/qualify-release-pair.yml", import.meta.url), "utf8");
  assert.match(plugin, /Authenticate exact pre-tag integration[\s\S]*?if: needs\.classify\.outputs\.release_lane == 'automatic'[\s\S]*?verify-tagged-prequalification\.mjs/u);
  assert.match(plugin, /Verify and qualify exact plugin bytes\n\s+if: needs\.classify\.outputs\.release_lane != 'automatic'[\s\S]*?npm run test:integration:openclaw/u);
  assert.match(plugin, /reuse_prequalification: \$\{\{ needs\.classify\.outputs\.release_lane == 'automatic' \}\}/u);
  assert.match(pair, /reuse_prequalification:[\s\S]*?default: false[\s\S]*?type: boolean/u);
  for (const step of ["Create protected synthetic qualification environment", "Install exact plugin and build exact-XPI Thunderbird lane", "Exercise the exact pair through the protected product harness"]) {
    assert.ok(pair.includes(`${step}\n        if: '!inputs.reuse_prequalification'`));
  }
  assert.match(pair, /Authenticate exact pre-tag pair[\s\S]*?if: inputs\.reuse_prequalification[\s\S]*?verify-tagged-prequalification\.mjs/u);
  assert.match(pair, /if: always\(\) && !inputs\.reuse_prequalification/u);
});

test("tag proof acquisition executes reserved classifier and authenticated attempt queries with bounded subprocesses", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-tag-proof-test-"));
  try {
    const input = reuseFixture();
    const evidence = input.classificationInput;
    const fingerprint = calculateAutomationFingerprint(() => "synthetic source bytes\n");
    evidence.automation = { controllerWorkflowSha: fingerprint.controllerWorkflowSha256, qualificationWorkflowSha: fingerprint.qualificationWorkflowSha256,
      releaseWorkflowSha: fingerprint.releaseWorkflowSha256, classifierSha: fingerprint.classifierSha256 };
    evidence.state.outputs.preparation.automation = evidence.automation;
    evidence.state.outputs.qualificationDispatch.workflowSha256 = fingerprint.qualificationWorkflowSha256;
    evidence.state.outputs.qualification.workflowSha256 = fingerprint.qualificationWorkflowSha256;
    evidence.result.automation = evidence.automation;
    evidence.result.workflowSha256 = fingerprint.qualificationWorkflowSha256;
    const resultBytes = JSON.stringify(evidence.result);
    evidence.resultSha256 = hash(resultBytes);
    evidence.state.outputs.qualification.evidenceSha256 = evidence.resultSha256;
    const plugin = path.join(directory, "synthetic.tgz");
    const counterpart = path.join(directory, evidence.counterpart.name);
    await Promise.all([writeFile(plugin, pluginBytes), writeFile(counterpart, counterpartBytes)]);
    const environment = { THUNDERCLAW_REUSE_PREQUALIFICATION: "true", THUNDERCLAW_QUALIFICATION_COMPONENT: "openclaw-plugin", RELEASE_LANE: "automatic",
      GITHUB_EVENT_NAME: "push", GITHUB_REF: input.entry.ref, GITHUB_WORKFLOW_REF: input.entry.workflowRef, GITHUB_REPOSITORY: input.entry.repository,
      GITHUB_REF_NAME: input.entry.tag, GITHUB_SHA: evidence.context.commit, GITHUB_REPOSITORY_ID: String(evidence.context.repositoryId) };
    const calls: { command: string; args: string[]; timeout: number; cwd: string }[] = [];
    const execute = ((command: string, args: string[], options: any) => {
      calls.push({ command, args, timeout: options.timeout, cwd: options.cwd });
      if (command === "git") {
        if (args[0] === "rev-parse") return evidence.context.commit;
        if (args[0] === "worktree") return "";
        if (args.includes("--format=%T")) return evidence.context.tree;
        if (args[1]?.endsWith("counterpart-baselines.json")) return JSON.stringify({ "thunderbird-extension": { tag: evidence.counterpart.tag, name: evidence.counterpart.name, sha256: evidence.counterpart.sha256, size: evidence.counterpart.size } });
        if (args[1]?.endsWith("packages/openclaw-plugin/package.json")) return JSON.stringify({ version: evidence.context.pluginVersion });
        return Buffer.from("synthetic source bytes\n");
      }
      if (command === "mise") {
        if (args.includes("classifier")) return fingerprint.classifierSha256;
        assert.ok(args.some((argument) => argument.endsWith("trusted/scripts/classify-openclaw-release.mjs")));
        assert.equal(args[args.indexOf("--state-commit") + 1], evidence.stateCommit);
        assert.equal(args[args.indexOf("--tree") + 1], evidence.context.tree);
        return JSON.stringify(classifyOpenClawRelease(evidence));
      }
      assert.equal(command, "gh");
      if (args[0] === "run") {
        const destination = args[args.indexOf("--dir") + 1]!;
        mkdirSync(destination, { recursive: true }); writeFileSync(path.join(destination, "result.json"), resultBytes);
        assert.equal(args[args.indexOf("--name") + 1], `openclaw-autopilot-result-${evidence.result.requestId}-${evidence.run.run_attempt}`);
        return "";
      }
      if (args.includes("--paginate")) return JSON.stringify([{ jobs: input.jobs }]);
      if (args[1]!.includes("git/ref/")) return JSON.stringify({ object: { sha: evidence.stateCommit } });
      if (args[1]!.includes("contents/")) return JSON.stringify({ encoding: "base64", content: Buffer.from(JSON.stringify(evidence.state)).toString("base64") });
      return JSON.stringify(evidence.run);
    }) as any;
    const receipt = await authenticateTaggedPrequalification({ root: directory, plugin, counterpart, environment, execute });
    assert.equal(receipt.decision, "pass");
    assert.ok(calls.some((call) => call.args.includes(`repos/${input.entry.repository}/actions/runs/${evidence.run.id}/attempts/${evidence.run.run_attempt}/jobs?per_page=100`)));
    assert.equal(calls.filter((call) => call.command === "mise").length, 2);
    assert.ok(calls.every((call) => call.timeout === 300_000));
    const resultOutput = execFileSync(process.execPath, ["scripts/verify-tagged-prequalification.mjs", "--bad-canary-secret", "canary-secret"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.fail(resultOutput);
  } catch (error: any) {
    // CLI rejection is generic; it must never repeat an argument or raw stderr.
    if (error.status !== 1) throw error;
    assert.match(error.stderr, /Tagged prequalification verification failed/u);
    assert.equal(error.stderr.includes("canary-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
