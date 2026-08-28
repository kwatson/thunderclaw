export function verifyLegacyMarketplaceRelease(options: {
  directory: string;
  tag: "v0.1.0" | "v0.1.1";
  repository: string;
  commit: string;
  ledgerPath?: string;
}): Promise<unknown>;
