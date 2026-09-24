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
export function summarizeUpstreamCi(releaseBody: unknown): {
  conclusion: string;
  waived: true;
} | undefined;
