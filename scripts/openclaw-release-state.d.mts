import type { UpgradePreflight } from "./openclaw-upgrade-policy.mjs";
export const RELEASE_STATE_FORMAT: "thunderclaw-openclaw-autopilot-state-v1";
export const RELEASE_INTENT_FORMAT: "thunderclaw-openclaw-autopilot-intent-v1";
export type ReleasePhase = "observed" | "ready" | "prepared" | "qualifying" | "qualified" | "merged" | "tagged" | "github-published" | "clawhub-verified" | "closeout-open" | "complete" | "blocked";
export interface ReleaseState { format: typeof RELEASE_STATE_FORMAT; revision: number; phase: ReleasePhase; reservationId: string; baseSha: string; baseline: UpgradePreflight; identity: Record<string, string | number>; identitySha256: string; firstObservedAt: string; lastObservedAt: string; soakCompletesAt: string; advisories: string[]; blockers: string[]; outputs: Record<string, any>; history: Array<Record<string, unknown>> }
export interface ReleaseIntent { format: typeof RELEASE_INTENT_FORMAT; intentId: string; expectedRevision: number; type: "reobserve" | "record-preparation" | "record-qualification-dispatch" | "record-qualification" | "record-merge" | "record-tag" | "record-github-publication" | "record-clawhub-verification" | "open-closeout" | "complete-closeout" | "block"; at: string; payload: Record<string, unknown> }
export function validateReleaseState(value: unknown): ReleaseState;
export function createReleaseState(preflight: unknown, identity: { reservationId: string; baseSha: string }): ReleaseState;
export function applyReleaseStateIntent(state: unknown, intent: unknown): { decision: "applied" | "already-applied" | "compare-and-swap-mismatch" | "terminal"; expectedRevision: number; state: ReleaseState };
export function decideReleaseResume(state: ReleaseState): { action: string; revision: number; notBefore?: string; blockers?: string[] };
