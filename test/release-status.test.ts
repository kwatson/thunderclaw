import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createReleaseState, validateReleaseState } from "../scripts/openclaw-release-state.mjs";
import { collectReleaseStatus, formatReleaseStatus, type ReleaseStatusClient } from "../scripts/release-status.mjs";

const repository = "kwatson/thunderclaw";
const hex = (value: string, length = 40) => value.repeat(length);
const at = "2026-10-11T01:00:00.000Z";
const tag = "openclaw-plugin-v1.2.3";
const workflow = ".github/workflows/qualify-openclaw-autopilot.yml";
const jobNames = ["Bind immutable source and trusted workflow", "Deterministic tests, types, and packages",
  "Pinned OpenClaw integration", "Thunderbird Linux qualification", "Native Windows qualification",
  "Native macOS qualification", "Protected exact-pair real-agent qualification", "Bind successful qualification result"];

function fixture() {
  const version = "2026.10.2";
  const declarations = ["agent-runtime", "cli-argv", "gateway-runtime", "plugin-entry"].map((name) => `dist/plugin-sdk/${name}.d.ts`);
  const state = createReleaseState({
    format: "thunderclaw-openclaw-upgrade-preflight-v2", observedAt: at,
    current: { version: "2026.10.1", releaseCommit: hex("a"), pluginVersion: "1.2.2" },
    proposed: { version,
      npm: { package: "openclaw", version, integrity: "sha512-AAAA", tarball: "https://registry.npmjs.org/synthetic.tgz" },
      providerNpm: { package: "@openclaw/deepseek-provider", version, integrity: "sha512-BBBB", tarball: "https://registry.npmjs.org/synthetic-provider.tgz" },
      upstream: { repository: "openclaw/openclaw", tag: `v${version}`, releaseTag: `v${version}`, commit: hex("b"), verifiedTag: false, verifiedCommit: false, tagKind: "lightweight", officialRelease: true, releaseId: 42, releaseUrl: `https://github.com/openclaw/openclaw/releases/tag/v${version}`, publishedAt: "2026-10-11T00:00:00.000Z", draft: false, prerelease: false },
      image: { repository: "ghcr.io/openclaw/openclaw", tag: version, indexDigest: `sha256:${hex("c", 64)}`, linuxAmd64Digest: `sha256:${hex("d", 64)}` } },
    sdk: { requiredEntrypoints: declarations.map((name) => name.replace("dist/", "./").replace(".d.ts", "")), missingEntrypoints: [], declarationFiles: declarations, changedDeclarations: [], currentHashes: Object.fromEntries(declarations.map((name) => [name, hex("1", 64)])), proposedHashes: Object.fromEntries(declarations.map((name) => [name, hex("2", 64)])) },
    repositoryImpact: [], blockingFindings: [], advisoryFindings: [], compatibilityDecision: "not-made",
  }, { reservationId: hex("1", 32), baseSha: hex("2") });
  const counterpart = { repository, tag: "thunderbird-extension-v1.0.0", name: "thunderclaw-thunderbird-1.0.0.xpi", sha256: hex("6", 64), size: 42 };
  const automation = { controllerWorkflowSha: hex("7", 64), qualificationWorkflowSha: hex("8", 64), classifierSha: hex("9", 64), releaseWorkflowSha: hex("a", 64) };
  const preparation = { reservationId: state.reservationId, pluginVersion: "1.2.3", preparedDate: "2026-10-11", baseSha: state.baseSha,
    branch: `automation/openclaw-${version}-${state.reservationId.slice(0, 8)}`, prNumber: 7, candidateSha: hex("3"), candidateTree: hex("4"),
    tag, classificationEvidenceSha256: hex("5", 64), counterpart, automation };
  const result = { format: "thunderclaw-openclaw-autopilot-result-v1", repository, repositoryId: 10, workflow,
    workflowCommit: state.baseSha, workflowSha256: automation.qualificationWorkflowSha, event: "workflow_dispatch", runId: 100, runAttempt: 1,
    requestId: hex("b", 32), reservationId: state.reservationId, version, identitySha256: state.identitySha256, baseSha: state.baseSha, tag,
    candidateArtifactSha256: hex("c", 64), candidate: { ref: preparation.branch, sha: preparation.candidateSha, tree: preparation.candidateTree },
    counterpart, classification: { decision: "compatibility-only", evidenceSha256: preparation.classificationEvidenceSha256 }, automation,
    gates: Object.fromEntries(["deterministic", "openclaw-integration", "pair-qualification", "thunderbird-linux", "native-windows", "native-macos"].map((name) => [name, "success"])), decision: "pass" };
  const resultText = `${JSON.stringify(result)}\n`;
  const baseline = { tag, name: "thunderclaw-openclaw-plugin-1.2.3.tgz", sha256: result.candidateArtifactSha256, size: 100 };
  state.phase = "complete";
  state.outputs = {
    preparation, qualificationDispatch: { requestId: result.requestId, workflow, workflowCommit: state.baseSha, workflowSha256: result.workflowSha256, dispatchedAt: at },
    qualification: { requestId: result.requestId, workflow, workflowCommit: state.baseSha, workflowSha256: result.workflowSha256, runId: 100, runAttempt: 1,
      headSha: preparation.candidateSha, headBranch: preparation.branch, event: "workflow_dispatch", conclusion: "success",
      evidenceSha256: createHash("sha256").update(resultText).digest("hex"), classificationEvidenceSha256: preparation.classificationEvidenceSha256,
      candidateArtifactSha256: result.candidateArtifactSha256, counterpart },
    merge: { mergeSha: hex("d"), mergeTree: preparation.candidateTree, tag }, tagged: { tag, commit: hex("d"), tree: preparation.candidateTree },
    githubPublication: { tag, commit: hex("d"), artifactSha256: result.candidateArtifactSha256, releaseId: 20 },
    clawhubVerification: { tag, version: "1.2.3", artifactSha256: result.candidateArtifactSha256, verifiedAt: at },
    closeout: { branch: "automation/counterpart-test", prNumber: 8, baseline: { ...baseline, repository }, headSha: hex("e"), tree: hex("f") },
    completion: { mergeSha: hex("f"), mergeTree: hex("f") },
  };
  validateReleaseState(state);
  const run = { id: 100, run_attempt: 1, head_sha: state.baseSha, head_branch: "main", event: "workflow_dispatch", path: workflow,
    repository: { full_name: repository, id: 10 }, status: "completed", conclusion: "success" };
  const jobs = jobNames.map((name) => ({ name, status: "completed", conclusion: "success" }));
  const checkNames = ["Tests, types, and packages", "Signoffs", "Release automation validation"];
  const checks = checkNames.map((name) => ({ name, status: "completed", conclusion: "success", app: { id: 15368 } }));
  const client: ReleaseStatusClient = {
    state: async () => structuredClone(state),
    workflows: async () => ["openclaw-autopilot.yml", "qualify-openclaw-autopilot.yml", "release-openclaw-plugin.yml", "publish-clawhub.yml", "complete-plugin-publication.yml", "complete-openclaw-autopilot-closeout.yml"].map((name, id) => ({ id: id + 1, path: `.github/workflows/${name}`, state: "active" })),
    rollout: async () => true,
    rules: async () => [{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: checkNames.map((context) => ({ context, integration_id: 15368 })) } }],
    run: async () => structuredClone(run), jobs: async () => structuredClone(jobs),
    runs: async (name) => name === "publish-clawhub.yml" ? [] : [{ ...run, id: 200, event: "push", head_sha: hex("d"), head_branch: tag, path: ".github/workflows/release-openclaw-plugin.yml" }],
    release: async () => ({ tag_name: tag }),
    verifyPublic: async () => ({ verified: true, artifact: baseline, githubUrl: `https://github.com/${repository}/releases/tag/${tag}`, clawhubUrl: "https://clawhub.ai/thunderclaw/plugins/openclaw-plugin" }),
    pullRequest: async () => ({ number: 8, merged: true, merge_commit_sha: hex("f"), base: { ref: "main", repo: { full_name: repository } }, head: { sha: hex("e") } }),
    baseline: async () => ({ format: "thunderclaw-counterpart-baselines-v1", "openclaw-plugin": baseline, "thunderbird-extension": { tag: counterpart.tag, name: counterpart.name, sha256: counterpart.sha256, size: counterpart.size } }),
    main: async () => hex("f"), checks: async (commit) => structuredClone(commit === hex("f") ? checks.filter((check) => check.name !== "Signoffs") : checks),
    artifacts: async () => [{ id: 1, name: `openclaw-autopilot-result-${result.requestId}-1`, expired: false }],
    artifactText: async () => resultText,
  };
  return { client, state, run, jobs, result, resultText, checks };
}

