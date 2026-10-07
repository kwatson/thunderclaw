import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { assessClawHubPublisher } from "./clawhub-publication-recovery.mjs";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Dispatch only reviewed main automation. It authenticates the archived release
// evidence again; no decision here authorizes rebuilding an immutable tag.
export function planPublicationRecovery({ repository, state, sourceRuns, recoveryRuns, release, operatorRetry = false, publisher, reconciliation }) {
  const tag = state.outputs?.tagged?.tag;
  const commit = state.outputs?.tagged?.commit;
  if (!["tagged", "github-published", "clawhub-verified"].includes(state.phase)
      || !/^openclaw-plugin-v\d+\.\d+\.\d+$/u.test(tag ?? "") || !/^[a-f0-9]{40}$/u.test(commit ?? "")) {
    throw new Error("Recovery requires the active immutable tagged release");
  }
  const sources = sourceRuns.filter((run) => run.repository?.full_name === repository && run.event === "push"
    && run.path?.split("@")[0] === ".github/workflows/release-openclaw-plugin.yml"
    && run.head_branch === tag && run.head_sha === commit);
  if (sources.length !== 1) throw new Error("Recovery requires exactly one original protected-tag run");
  const source = sources[0];
  if (source.status !== "completed") return { action: "wait", reason: "Original release is still running" };
  if (source.conclusion === "cancelled") throw new Error("Original release was cancelled; operator review required");
  if (!release || release.tag_name !== tag || release.draft || release.prerelease) {
    throw new Error("No published GitHub archive exists; repair and review pre-publication recovery separately");
  }
  const recoveries = recoveryRuns.filter((run) => run.repository?.full_name === repository
    && run.path?.split("@")[0] === ".github/workflows/complete-plugin-publication.yml"
    && run.event === "workflow_dispatch" && run.head_branch === "main" && run.display_title === `Complete publication ${tag}`)
    .sort((a, b) => b.id - a.id);
  const latest = recoveries[0];
  if (latest && latest.status !== "completed") return { action: "wait", reason: "Reviewed publication recovery is already running" };
  if (!operatorRetry && latest?.conclusion === "cancelled") throw new Error("Publication recovery was cancelled; explicit operator retry required");
  if (reconciliation) {
    if (reconciliation.tag !== tag || reconciliation.commit !== commit
        || reconciliation.publisherRunId !== publisher?.run?.id) throw new Error("Reconciliation evidence identity mismatch");
    if (reconciliation.status === "terminal") throw new Error("Public verification found a terminal mismatch; explicit operator review required");
    if (reconciliation.status !== "pending") throw new Error("Unknown publication reconciliation status");
  }
  if (publisher) {
    const action = assessClawHubPublisher({ ...publisher, repository, tag, commit });
    if (action === "await") return { action: "wait", reason: "Original publisher is still running" };
    if (action === "verify-public") return { action: "dispatch", tag, runId: source.id, reason: "Reconcile accepted or unconfirmed publication using public reads" };
  }
  if (!operatorRetry && latest?.conclusion === "success") return { action: "wait", reason: "Publication recovery succeeded; waiting for durable closeout" };
  if (!operatorRetry && latest && !["timed_out", "startup_failure"].includes(latest.conclusion)) {
    throw new Error(`Publication recovery ended ${latest.conclusion}; explicit operator retry required`);
  }
  if (!operatorRetry && recoveries.length >= 3) throw new Error("Automatic publication recovery budget exhausted; operator review required");
  return { action: "dispatch", tag, runId: source.id, reason: operatorRetry ? "Explicit operator recovery" : "Resume the existing qualified archive on reviewed main" };
}

export function closeoutChecksPassed(checks) {
  let passed = true;
  for (const [name, workflow] of [["Tests, types, and packages", "CI"], ["Signoffs", "DCO"], ["Release automation validation", "Release automation validation"]]) {
    const matches = checks.filter((check) => check.name === name && check.workflow === workflow);
    if (matches.length === 0 && !checks.some((check) => check.name === name)) { passed = false; continue; }
    if (matches.length !== 1) throw new Error(`Expected exactly one trusted closeout check: ${name}`);
    if (["FAILURE", "CANCELLED", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "SKIPPED", "NEUTRAL"].includes(matches[0].state)) {
      throw new Error(`Closeout check did not pass: ${name}`);
    }
    if (matches[0].state !== "SUCCESS") passed = false;
  }
  return passed;
}

