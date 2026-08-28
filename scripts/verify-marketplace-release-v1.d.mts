import type { VerifiedArtifact } from "./verify-marketplace-release.mjs";

export function expectedArtifactNamesV1(version: string): string[];
export function parseChecksumsV1(contents: string): Map<string, string>;
export function verifyMarketplaceReleaseV1(options: {
  directory: string;
  tag: "v0.1.0" | "v0.1.1";
  repository: string;
  commit: string;
}): Promise<{ tag: string; version: string; commit: string; artifacts: VerifiedArtifact[] }>;
