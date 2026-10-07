import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { authenticateCloseout, verifyCloseoutEvidence, closeoutChecksPassed, planPublicationRecovery } from "../scripts/openclaw-controller-recovery.mjs";

const repository = "example/thunderclaw";
const tag = "openclaw-plugin-v1.2.3";
const commit = "a".repeat(40);
const source = { id: 10, repository: { full_name: repository }, event: "push", path: ".github/workflows/release-openclaw-plugin.yml",
  head_branch: tag, head_sha: commit, status: "completed", conclusion: "failure" };
const recovery = { id: 20, repository: { full_name: repository }, event: "workflow_dispatch", path: ".github/workflows/complete-plugin-publication.yml",
  head_branch: "main", display_title: `Complete publication ${tag}`, status: "completed", conclusion: "timed_out" };
const evidence = () => ({ repository, state: { phase: "tagged", outputs: { tagged: { tag, commit } } },
  sourceRuns: [source], recoveryRuns: [] as any[], release: { tag_name: tag, draft: false, prerelease: false }, operatorRetry: false });

test("published immutable release resumes through main without another build or tag", () => {
  assert.deepEqual(planPublicationRecovery(evidence()), { action: "dispatch", tag, runId: 10, reason: "Resume the existing qualified archive on reviewed main" });
  const workflow = readFileSync(new URL("../.github/workflows/openclaw-autopilot.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /gh run rerun/u);
  assert.match(workflow, /complete-plugin-publication\.yml --ref main/u);
  assert.match(workflow, /Install locked dependencies only for new upstream evidence\n\s+if: steps\.version\.outputs\.eligible == 'true' && steps\.version\.outputs\.reuse_baseline != 'true'/u);
  assert.match(workflow, /cron: "17 \* \* \* \*"/u);
});

test("recovery refuses wrong identity, ambiguity and missing published bytes", () => {
  for (const mutate of [
    (e: any) => { e.sourceRuns = [{ ...source, head_sha: "b".repeat(40) }]; },
    (e: any) => { e.sourceRuns = [source, { ...source, id: 11 }]; },
    (e: any) => { e.sourceRuns = [{ ...source, repository: { full_name: "other/repo" } }]; },
    (e: any) => { e.release = null; },
    (e: any) => { e.release.draft = true; },
    (e: any) => { e.state.phase = "complete"; },
  ]) {
    const e = evidence(); mutate(e); assert.throws(() => planPublicationRecovery(e));
  }
});

test("pending runs and successful finalization do not dispatch duplicates", () => {
  const e = evidence();
  e.sourceRuns = [{ ...source, status: "in_progress" }];
  assert.equal(planPublicationRecovery(e).action, "wait");
  e.sourceRuns = [source];
  for (const run of [{ ...recovery, status: "queued" }, { ...recovery, conclusion: "success" }]) {
    e.recoveryRuns = [run]; assert.equal(planPublicationRecovery(e).action, "wait");
  }
});

test("cancelled or rejected recovery requires operator review and retries stay bounded", () => {
  const e = evidence();
  for (const conclusion of ["cancelled", "failure", "action_required"]) {
    e.recoveryRuns = [{ ...recovery, conclusion }];
    assert.throws(() => planPublicationRecovery(e), /operator retry/u);
  }
  e.recoveryRuns = [recovery];
  assert.equal(planPublicationRecovery(e).action, "dispatch");
  e.recoveryRuns = [recovery, { ...recovery, id: 21 }, { ...recovery, id: 22 }];
  assert.throws(() => planPublicationRecovery(e), /budget exhausted/u);
  e.operatorRetry = true;
  assert.equal(planPublicationRecovery(e).action, "dispatch");
  e.sourceRuns = [{ ...source, conclusion: "cancelled" }];
  assert.throws(() => planPublicationRecovery(e), /cancelled/u);
});

test("closeout requires successful CI, signoffs and automation validation from their expected workflows", () => {
  const checks = [ { name: "Tests, types, and packages", workflow: "CI", state: "SUCCESS" }, { name: "Signoffs", workflow: "DCO", state: "SUCCESS" },
    { name: "Release automation validation", workflow: "Release automation validation", state: "SUCCESS" } ];
  assert.equal(closeoutChecksPassed(checks), true);
  assert.equal(closeoutChecksPassed([{ ...checks[0], state: "IN_PROGRESS" }, ...checks.slice(1)]), false);
  for (const state of ["FAILURE", "CANCELLED", "SKIPPED", "NEUTRAL"]) {
    assert.throws(() => closeoutChecksPassed([{ ...checks[0], state }, ...checks.slice(1)]), /did not pass/u);
  }
  assert.equal(closeoutChecksPassed(checks.slice(0, 2)), false);
  assert.equal(closeoutChecksPassed([checks[0]]), false);
  assert.equal(closeoutChecksPassed([]), false);
  assert.throws(() => closeoutChecksPassed([...checks, checks[0]]), /exactly one/u);
  assert.throws(() => closeoutChecksPassed([{ ...checks[0], workflow: "Untrusted" }, ...checks.slice(1)]), /exactly one/u);
});


test("closeout reads checks with the read-only workflow token", () => {
  for (const path of ["openclaw-autopilot.yml", "complete-openclaw-autopilot-closeout.yml"]) {
    const workflow = readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8");
    assert.match(workflow, /checks: read/u);
    assert.match(workflow, /pull-requests: read/u);
    assert.match(workflow, /CLOSEOUT_READ_TOKEN: \$\{\{ github\.token \}\}/u);
    assert.match(workflow, /scripts\/openclaw-controller-recovery\.mjs closeout/u);
    assert.doesNotMatch(workflow, /permission-checks: write/u);
  }
});

const checks = [ { name: "Tests, types, and packages", workflow: "CI", state: "SUCCESS" }, { name: "Signoffs", workflow: "DCO", state: "SUCCESS" }, { name: "Release automation validation", workflow: "Release automation validation", state: "SUCCESS" } ];
const closeoutEvidence = () => ({ repository, state: { phase: "closeout-open", outputs: { closeout: { prNumber: 30, branch: `automation/counterpart-${tag}`, headSha: commit, tree: "b".repeat(40), baseline: { repository, tag, sha256: "c".repeat(64), size: 123 } } } }, pr: { number: 30, base: { ref: "main", repo: { full_name: repository } }, head: { ref: `automation/counterpart-${tag}`, sha: commit, repo: { full_name: repository } }, merged: true, state: "closed", merge_commit_sha: "d".repeat(40) }, checks, headTree: "b".repeat(40), mergeTree: "e".repeat(40), changedFiles: ["e2e/qualification/counterpart-baselines.json"], baselines: { "openclaw-plugin": { tag, sha256: "c".repeat(64), size: 123 } }, baselinesBefore: { "openclaw-plugin": { tag: "old" } } });

test("all completion entry points authenticate the already-merged closeout through one verifier", () => {
  const evidence = closeoutEvidence();
  const calls: string[] = [];
  const execute = (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "gh") {
      if (args[0] === "pr") return JSON.stringify(evidence.checks);
      if (args[1].endsWith("pulls/30")) return JSON.stringify(evidence.pr);
      return JSON.stringify({ tree: { sha: args[1].endsWith(commit) ? evidence.headTree : evidence.mergeTree } });
    }
    if (args[0] === "fetch") return "";
    if (args[0] === "diff-tree") return evidence.changedFiles.join("\n");
    return JSON.stringify(args[1].includes("^:") ? evidence.baselinesBefore : evidence.baselines);
  };
  assert.equal(authenticateCloseout(evidence.state, repository, execute).action, "complete");
  assert.ok(calls.some((value) => value.startsWith("git diff-tree")));
  for (const file of ["openclaw-autopilot.yml", "complete-openclaw-autopilot-closeout.yml", "complete-plugin-publication.yml"]) {
    assert.match(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"), /scripts\/openclaw-controller-recovery\.mjs closeout/u);
  }
  for (const mutate of [
    (e: any) => { e.pr.number++; }, (e: any) => { e.pr.base.ref = "other"; },
    (e: any) => { e.pr.head.repo.full_name = "attacker/fork"; },
    (e: any) => { e.pr.head.sha = "f".repeat(40); }, (e: any) => { e.headTree = "f".repeat(40); },
    (e: any) => { e.changedFiles.push("another-file"); },
    (e: any) => { e.baselines["openclaw-plugin"].size++; },
    (e: any) => { e.baselines["thunderbird-extension"] = {}; },
    (e: any) => { e.checks = [{ ...checks[0], state: "FAILURE" }, ...checks.slice(1)]; },
  ]) { const e = structuredClone(evidence); mutate(e); assert.throws(() => verifyCloseoutEvidence(e)); }
  assert.equal(verifyCloseoutEvidence({ ...evidence, checks: [{ ...checks[0], state: "IN_PROGRESS" }, ...checks.slice(1)] }).action, "wait");
});

test("accepted scans remain reconcilable after more than three failed 80-minute budgets", () => {
  const e: any = evidence();
  e.publisher = { run: { id: 100, repository: { full_name: repository }, event: "workflow_dispatch", path: ".github/workflows/publish-clawhub.yml", head_sha: commit, head_branch: tag, status: "completed", conclusion: "failure" }, submission: { name: "@thunderclaw/openclaw-plugin", version: "1.2.3", attemptId: "attempt", releaseId: "release", publicationStatus: "pending" } };
  e.reconciliation = { status: "pending", tag, commit, publisherRunId: 100 };
  for (let hour = 1; hour <= 24; hour++) {
    e.recoveryRuns.push({ ...recovery, id: 20 + hour, conclusion: "failure" });
    const plan = planPublicationRecovery(e);
    assert.equal(plan.action, "dispatch"); assert.match(plan.reason, /public reads/u);
  }
  e.reconciliation.status = "terminal";
  assert.throws(() => planPublicationRecovery(e), /terminal mismatch/u);
  e.reconciliation.status = "pending";
  e.reconciliation.commit = "f".repeat(40);
  assert.throws(() => planPublicationRecovery(e), /identity mismatch/u);
  e.reconciliation.commit = commit;
  e.recoveryRuns.push({ ...recovery, id: 1000, conclusion: "cancelled" });
  assert.throws(() => planPublicationRecovery(e), /cancelled/u);
});
