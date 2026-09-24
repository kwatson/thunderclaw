import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { classifyOpenClawRelease } from "../scripts/classify-openclaw-release.mjs";
import { applyReleaseStateIntent, createReleaseState } from "../scripts/openclaw-release-state.mjs";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

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
    name: "thunderclaw-thunderbird-0.1.2.xpi", sha256: digest("5"), size: 4567 };
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
    candidateArtifactSha256: digest("9"),
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

test("release classifier selects automatic only for the exact active reservation and authenticated run", () => {
  const input = fixture();
  assert.equal(classifyOpenClawRelease(input).releaseLane, "automatic");
  for (const mutate of [
    (copy: any) => { copy.context.commit = sha("0"); },
    (copy: any) => { copy.context.tree = sha("0"); },
    (copy: any) => { copy.run.id = 100; },
    (copy: any) => { copy.run.run_attempt = 3; },
    (copy: any) => { copy.counterpart.sha256 = digest("0"); },
    (copy: any) => { copy.automation.releaseWorkflowSha = digest("0"); },
    (copy: any) => { copy.classification.decision = "blocked"; },
  ]) {
    const copy = structuredClone(input);
    mutate(copy);
    assert.throws(() => classifyOpenClawRelease(copy), /reservation|counterpart|automation|classification/u);
  }
});

test("release classifier rejects skipped gates and forged qualification evidence", () => {
  const skipped = fixture();
  skipped.result.gates["native-macos"] = "skipped";
  assert.throws(() => classifyOpenClawRelease(skipped), /without skips or waivers/u);
  const forged = fixture();
  forged.result.runAttempt = 8;
  assert.throws(() => classifyOpenClawRelease(forged), /reserved value/u);
  const copied = fixture();
  copied.stateCommit = "not-the-durable-ref-commit";
  assert.throws(() => classifyOpenClawRelease(copied), /state ref commit/u);
});

test("release classifier compares evidence structurally rather than by object key order", () => {
  const input = fixture();
  input.automation = { classifierSha: input.automation.classifierSha, releaseWorkflowSha: input.automation.releaseWorkflowSha,
    qualificationWorkflowSha: input.automation.qualificationWorkflowSha, controllerWorkflowSha: input.automation.controllerWorkflowSha };
  input.counterpart = { size: input.counterpart.size, sha256: input.counterpart.sha256, name: input.counterpart.name,
    tag: input.counterpart.tag, repository: input.counterpart.repository };
  assert.equal(classifyOpenClawRelease(input).releaseLane, "automatic");
});
