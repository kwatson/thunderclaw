export interface VerifiedArtifact {
  name: string;
  sha256: string;
  size: number;
}

export function expectedArtifactNames(component: "openclaw-plugin" | "thunderbird-extension", version: string): string[];
export function parseChecksums(contents: string): Map<string, string>;
export function validateReleaseProvenance(provenance: unknown, expected: {
  component: "openclaw-plugin" | "thunderbird-extension";
  tag: string;
  repository: string;
  commit: string;
  artifacts: VerifiedArtifact[];
}): void;
export function verifyMarketplaceRelease(options: {
  directory: string;
  component: "openclaw-plugin" | "thunderbird-extension";
  tag: string;
  repository: string;
  commit: string;
}): Promise<{
  component: "openclaw-plugin" | "thunderbird-extension";
  tag: string;
  version: string;
  commit: string;
  artifacts: VerifiedArtifact[];
}>;