// All completion entry points authenticate the same recorded PR and merged bytes.
export function verifyCloseoutEvidence({ state, repository, pr, checks, headTree, mergeTree, changedFiles, baselines, baselinesBefore }) {
  const closeout = state.outputs?.closeout;
  if (!["closeout-open", "complete"].includes(state.phase) || !closeout
      || pr.number !== closeout.prNumber || pr.base?.ref !== "main"
      || pr.base?.repo?.full_name !== repository || pr.head?.repo?.full_name !== repository
      || pr.head?.ref !== closeout.branch || pr.head?.sha !== closeout.headSha
      || headTree !== closeout.tree) throw new Error("Closeout PR does not match the exact recorded identity");
  const passed = closeoutChecksPassed(checks);
  if (!pr.merged) {
    if (pr.state !== "open" || state.phase === "complete") throw new Error("Closeout was closed without its recorded merge");
    return { action: passed ? "open" : "wait", prNumber: closeout.prNumber, headSha: closeout.headSha };
  }
  if (!/^[a-f0-9]{40}$/u.test(pr.merge_commit_sha ?? "") || !/^[a-f0-9]{40}$/u.test(mergeTree ?? "")
      || !isDeepStrictEqual(changedFiles, ["e2e/qualification/counterpart-baselines.json"])) throw new Error("Closeout merge must change exactly the counterpart baseline file");
  const { repository: ignored, ...expected } = closeout.baseline;
  if (!isDeepStrictEqual(baselines?.["openclaw-plugin"], expected)) throw new Error("Merged baseline does not exactly match recorded publication");
  const withoutPlugin = (value) => { const { ["openclaw-plugin"]: plugin, ...other } = value ?? {}; return other; };
  if (!baselinesBefore || !isDeepStrictEqual(withoutPlugin(baselines), withoutPlugin(baselinesBefore))) throw new Error("Closeout changed another counterpart baseline");
  if (state.phase === "complete" && state.outputs.completion.mergeSha !== pr.merge_commit_sha) throw new Error("Completion merge identity changed");
  return { action: passed ? "complete" : "wait", mergeSha: pr.merge_commit_sha, mergeTree };
}

export function authenticateCloseout(state, repository, execute = execFileSync) {
  const run = (command, args, extra = {}) => execute(command, args, { encoding: "utf8", ...extra }).trim();
  const api = (route) => JSON.parse(run("gh", ["api", `repos/${repository}/${route}`]));
  const closeout = state.outputs?.closeout;
  if (!closeout) throw new Error("No recorded closeout");
  const pr = api(`pulls/${closeout.prNumber}`);
  let checks;
  try { checks = run("gh", ["pr", "checks", String(closeout.prNumber), "--repo", repository, "--json", "name,state,workflow"], { env: { ...process.env, GH_TOKEN: process.env.CLOSEOUT_READ_TOKEN || process.env.GH_TOKEN } }); }
  catch (error) { if (error.status !== 8) throw error; checks = error.stdout; }
  const headTree = api(`git/commits/${closeout.headSha}`).tree.sha;
  let mergeTree, changedFiles, baselines, baselinesBefore;
  if (pr.merged) {
    if (!/^[a-f0-9]{40}$/u.test(pr.merge_commit_sha ?? "")) throw new Error("Invalid closeout merge SHA");
    mergeTree = api(`git/commits/${pr.merge_commit_sha}`).tree.sha;
    run("git", ["fetch", "--no-tags", "origin", pr.merge_commit_sha]);
    changedFiles = run("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", pr.merge_commit_sha]).split("\n");
    baselinesBefore = JSON.parse(run("git", ["show", `${pr.merge_commit_sha}^:e2e/qualification/counterpart-baselines.json`]));
    baselines = JSON.parse(run("git", ["show", `${pr.merge_commit_sha}:e2e/qualification/counterpart-baselines.json`]));
  }
  return verifyCloseoutEvidence({ state, repository, pr, checks: JSON.parse(checks), headTree, mergeTree, changedFiles, baselines, baselinesBefore });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [command, path] = process.argv.slice(2);
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    const result = command === "closeout" ? authenticateCloseout(evidence, process.argv[4]) : command === "plan" ? planPublicationRecovery(evidence)
      : command === "checks" ? { passed: closeoutChecksPassed(evidence) }
        : (() => { throw new Error("Expected plan or checks"); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
