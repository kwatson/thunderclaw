export interface AutopilotQualificationResult {
  format: "thunderclaw-openclaw-autopilot-result-v1";
  repository: string;
  repositoryId: number;
  workflow: ".github/workflows/qualify-openclaw-autopilot.yml";
  workflowCommit: string;
  workflowSha256: string;
  event: "workflow_dispatch";
  runId: number;
  runAttempt: number;
  requestId: string;
  reservationId: string;
  version: string;
  identitySha256: string;
  baseSha: string;
  tag: string;
  candidateArtifactSha256: string;
  candidate: { ref: string; sha: string; tree: string };
  counterpart: { repository: string; tag: string; name: string; sha256: string; size: number };
  classification: { decision: "compatibility-only"; evidenceSha256: string };
  automation: { controllerWorkflowSha: string; qualificationWorkflowSha: string; releaseWorkflowSha: string; classifierSha: string };
  gates: Record<"deterministic" | "openclaw-integration" | "pair-qualification" | "thunderbird-linux" | "native-windows" | "native-macos", "success">;
  decision: "pass";
}

export function validateAutopilotQualificationResult(value: unknown): AutopilotQualificationResult;
export function verifyAutopilotQualificationResult(
  value: unknown,
  expected: Partial<Record<string, string>>,
): AutopilotQualificationResult;
