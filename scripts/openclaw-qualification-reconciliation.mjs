import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const STALE_MAIN_REASON = "main advanced after qualification; a new candidate and qualification are required";
export const DISPATCH_ADMISSION_REASON = "main advanced during qualification dispatch admission; all gates require a fresh reservation";

// A request title locates candidates; the API's repository, event, workflow and
// source identity authenticate them. Never pick the first of ambiguous runs.
export function selectQualificationRun({ state, repository, runs }) {
  const dispatch = state.outputs.qualificationDispatch;
  if (state.phase !== "qualifying" || !dispatch) throw new Error("Expected an active qualification dispatch");
  const title = `Qualify OpenClaw ${state.identity.version} (${dispatch.requestId})`;
  const matches = runs.filter((run) => run.display_title === title && run.event === "workflow_dispatch"
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository
    && run.head_branch === "main" && run.path?.split("@")[0] === dispatch.workflow);
  if (matches.length > 1) throw new Error("Qualification request has ambiguous runs");
  const run = matches[0];
  if (!run) return { action: "dispatch" };
  if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("Qualification run identity is malformed");
  if (run.head_sha !== dispatch.workflowCommit) return { action: run.status === "completed" ? "admission-mismatch" : "wait", run };
  if (run.status !== "completed") return { action: "wait", run };
  if (!["success", "failure", "cancelled", "timed_out", "action_required"].includes(run.conclusion)) throw new Error("Unexpected qualification conclusion");
  return { action: "completed", run };
}

export function authenticateDispatchMismatch({ state, repository, run, jobs }) {
  if (selectQualificationRun({ state, repository, runs: [run] }).action !== "admission-mismatch"
      || !["failure", "timed_out"].includes(run.conclusion) || !/^[a-f0-9]{40}$/u.test(run.head_sha)) {
    throw new Error("Admission recovery requires a completed failed dispatch at a different main commit");
  }
  const names = ["Bind immutable source and trusted workflow", "Deterministic tests, types, and packages", "Pinned OpenClaw integration", "Thunderbird Linux qualification", "Native Windows qualification", "Native macOS qualification", "Protected exact-pair real-agent qualification", "Bind successful qualification result"];
  const list = Array.isArray(jobs) ? jobs : jobs.jobs;
  for (const [index, name] of names.entries()) {
    const found = list.filter((job) => job.name === name);
    if (found.length !== 1 || found[0].status !== "completed"
        || (index === 0 ? !["failure", "timed_out"].includes(found[0].conclusion) : index === names.length - 1 ? !["failure", "skipped"].includes(found[0].conclusion) : found[0].conclusion !== "skipped")) {
      throw new Error("Admission recovery cannot discard a gate result or cancellation");
    }
  }
  return true;
}

export function isSafeStaleCandidate(state) {
  return state.phase === "blocked" && state.blockers.length === 1 && !state.outputs.failure
    && !state.outputs.merge && !state.outputs.tagged
    && ((state.blockers[0] === STALE_MAIN_REASON && !!state.outputs.qualification)
      || (state.blockers[0] === DISPATCH_ADMISSION_REASON && state.history.at(-1)?.type === "record-dispatch-admission-mismatch"));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [command, file] = process.argv.slice(2);
    const input = JSON.parse(readFileSync(file, "utf8"));
    const result = command === "select" ? selectQualificationRun(input)
      : command === "mismatch" ? { valid: authenticateDispatchMismatch(input) }
        : command === "stale" ? { recoverable: isSafeStaleCandidate(input) }
          : (() => { throw new Error("Expected select, mismatch or stale"); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
