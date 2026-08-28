export type ReleaseChannel = "openclaw-plugin" | "thunderbird-extension";

export interface ReleaseDispatch {
  tag: string;
  version: string;
  layout: "legacy-combined-v1" | "independent-v2";
  verifier: "verify-marketplace-release-v1.mjs" | "verify-marketplace-release.mjs";
  channels: ReleaseChannel[];
}

export function dispatchRelease(tag: string, requestedChannel?: ReleaseChannel | "both"): ReleaseDispatch;
