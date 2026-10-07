import type { ReleaseState } from "./openclaw-release-state.mjs";
export const STALE_MAIN_REASON: string;
export const DISPATCH_ADMISSION_REASON: string;
export function selectQualificationRun(input: {state: ReleaseState; repository: string; runs: any[]}): {action: "dispatch" | "wait" | "completed" | "admission-mismatch"; run?: any};
export function authenticateDispatchMismatch(input: {state: ReleaseState; repository: string; run: any; jobs: any}): boolean;
export function isSafeStaleCandidate(state: ReleaseState): boolean;
