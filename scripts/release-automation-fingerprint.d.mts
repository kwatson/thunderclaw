export const CLASSIFIER_PATHS: readonly string[];
export const RELEASE_PATHS: readonly string[];
export function combinedAutomationDigest(files: readonly string[], read?: (file: string) => string | Uint8Array): string;
export function calculateAutomationFingerprint(read?: (file: string) => string | Uint8Array): {
  controllerWorkflowSha256: string;
  qualificationWorkflowSha256: string;
  classifierSha256: string;
  releaseWorkflowSha256: string;
};
