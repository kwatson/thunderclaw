export function verifyAtnXpiPayload(options: {
  qualifiedXpi: string;
  publicXpi: string;
}): Promise<{
  mode: "byte-identical" | "signature-metadata-added";
  qualifiedSha256: string;
  publicSha256: string;
  signatureEntries: string[];
}>;