test("verified completion binds trusted workflow attempt, retained result, public verification and PR/main checks", async () => {
  const { client } = fixture();
  const report = await collectReleaseStatus(client);
  assert.equal(report.assessment, "verified-complete", JSON.stringify(report.issues));
  assert.equal(report.evidence.automationEnabled, true);
  assert.match(formatReleaseStatus(report), /Qualification: .*runs\/100 \(attempt 1\)/u);
});

test("durable complete never substitutes for public verification or current main CI", async () => {
  for (const change of [
    (client: ReleaseStatusClient) => { client.verifyPublic = async () => { throw new Error("credential=secret"); }; },
    (client: ReleaseStatusClient) => { client.checks = async () => []; },
    (client: ReleaseStatusClient) => { client.baseline = async () => ({}); },
  ]) {
    const { client } = fixture(); change(client);
    const report = await collectReleaseStatus(client);
    assert.notEqual(report.assessment, "verified-complete");
    assert.doesNotMatch(JSON.stringify(report), /credential|secret/u);
    assert.match(report.nextActions[0], /completion alone/u);
  }
});

test("wrong qualification source, attempt, digest, missing or duplicate native gates fail closed", async () => {
  for (const mutation of ["source", "attempt", "digest", "missing-native", "duplicate-native"]) {
    const { client, run, jobs } = fixture();
    if (mutation === "source") run.head_sha = hex("0");
    if (mutation === "attempt") run.run_attempt = 2;
    if (mutation === "digest") client.artifactText = async () => "{}";
    if (mutation === "missing-native") jobs.splice(jobs.findIndex((job) => job.name === "Native Windows qualification"), 1);
    if (mutation === "duplicate-native") jobs.push({ ...jobs[4] });
    const report = await collectReleaseStatus(client);
    assert.notEqual(report.assessment, "verified-complete", mutation);
  }
});

