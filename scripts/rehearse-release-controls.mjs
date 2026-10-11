import assert from "node:assert/strict";
import { applyReleaseStateIntent, createReleaseState } from "./openclaw-release-state.mjs";
import { classifyQualificationFailure } from "./classify-openclaw-qualification-failure.mjs";
import { selectQualificationRun, authenticateDispatchMismatch } from "./openclaw-qualification-reconciliation.mjs";
import { planPublicationRecovery, verifyCloseoutEvidence } from "./openclaw-controller-recovery.mjs";

const hex = (character, length) => character.repeat(length);
const repository = "synthetic/thunderclaw";
const tag = "openclaw-plugin-v1.2.3";
const workflow = ".github/workflows/qualify-openclaw-autopilot.yml";
const at = "2026-10-11T02:00:00.000Z";

// Synthetic API records exercise production admission and state transitions.
// They intentionally cannot establish live GitHub environment or event behavior.
function preflight(observedAt = "2026-10-11T01:00:00.000Z") {
  const version = "2026.10.2";
  const declarationFiles = ["agent-runtime", "cli-argv", "gateway-runtime", "plugin-entry"].map((name) => `dist/plugin-sdk/${name}.d.ts`);
  return {
    format: "thunderclaw-openclaw-upgrade-preflight-v2", observedAt,
    current: { version: "2026.10.1", releaseCommit: hex("a", 40), pluginVersion: "1.2.2" },
    proposed: { version,
      npm: { package: "openclaw", version, integrity: "sha512-AAAA", tarball: "https://registry.npmjs.org/synthetic.tgz" },
      providerNpm: { package: "@openclaw/deepseek-provider", version, integrity: "sha512-BBBB", tarball: "https://registry.npmjs.org/synthetic-provider.tgz" },
      upstream: { repository: "openclaw/openclaw", tag: `v${version}`, releaseTag: `v${version}`, commit: hex("b", 40), verifiedTag: false, verifiedCommit: false, tagKind: "lightweight", officialRelease: true, releaseId: 42, releaseUrl: `https://github.com/openclaw/openclaw/releases/tag/v${version}`, publishedAt: "2026-10-11T00:00:00.000Z", draft: false, prerelease: false },
      image: { repository: "ghcr.io/openclaw/openclaw", tag: version, indexDigest: `sha256:${hex("c", 64)}`, linuxAmd64Digest: `sha256:${hex("d", 64)}` } },
    sdk: { requiredEntrypoints: ["./plugin-sdk/agent-runtime", "./plugin-sdk/cli-argv", "./plugin-sdk/gateway-runtime", "./plugin-sdk/plugin-entry"], missingEntrypoints: [], declarationFiles, changedDeclarations: [], currentHashes: Object.fromEntries(declarationFiles.map((name) => [name, hex("1", 64)])), proposedHashes: Object.fromEntries(declarationFiles.map((name) => [name, hex("2", 64)])) },
    upstreamCi: { conclusion: "success", waived: false }, repositoryImpact: [], blockingFindings: [], advisoryFindings: [], compatibilityDecision: "not-made",
  };
}

function intent(state, type, payload, intentId = type) {
  return { format: "thunderclaw-openclaw-autopilot-intent-v1", intentId, expectedRevision: state.revision, type, at, payload };
}
function advance(state, type, payload) {
  const result = applyReleaseStateIntent(state, intent(state, type, payload));
  assert.equal(result.decision, "applied");
  return result.state;
}
function qualifyingState() {
  let state = createReleaseState(preflight(), { reservationId: hex("1", 32), baseSha: hex("2", 40) });
  state = advance(state, "reobserve", { preflight: preflight(at), baseSha: state.baseSha });
  state = advance(state, "record-preparation", { reservationId: state.reservationId, pluginVersion: "1.2.3", preparedDate: "2026-10-11", baseSha: state.baseSha, branch: "automation/synthetic-candidate", prNumber: 7, candidateSha: hex("3", 40), candidateTree: hex("4", 40), tag, classificationEvidenceSha256: hex("5", 64), counterpart: { repository, tag: "thunderbird-extension-v1.0.0", name: "synthetic.xpi", sha256: hex("6", 64), size: 42 }, automation: { controllerWorkflowSha: hex("7", 64), qualificationWorkflowSha: hex("8", 64), classifierSha: hex("9", 64), releaseWorkflowSha: hex("a", 64) } });
  return advance(state, "record-qualification-dispatch", { requestId: "synthetic-request", workflow, workflowCommit: state.baseSha, workflowSha256: hex("8", 64), dispatchedAt: at });
}
function qualificationRun(state, overrides = {}) {
  return { id: 100, run_attempt: 1, repository: { full_name: repository }, head_repository: { full_name: repository }, display_title: `Qualify OpenClaw ${state.identity.version} (${state.outputs.qualificationDispatch.requestId})`, event: "workflow_dispatch", path: workflow, head_branch: "main", head_sha: state.baseSha, status: "completed", conclusion: "success", ...overrides };
}
const jobNames = ["Bind immutable source and trusted workflow", "Deterministic tests, types, and packages", "Pinned OpenClaw integration", "Thunderbird Linux qualification", "Native Windows qualification", "Native macOS qualification", "Protected exact-pair real-agent qualification", "Bind successful qualification result"];
const jobs = (conclusions) => jobNames.map((name, index) => ({ name, status: "completed", conclusion: conclusions[index] }));

