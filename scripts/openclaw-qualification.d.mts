export interface OpenClawQualification {
  format: "thunderclaw-openclaw-qualification-v1";
  apiFloor: string;
  stableVersion: string;
  supportedRange: string;
  nextReleaseFloor: string;
  image: { repository: string; linuxAmd64Digest: string };
  npm: { integrity: string };
  provider: { package: string; version: string; integrity: string };
  upstream: { repository: string; releaseTag: string; releaseCommit: string };
}

export function validateOpenClawQualification(value: unknown): OpenClawQualification;
export function readOpenClawQualification(root: string): Promise<OpenClawQualification>;
export function captureOne(file: string, contents: string, pattern: RegExp, expected: string): void;
export function forbidPattern(file: string, contents: string, pattern: RegExp, description: string): void;
export function verifyDigestPinningSources(sources: { pairing: string; realAgent: string }): void;
export function verifyOpenClawQualification(options: { root: string }): Promise<{
  stableVersion: string;
  supportedRange: string;
  pinnedImage: string;
  providerSpec: string;
  checkedFiles: number;
}>;
