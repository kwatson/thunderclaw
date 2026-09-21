export function selectLinuxAmd64Digest(manifest: unknown): string;
export function summarizeSdkExports(packageManifest: unknown): {
  requiredEntrypoints: string[];
  missingEntrypoints: string[];
};
export function evaluateReleaseTag(refObject: unknown, annotatedTag: unknown): {
  commit: string;
  verifiedTag: boolean;
  tagKind: "lightweight" | "annotated";
};