export function rehearseReleaseControls() {
  const cases = [];
  let state = qualifyingState();
  const pendingRun = qualificationRun(state, { status: "queued", conclusion: null });
  // Dispatch succeeded but its client response was lost: rediscovery waits for
  // the authenticated existing run rather than interpreting a timeout as absence.
  assert.equal(selectQualificationRun({ state, repository, runs: [pendingRun] }).action, "wait");
  assert.equal(selectQualificationRun({ state, repository, runs: [qualificationRun(state)] }).action, "completed");
  assert.throws(() => selectQualificationRun({ state, repository, runs: [pendingRun, pendingRun] }), /ambiguous/u);
  cases.push("lost-dispatch-response-rediscovery");

  const denied = classifyQualificationFailure({ state, run: qualificationRun(state, { conclusion: "action_required" }), jobs: jobs(["success", "success", "success", "success", "success", "success", "action_required", "failure"]) });
  assert.equal(denied.classification.disposition, "blocked");
  const blocked = advance(state, "record-qualification-failure", denied);
  assert.equal(applyReleaseStateIntent(blocked, intent(blocked, "record-tag", {})).decision, "terminal");
  cases.push("protected-environment-denial-blocks-promotion");

  const cancelled = classifyQualificationFailure({ state, run: qualificationRun(state, { conclusion: "cancelled" }), jobs: jobs(["success", "success", "success", "success", "success", "success", "cancelled", "skipped"]) });
  const stopped = advance(state, "record-qualification-failure", cancelled);
  assert.equal(stopped.phase, "cancelled");
  assert.equal(applyReleaseStateIntent(stopped, intent(stopped, "restart-completed-qualification", {})).decision, "terminal");
  cases.push("cancelled-qualification-is-terminal");

  const raced = qualificationRun(state, { head_sha: hex("f", 40), conclusion: "failure" });
  const skipped = jobs(["failure", "skipped", "skipped", "skipped", "skipped", "skipped", "skipped", "failure"]);
  assert.equal(authenticateDispatchMismatch({ state, repository, run: raced, jobs: skipped }), true);
  const hiddenGate = structuredClone(skipped); hiddenGate[2].conclusion = "failure";
  assert.throws(() => authenticateDispatchMismatch({ state, repository, run: raced, jobs: hiddenGate }), /gate result/u);
  cases.push("dispatch-main-race-preserves-gate-evidence");

  const preparation = state.outputs.preparation;
  const dispatch = state.outputs.qualificationDispatch;
  state = advance(state, "record-qualification", { requestId: dispatch.requestId, workflow, workflowCommit: dispatch.workflowCommit, workflowSha256: dispatch.workflowSha256, runId: 100, runAttempt: 1, headSha: preparation.candidateSha, headBranch: preparation.branch, event: "workflow_dispatch", conclusion: "success", evidenceSha256: hex("b", 64), classificationEvidenceSha256: preparation.classificationEvidenceSha256, candidateArtifactSha256: hex("c", 64), counterpart: preparation.counterpart });
  assert.throws(() => applyReleaseStateIntent(state, intent(state, "record-merge", { mergeSha: hex("d", 40), mergeTree: hex("e", 40), tag })), /qualified candidate/u);
  const mergeIntent = intent(state, "record-merge", { mergeSha: hex("d", 40), mergeTree: preparation.candidateTree, tag });
  const concurrent = advance(state, "block", { reason: "main advanced while merge was being admitted" });
  assert.equal(applyReleaseStateIntent(concurrent, mergeIntent).decision, "compare-and-swap-mismatch");
  cases.push("merge-race-rejects-different-tree-and-stale-revision");

  state = applyReleaseStateIntent(state, mergeIntent).state;
  state = advance(state, "record-tag", { tag, commit: hex("d", 40), tree: preparation.candidateTree });
  const recovery = { repository, state, sourceRuns: [{ id: 200, repository: { full_name: repository }, event: "push", path: ".github/workflows/release-openclaw-plugin.yml", head_sha: hex("d", 40), head_branch: tag, status: "completed", conclusion: "failure" }], recoveryRuns: [], release: { tag_name: tag, draft: false, prerelease: false } };
  const deniedRecovery = { id: 201, repository: { full_name: repository }, event: "workflow_dispatch", path: ".github/workflows/complete-plugin-publication.yml", head_branch: "main", display_title: `Complete publication ${tag}`, status: "completed", conclusion: "action_required" };
  assert.throws(() => planPublicationRecovery({ ...recovery, recoveryRuns: [deniedRecovery] }), /operator retry/u);
  assert.throws(() => planPublicationRecovery({ ...recovery, recoveryRuns: [{ ...deniedRecovery, conclusion: "cancelled" }] }), /cancelled/u);
  assert.equal(planPublicationRecovery({ ...recovery, recoveryRuns: [{ ...deniedRecovery, status: "queued", conclusion: null }] }).action, "wait");
  cases.push("denied-or-cancelled-finalizer-requires-operator");

  state = advance(state, "record-github-publication", { tag, commit: hex("d", 40), artifactSha256: hex("c", 64), releaseId: 9 });
  state = advance(state, "record-clawhub-verification", { tag, version: "1.2.3", artifactSha256: hex("c", 64), verifiedAt: at });
  const baseline = { repository, tag, name: "synthetic.tgz", sha256: hex("c", 64), size: 42 };
  state = advance(state, "open-closeout", { branch: "automation/synthetic-closeout", prNumber: 8, baseline, headSha: hex("e", 40), tree: hex("f", 40) });
  const checks = [["Tests, types, and packages", "CI"], ["Signoffs", "DCO"], ["Release automation validation", "Release automation validation"]].map(([name, checkWorkflow]) => ({ name, workflow: checkWorkflow, state: "SUCCESS" }));
  const { repository: ignored, ...publishedBaseline } = baseline;
  const closeout = { state, repository, pr: { number: 8, base: { ref: "main", repo: { full_name: repository } }, head: { ref: "automation/synthetic-closeout", repo: { full_name: repository }, sha: hex("e", 40) }, merged: true, state: "closed", merge_commit_sha: hex("1", 40) }, checks, headTree: hex("f", 40), mergeTree: hex("2", 40), changedFiles: ["e2e/qualification/counterpart-baselines.json"], baselines: { "openclaw-plugin": publishedBaseline, "thunderbird-extension": { tag: "synthetic-extension" } }, baselinesBefore: { "openclaw-plugin": { tag: "synthetic-old" }, "thunderbird-extension": { tag: "synthetic-extension" } } };
  const verified = verifyCloseoutEvidence(closeout);
  assert.equal(verified.action, "complete");
  const completion = intent(state, "complete-closeout", { mergeSha: verified.mergeSha, mergeTree: verified.mergeTree });
  const completed = applyReleaseStateIntent(state, completion);
  assert.equal(completed.state.phase, "complete");
  assert.equal(applyReleaseStateIntent(completed.state, completion).decision, "already-applied");
  assert.equal(verifyCloseoutEvidence({ ...closeout, state: completed.state }).action, "complete");
  assert.throws(() => applyReleaseStateIntent(completed.state, { ...completion, payload: { ...completion.payload, mergeSha: hex("3", 40) } }), /reused with different content/u);
  assert.throws(() => verifyCloseoutEvidence({ ...closeout, state: completed.state, pr: { ...closeout.pr, merge_commit_sha: hex("3", 40) } }), /merge identity changed/u);
  cases.push("repeated-closeout-is-idempotent-and-identity-bound");
  return cases;
}
