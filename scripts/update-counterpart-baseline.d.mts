import type { CounterpartBaselines } from "./verify-counterpart-baseline.mjs";

export interface VerifiedReleaseForBaseline {
  component: "openclaw-plugin" | "thunderbird-extension";
  tag: string;
  version: string;
  artifacts: Array<{ name: string; sha256: string; size: number }>;
}

export function updateCounterpartManifest(
  manifest: CounterpartBaselines,
  verifiedRelease: VerifiedReleaseForBaseline,
): CounterpartBaselines;
