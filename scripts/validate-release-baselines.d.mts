export interface LegacyReleaseBaselineLedger {
  format: string;
  repository: string;
  releases: Array<{
    component: "openclaw-plugin" | "thunderbird-extension";
    version: string;
    legacyTag: string;
    commit: string;
    assets: Array<{ name: string; size: number; sha256: string }>;
    provenance: { format: string; workflowRun: string; attempt: number };
    attestation: { verified: boolean; issuer: string; workflow: string; invocation: string };
  }>;
}

export function validateReleaseBaselines(ledger: unknown): LegacyReleaseBaselineLedger;
