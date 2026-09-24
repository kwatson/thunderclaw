export interface UpgradePreflight {
  format: "thunderclaw-openclaw-upgrade-preflight-v2";
  observedAt: string;
  current: { version: string; releaseCommit: string; pluginVersion: string };
  proposed: {
    version: string;
    npm: { package: "openclaw"; version: string; integrity: string; tarball: string };
    providerNpm: { package: string; version: string; integrity: string; tarball: string };
    upstream: { repository: string; tag: string; releaseTag: string; commit: string; verifiedTag: boolean; verifiedCommit: boolean; tagKind: "annotated" | "lightweight"; officialRelease: true; releaseId: number; releaseUrl: string; publishedAt: string; draft: false; prerelease: false };
    image: { repository: string; tag: string; indexDigest: string; linuxAmd64Digest: string };
  };
  sdk: { requiredEntrypoints: string[]; missingEntrypoints: string[]; declarationFiles: string[]; changedDeclarations: string[]; currentHashes: Record<string, string>; proposedHashes: Record<string, string> };
  upstreamCi?: { conclusion: string; waived: boolean };
  repositoryImpact: string[];
  blockingFindings: string[];
  advisoryFindings: string[];
  compatibilityDecision: "not-made";
}
export function compareOpenClawVersions(left: string, right: string): -1 | 0 | 1;
export function validateUpgradePreflight(value: unknown): UpgradePreflight;
export function immutableReleaseIdentity(preflight: UpgradePreflight): Record<string, string | number>;
export function hashReleaseIdentity(identity: unknown): string;
export function assessUpgradeEvidence(options: { baseline: UpgradePreflight; current: UpgradePreflight; now?: string }): {
  format: "thunderclaw-openclaw-upgrade-assessment-v1";
  decision: "blocked" | "ready" | "waiting";
  identity: Record<string, string | number>;
  identitySha256: string;
  firstObservedAt: string;
  revalidatedAt: string;
  soakCompletesAt: string;
  blockers: string[];
  advisories: string[];
};
