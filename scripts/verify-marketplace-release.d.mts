export interface VerifiedArtifact {
  name: string;
  sha256: string;
  size: number;
}

export function expectedArtifactNames(component: "thunderbird-extension", version: string): string[];
export function parseChecksums(contents: string): Map<string, string>;
export function validateReleaseProvenance(provenance: unknown, expected: {
  component: "thunderbird-extension";
  tag: string;
  repository: string;
  commit: string;
  artifacts: VerifiedArtifact[];
}): void;
export function verifyMarketplaceRelease(options: {
  directory: string;
  component: "thunderbird-extension";
  tag: string;
  repository: string;
  commit: string;
}): Promise<{
  component: "thunderbird-extension";
  tag: string;
  version: string;
  commit: string;
  artifacts: VerifiedArtifact[];
}>;
