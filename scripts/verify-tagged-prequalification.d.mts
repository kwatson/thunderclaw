import type { ReleaseClassificationInput } from "./classify-openclaw-release.mjs";
export interface TaggedPrequalificationEntry {
  reuseRequested: boolean;
  component: string;
  releaseLane: string;
  event: string;
  ref: string;
  workflowRef: string;
  repository: string;
  tag: string;
}
export interface TaggedPrequalificationReceipt {
  format: "thunderclaw-tagged-prequalification-receipt-v1";
  decision: "pass";
  releaseLane: "automatic";
  reservationId: string;
  stateCommit: string;
  source: { repository: string; tag: string; commit: string; tree: string };
  qualification: { runId: number; runAttempt: number; requestId: string; evidenceSha256: string };
  plugin: { sha256: string; size: number };
  counterpart: { repository: string; tag: string; name: string; sha256: string; size: number };
  gates: Record<string, string>;
  automation: Record<string, string>;
}
export function assertTaggedPrequalificationEntry(entry: TaggedPrequalificationEntry): void;
export function verifyTaggedPrequalification(input: {
  classificationInput: ReleaseClassificationInput;
  entry: TaggedPrequalificationEntry;
  jobs: { name: string; status: string; conclusion: string }[];
  pluginBytes: Uint8Array;
  counterpartBytes: Uint8Array;
  counterpartName: string;
}): TaggedPrequalificationReceipt;
export function authenticateTaggedPrequalification(options: {
  root: string;
  plugin: string;
  counterpart: string;
  output?: string;
  environment?: NodeJS.ProcessEnv;
  execute?: typeof import("node:child_process").execFileSync;
}): Promise<TaggedPrequalificationReceipt>;
