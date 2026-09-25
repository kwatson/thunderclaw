import type { UpgradePreflight } from "./openclaw-upgrade-policy.mjs";
export const PREPARATION_FILES: string[];
export function nextPatchVersion(version: string): string;
export function buildPreparedFiles(options: { files: Record<string, string>; preflight: UpgradePreflight; generatedLockfile: string; preparedDate: string }): {
  files: Record<string, string>; pluginVersion: string; qualification: { stableVersion: string; [key: string]: unknown };
};
export function prepareOpenClawUpgrade(options: { root: string; baseline: UpgradePreflight; preflight: UpgradePreflight; lockfileMode?: "update" | "verify"; generatedLockfileContents?: string; preparedDate?: string; soakWaived?: boolean }): Promise<Record<string, unknown>>;
