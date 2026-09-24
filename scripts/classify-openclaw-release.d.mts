export interface ReleaseClassificationInput {
  state: unknown;
  stateCommit: string;
  result: unknown;
  resultSha256: string;
  run: Record<string, any>;
  context: { repository: string; repositoryId: number; tag: string; commit: string; tree: string; pluginVersion: string };
  classification: { decision: string; findings: string[]; evidenceSha256: string };
  automation: Record<string, string>;
  counterpart: { repository: string; tag: string; name: string; sha256: string; size: number };
}

export function classifyOpenClawRelease(input: ReleaseClassificationInput): {
  releaseLane: "automatic";
  reservationId: string;
  stateCommit: string;
  phase: string;
};
