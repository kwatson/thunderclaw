export function normalizeMarketplaceNotes(value: unknown): string;
export const CLAWHUB_PUBLICATION_TIMEOUT_MS: number;

export function verifyMarketplaceNotes(expected: unknown, actual: unknown, marketplace: string): string;
export function verifyClawHubRelease(options: {
  packageName: string;
  version: string;
  notesFile?: string;
  artifact: string;
  repository: string;
  tag: string;
  commit: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{
  packageName: string;
  version: string;
  changelogVerified: boolean;
  artifactVerified: true;
  sourceVerified: true;
  endpoint: string;
}>;
export function verifyClawHubReleaseNotes(options: {
  packageName: string;
  version: string;
  notesFile: string;
  artifact: string;
  repository: string;
  tag: string;
  commit: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{
  packageName: string;
  version: string;
  changelogVerified: true;
  artifactVerified: true;
  sourceVerified: true;
  endpoint: string;
}>;
