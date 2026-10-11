import assert from "node:assert/strict";
import test from "node:test";
import { classifyQualificationFailure, validateQualificationFailureEvidence } from "../scripts/classify-openclaw-qualification-failure.mjs";

function evidence(binding = "success", deterministic = "failure", conclusion = "failure") {
  const state = {
    phase: "qualifying", reservationId: "1".repeat(32), identitySha256: "2".repeat(64),
    outputs: {
      preparation: { candidateSha: "3".repeat(40) },
      qualificationDispatch: { requestId: "request-1", workflowCommit: "4".repeat(40) },
    },
  };
  const run = { id: 123, run_attempt: 1, event: "workflow_dispatch", conclusion,
    head_sha: "4".repeat(40), head_branch: "main", path: ".github/workflows/qualify-openclaw-autopilot.yml@refs/heads/main" };
  const jobs = [
    ["Bind immutable source and trusted workflow", binding],
    ["Deterministic tests, types, and packages", deterministic],
    ["Pinned OpenClaw integration", "skipped"],
    ["Thunderbird Linux qualification", "skipped"],
    ["Native ${{ matrix.platform }} qualification", "skipped"],
    ["Protected exact-pair real-agent qualification", "skipped"],
    ["Bind successful qualification result", "failure"],
  ].map(([name, result]) => ({ name, conclusion: result, status: "completed" }));
  return { state, run, jobs };
}

test("an unexpanded skipped native matrix preserves the failed deterministic gate", () => {
  const failure = classifyQualificationFailure(evidence());
  assert.deepEqual(failure.classification, { stage: "gate", disposition: "blocked", recoverable: false });
  assert.equal(failure.jobs.deterministic, "failure");
  assert.equal(failure.jobs.nativeWindows, "skipped");
  assert.equal(failure.jobs.nativeMacos, "skipped");
  assert.deepEqual(validateQualificationFailureEvidence(failure), failure);
});

test("unexpanded skipped matrices retain pre-gate retry and intentional cancellation dispositions", () => {
  assert.deepEqual(classifyQualificationFailure(evidence("failure", "skipped")).classification,
    { stage: "pre-gate", disposition: "retryable", recoverable: true });
  assert.deepEqual(classifyQualificationFailure(evidence("cancelled", "skipped", "cancelled")).classification,
    { stage: "cancelled", disposition: "cancelled", recoverable: false });
});

test("native matrix placeholders cannot invent, waive, or hide platform gate evidence", () => {
  for (const conclusion of ["success", "failure", "cancelled"]) {
    const input = evidence(); input.jobs[4].conclusion = conclusion;
    assert.throws(() => classifyQualificationFailure(input), /not skipped/u);
  }
  const running = evidence(); running.jobs[4].status = "in_progress";
  assert.throws(() => classifyQualificationFailure(running), /terminal/u);
  const duplicate = evidence(); duplicate.jobs.push({ ...duplicate.jobs[4] });
  assert.throws(() => classifyQualificationFailure(duplicate), /ambiguous/u);
  const mixed = evidence();
  mixed.jobs.push({ name: "Native Windows qualification", conclusion: "failure", status: "completed" });
  assert.throws(() => classifyQualificationFailure(mixed), /ambiguous/u);
  const missing = evidence(); missing.jobs.splice(4, 1);
  assert.throws(() => classifyQualificationFailure(missing), /exactly one native Windows/u);
  const partial = evidence(); partial.jobs[4].name = "Native Windows qualification";
  assert.throws(() => classifyQualificationFailure(partial), /exactly one native macOS/u);
});
