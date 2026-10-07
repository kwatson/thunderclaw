import type { ReleaseState, ReleaseIntent } from "./openclaw-release-state.mjs";
export function persistReleaseState(options: {
  root?: string; state: ReleaseState; intent: ReleaseIntent; expectedCommit: string;
  message: string; token: string; assertEnabled: () => Promise<unknown> | void;
}): Promise<{ decision: string; expectedRevision: number; state: ReleaseState; commit: string }>;
