export interface QualificationFailureEvidence {
  format: "thunderclaw-openclaw-qualification-failure-v1";
  run: { id: number; attempt: number; event: "workflow_dispatch"; conclusion: string; workflowCommit: string; workflowPath: string };
  reservation: { reservationId: string; identitySha256: string; requestId: string; candidateSha: string };
  jobs: Record<string, string>;
  classification: { stage: "pre-gate" | "gate" | "cancelled"; disposition: "retryable" | "blocked" | "cancelled"; recoverable: boolean };
  evidenceSha256: string;
}
export function validateQualificationFailureEvidence(value: unknown): QualificationFailureEvidence;
export function classifyQualificationFailure(input: { state: any; run: any; jobs: any }): QualificationFailureEvidence;
