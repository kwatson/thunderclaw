import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAutopilotQualificationResult,
  verifyAutopilotQualificationResult,
} from "../scripts/verify-openclaw-autopilot-result.mjs";

const sha = (value: string) => value.repeat(40);
const digest = (value: string) => value.repeat(64);

function validResult() {
  return {
    format: "thunderclaw-openclaw-autopilot-result-v1",
    repository: "kwatson/thunderclaw",
    repositoryId: 1234,
    workflow: ".github/workflows/qualify-openclaw-autopilot.yml",
    workflowCommit: sha("a"),
    workflowSha256: digest("9"),
    event: "workflow_dispatch",
    runId: 99,
    runAttempt: 1,
    requestId: "b".repeat(32),
    reservationId: "1".repeat(32),
    version: "2026.9.6",
    identitySha256: digest("c"),
    baseSha: sha("2"),
    tag: "openclaw-plugin-v0.1.10",
    candidateArtifactSha256: digest("8"),
    candidate: { ref: "automation/openclaw-2026.9.6", sha: sha("d"), tree: sha("e") },
    counterpart: {
      repository: "kwatson/thunderclaw",
      tag: "thunderbird-extension-v0.1.2",
      name: "thunderclaw-thunderbird-0.1.2.xpi",
      sha256: digest("f"),
      size: 4567,
    },
    classification: { decision: "compatibility-only", evidenceSha256: digest("3") },
    automation: {
      controllerWorkflowSha: digest("4"),
      qualificationWorkflowSha: digest("5"),
      releaseWorkflowSha: digest("6"),
      classifierSha: digest("7"),
    },
    gates: {
      deterministic: "success",
      "openclaw-integration": "success",
      "pair-qualification": "success",
      "thunderbird-linux": "success",
      "native-windows": "success",
      "native-macos": "success",
    },
    decision: "pass",
  };
}

test("autopilot result requires every exact successful gate", () => {
  assert.equal(validateAutopilotQualificationResult(validResult()).decision, "pass");
  assert.throws(() => validateAutopilotQualificationResult({
    ...validResult(),
    gates: { ...validResult().gates, "native-macos": "skipped" },
  }), /without skips or waivers/u);
  const missingGate = validResult();
  delete (missingGate.gates as Partial<typeof missingGate.gates>)["native-windows"];
  assert.throws(() => validateAutopilotQualificationResult(missingGate), /strict autopilot result schema/u);
});

test("autopilot result verification binds the reserved run, attempt, source tree, and counterpart", () => {
  const result = validResult();
  assert.equal(verifyAutopilotQualificationResult(result, {
    repository: result.repository,
    runId: String(result.runId),
    runAttempt: String(result.runAttempt),
    candidateSha: result.candidate.sha,
    candidateTree: result.candidate.tree,
    counterpartSha256: result.counterpart.sha256,
  }).requestId, result.requestId);
  assert.throws(() => verifyAutopilotQualificationResult(result, { runAttempt: "2" }), /reserved value/u);
  assert.throws(() => verifyAutopilotQualificationResult(result, { candidateTree: sha("0") }), /reserved value/u);
  assert.throws(() => verifyAutopilotQualificationResult(result, { counterpartSha256: digest("0") }), /reserved value/u);
});
