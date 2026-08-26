export interface VerifiedArtifact {
  name: string;
  sha256: string;
  size: number;
}

export function expectedArtifactNames(version: string): string[];
export function parseChecksums(contents: string): Map<string, string>;
export function verifyMarketplaceRelease(options: {
  directory: string;
  tag: string;
  repository: string;
  commit: string;
}): Promise<{
  tag: string;
  version: string;
  commit: string;
  artifacts: VerifiedArtifact[];
}>;
