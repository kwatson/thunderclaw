const repository = "kwatson/thunderclaw";

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
      || run.status !== "completed" || run.conclusion !== "startup_failure"
      || evidence.jobCount !== 0 || evidence.githubReleaseAbsent !== true
      || evidence.attestationsAbsent !== true || evidence.marketplaceVersionAbsent !== true
      || evidence.publisherRunsAbsent !== true || evidence.tagAbsent !== true) {
    throw new Error("Recovery requires the exact unpublished tag, a completed startup failure with no jobs, and every absence check");
  }
  return true;
}
