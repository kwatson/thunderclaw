const repository = "kwatson/thunderclaw";

function failedBeforePublication(evidence) {
  if (evidence.run?.conclusion === "startup_failure") return evidence.jobCount === 0;
  if (evidence.run?.conclusion !== "failure" || !Array.isArray(evidence.jobs)
      || evidence.jobCount !== evidence.jobs.length) return false;
  const expected = new Map([
    ["Select fail-closed release lane", ["success"]],
    ["Validate and build plugin once", ["success"]],
    ["Qualify exact plugin archive", ["success", "failure"]],
    ["Qualify exact plugin with pinned extension / Protected real-agent pair qualification", ["success", "failure"]],
    ["Create plugin GitHub release", ["skipped"]],
    ["Promote manually qualified plugin to ClawHub", ["skipped"]],
    ["Complete automatic plugin publication", ["skipped"]],
  ]);
  if (evidence.jobs.length !== expected.size) return false;
  let failedGate = false;
  for (const job of evidence.jobs) {
    const conclusions = expected.get(job.name);
    if (job.status !== "completed" || !conclusions?.includes(job.conclusion)) return false;
    if (job.conclusion === "failure") failedGate = true;
    expected.delete(job.name);
  }
  return expected.size === 0 && failedGate;
}

// This operator-only path does not delete or move tags. The maintainer must
// separately authorize and remove the audited unpublished tag before applying.
export function authenticateUnpublishedRecovery(state, evidence) {
  const run = evidence?.run;
  const tagged = state.outputs?.tagged;
  if (state.phase !== "tagged" || !tagged || state.outputs.githubPublication
      || evidence?.repository !== repository || evidence.tag !== tagged.tag || evidence.commit !== tagged.commit
      || evidence.qualifiedArtifactSha256 !== state.outputs.qualification?.candidateArtifactSha256
      || !run || !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
      || run.repository?.full_name !== repository || run.event !== "push"
      || run.path !== ".github/workflows/release-openclaw-plugin.yml"
      || run.head_sha !== tagged.commit || run.head_branch !== tagged.tag
      || run.status !== "completed" || !failedBeforePublication(evidence)
      || evidence.githubReleaseAbsent !== true
      || evidence.attestationsAbsent !== true || evidence.marketplaceVersionAbsent !== true
      || evidence.publisherRunsAbsent !== true || evidence.tagAbsent !== true) {
    throw new Error("Recovery requires the exact unpublished tag, a completed startup or qualification failure before publication, and every absence check");
  }
  return true;
}
