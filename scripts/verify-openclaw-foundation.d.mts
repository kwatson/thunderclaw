export interface FoundationResult { releaseLane: "foundation"; humanReviewRequired: true; counterpartCloseoutRequired: true; fromTag: string; tag: string; pluginVersion: string; openclawVersion: string; commit: string; tree: string }
export function validateFoundationManifest(value: unknown): any;
export function assessFoundationMigration(input: any): FoundationResult;
export function verifyFoundationMigration(input: { root: string; tag: string; commit: string }): Promise<FoundationResult>;
export interface FoundationCloseoutResult { rolloverAllowed: true; retiredReservationId: string; retiredIdentitySha256: string; foundationTag: string }
export function assessFoundationCloseout(input: any): FoundationCloseoutResult;
export function verifyFoundationCloseout(input: { root: string; stateFile: string }): Promise<FoundationCloseoutResult>;