test("accepted pending evidence yields verification advice with only allowlisted fields", async () => {
  const { client, run } = fixture();
  client.runs = async (name) => [{ ...run, id: 200, event: name === "publish-clawhub.yml" ? "workflow_dispatch" : "push",
    head_sha: hex("d"), head_branch: tag, path: `.github/workflows/${name}` }];
  client.artifacts = async (id) => id === 100 ? [{ id: 1, name: `openclaw-autopilot-result-${hex("b", 32)}-1`, expired: false }]
    : [{ id: 2, name: "thunderclaw-clawhub-publication-1.2.3", expired: false }];
  const original = client.artifactText;
  client.artifactText = async (artifact, member) => member === "result.json" ? original(artifact, member)
    : JSON.stringify({ name: "@thunderclaw/openclaw-plugin", version: "1.2.3", publicationStatus: "pending", attemptId: "attempt-1", token: "secret", log: "secret" });
  client.verifyPublic = async () => { throw new Error("pending"); };
  const report = await collectReleaseStatus(client);
  assert.deepEqual(report.evidence.submission, { status: "pending", attemptId: "attempt-1" });
  assert.match(report.nextActions[0], /do not upload/u);
  assert.doesNotMatch(JSON.stringify(report), /secret/u);
});

test("historical replaced unpublished source does not obscure authenticated public completion", async () => {
  const { client } = fixture();
  const runs = client.runs;
  client.runs = async (name, version) => name === "publish-clawhub.yml" ? [] : [...await runs(name, version),
    { id: 201, run_attempt: 3, head_sha: hex("0"), head_branch: tag, event: "push", path: ".github/workflows/release-openclaw-plugin.yml", status: "completed", conclusion: "failure" }];
  client.rollout = async () => false;
  const report = await collectReleaseStatus(client);
  assert.equal(report.assessment, "verified-complete");
  assert.equal(report.evidence.originalReleaseRunCount, 2);
  assert.equal(report.evidence.automationEnabled, false);
  assert.match(report.nextActions[0], /disabled automation/u);
  assert.match(report.nextActions[1], /exactly one original run/u);
});

test("missing state reports unknown without printing error detail or suggesting mutation", async () => {
  const { client } = fixture();
  client.state = async () => { throw new Error("populated secret state"); };
  const report = await collectReleaseStatus(client);
  assert.equal(report.assessment, "unknown");
  assert.doesNotMatch(JSON.stringify(report), /secret/u);
  assert.match(report.nextActions[0], /do not mutate/u);
});

test("unexpected GitHub metadata cannot escape as arbitrary backend text", async () => {
  const { client, jobs } = fixture();
  const canary = "sensitive-content-canary";
  jobs.push({ name: canary, status: canary, conclusion: canary });
  const runs = client.runs;
  client.runs = async (name, version) => name === "publish-clawhub.yml" ? [] : [...await runs(name, version),
    { id: 201, run_attempt: 1, head_sha: canary, head_branch: canary, path: canary, status: canary, conclusion: canary }];
  const rules = client.rules;
  client.rules = async () => [...await rules(), { type: "required_status_checks", parameters: {
    required_status_checks: [{ context: canary, integration_id: canary }] } }];
  const checks = client.checks;
  client.checks = async (commit) => [...await checks(commit), { name: canary, status: canary, conclusion: canary }];
  const workflows = client.workflows;
  client.workflows = async () => (await workflows()).map((entry, index) => index === 0 ? { ...entry, state: canary } : entry);
  const report = await collectReleaseStatus(client);
  assert.equal(report.assessment, "unknown");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(canary, "u"));
  assert.doesNotMatch(formatReleaseStatus(report), new RegExp(canary, "u"));
});
