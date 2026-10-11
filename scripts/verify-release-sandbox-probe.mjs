import { pathToFileURL } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

// Only operator-dispatched, read-only validation runs may supply live evidence.
export function verifyReleaseSandboxProbe({ run, jobs, repository, commit, branch, scenario, annotations = [] }) {
  if (!Number.isSafeInteger(run?.id) || run.id <= 0 || !Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
      || !/^[a-f0-9]{40}$/u.test(commit) || typeof branch !== "string" || branch === "main"
      || !["environment-denial", "cancellation"].includes(scenario)
      || run?.repository?.full_name !== repository || run?.event !== "workflow_dispatch"
      || run?.path?.split("@")[0] !== ".github/workflows/validate-release-automation.yml"
      || run?.head_sha !== commit || run?.head_branch !== branch || run?.status !== "completed"
      || !Array.isArray(jobs)) throw new Error("Sandbox evidence must identify the exact completed operator validation run");
  const name = scenario === "environment-denial" ? "Read-only environment rejection probe" : "Read-only cancellation probe";
  const matches = jobs.filter((job) => job.name === name);
  if (matches.length !== 1) throw new Error("Sandbox probe job is absent or ambiguous");
  const job = matches[0];
  if (job.status !== "completed") throw new Error("Sandbox probe is not terminal");
  if (scenario === "environment-denial") {
    if (run.conclusion !== "failure" || job.conclusion !== "failure" || !Array.isArray(job.steps) || job.steps.length !== 0
        || !annotations.some((annotation) => annotation.annotation_level === "failure"
          && annotation.message === `Branch "${branch}" is not allowed to deploy to openclaw-autopilot-mutation due to environment protection rules.`)) {
      throw new Error("The environment probe must be rejected before executing any runner step");
    }
  } else if (run.conclusion !== "cancelled" || job.conclusion !== "cancelled"
      || !job.steps?.some((step) => step.name === "Wait for operator cancellation" && step.started_at
        && step.started_at !== "0001-01-01T00:00:00Z")) {
    throw new Error("Cancellation must stop the started probe rather than an unrelated queued job");
  }
  return { format: "thunderclaw-live-release-probe-v1", repository, scenario,
    runId: run.id, runAttempt: run.run_attempt, commit, branch, verified: true,
    scope: "read-only-validation-run", productTagsCreated: 0, publicationPerformed: false };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [directory, repository, commit, branch, scenario] = process.argv.slice(2);
    const result = verifyReleaseSandboxProbe({ run: JSON.parse(readFileSync(path.join(directory, "run.json"))),
      jobs: JSON.parse(readFileSync(path.join(directory, "jobs.json"))).jobs, repository, commit, branch, scenario, annotations: scenario === "environment-denial" ? JSON.parse(readFileSync(path.join(directory, "annotations.json"))) : [] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch { process.stderr.write("Live release sandbox evidence did not pass verification\n"); process.exitCode = 1; }
}
