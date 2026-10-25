export type ReleaseChannel = "thunderbird-extension";

export interface ReleaseDispatch {
  tag: string;
  version: string;
  layout: "independent-v2";
  verifier: "verify-marketplace-release.mjs";
  channels: ReleaseChannel[];
}

export function dispatchRelease(tag: string, requestedChannel?: ReleaseChannel): ReleaseDispatch;
