import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Dispatch only reviewed main automation. It authenticates the archived release
// evidence again; no decision here authorizes rebuilding an immutable tag.
export function planPublicationRecovery({ repository, state, sourceRuns, recoveryRuns, release, operatorRetry = false }) {
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
  if (!operatorRetry && latest?.conclusion === "success") return { action: "wait", reason: "Publication recovery succeeded; waiting for durable closeout" };
  if (!operatorRetry && latest && !["timed_out", "startup_failure"].includes(latest.conclusion)) {
    throw new Error(`Publication recovery ended ${latest.conclusion}; explicit operator retry required`);
  }
  if (!operatorRetry && recoveries.length >= 3) throw new Error("Automatic publication recovery budget exhausted; operator review required");
  return { action: "dispatch", tag, runId: source.id, reason: operatorRetry ? "Explicit operator recovery" : "Resume the existing qualified archive on reviewed main" };
}

export function closeoutChecksPassed(checks) {
  for (const [name, workflow] of [["Tests, types, and packages", "CI"], ["Signoffs", "DCO"], ["Release automation validation", "Release automation validation"]]) {
    const matches = checks.filter((check) => check.name === name && check.workflow === workflow);
    if (matches.length !== 1) throw new Error(`Expected exactly one trusted closeout check: ${name}`);
    if (["FAILURE", "CANCELLED", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "SKIPPED", "NEUTRAL"].includes(matches[0].state)) {
      throw new Error(`Closeout check did not pass: ${name}`);
    }
    if (matches[0].state !== "SUCCESS") return false;
  }
  return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [command, path] = process.argv.slice(2);
    const evidence = JSON.parse(readFileSync(path, "utf8"));
    const result = command === "plan" ? planPublicationRecovery(evidence)
      : command === "checks" ? { passed: closeoutChecksPassed(evidence) }
        : (() => { throw new Error("Expected plan or checks"); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
