import type { UpgradePreflight } from "./openclaw-upgrade-policy.mjs";
export interface FileDescriptor { type: string; mode: string; content: string }
export function classifyLockfileChange(before: string, after: string): string[];
export function snapshotGitRange(root: string, beforeRef: string, afterRef: string): { before: Record<string, FileDescriptor>; after: Record<string, FileDescriptor>; beforeCommit: string; afterCommit: string };
export function regenerateLockfile(root: string, snapshots: ReturnType<typeof snapshotGitRange>, preflight: UpgradePreflight, preparedDate: string): Promise<string>;
export function classifyPreparedUpgrade(options: { before: Record<string, string | FileDescriptor>; after: Record<string, string | FileDescriptor>; preflight: UpgradePreflight; preparedDate: string; expectedLockfile: string }): {
  format: "thunderclaw-openclaw-upgrade-classification-v1"; decision: "compatibility-only" | "blocked"; changed: string[]; files: Array<{ path: string; before: { type: string; mode: string; sha256: string }; after: { type: string; mode: string; sha256: string } }>; findings: string[]; advisories: string[]; version: string | null; pluginVersion: string | null; evidenceSha256: string;
};
