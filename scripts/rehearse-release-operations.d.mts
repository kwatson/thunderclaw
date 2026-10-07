export function rehearseReleaseOperations(): Promise<{
  format: string;
  cases: string[];
  networkScope: "loopback-only";
  externalMutations: number;
  productArtifactsBuilt: number;
  productTagsCreated: number;
  secretsRequired: false;
}>;
