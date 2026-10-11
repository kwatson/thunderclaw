import assert from "node:assert/strict";
import test from "node:test";
import { rehearseReleaseOperations } from "../scripts/rehearse-release-operations.mjs";

test("release operations rehearse recovery admission and asynchronous public verification without publishing", async () => {
  const report = await rehearseReleaseOperations();
  assert.deepEqual(report.cases, ["accepted-pending-then-verified", "pending", "tampered-download",
    "wrong-source", "unclean-scan", "qualification-cancelled", "qualification-failure", "qualification-skipped",
    "lost-dispatch-response-rediscovery", "protected-environment-denial-blocks-promotion",
    "cancelled-qualification-is-terminal", "dispatch-main-race-preserves-gate-evidence",
    "merge-race-rejects-different-tree-and-stale-revision", "denied-or-cancelled-finalizer-requires-operator",
    "repeated-closeout-is-idempotent-and-identity-bound"]);
  assert.equal(report.networkScope, "loopback-only");
  assert.equal(report.externalMutations, 0);
  assert.equal(report.productArtifactsBuilt, 0);
  assert.equal(report.productTagsCreated, 0);
  assert.equal(report.secretsRequired, false);
  assert.equal(report.liveGitHubAdmissionVerified, false);
});
