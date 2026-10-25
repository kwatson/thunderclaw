export function verifyAtnRelease(options: {
  version: string;
  notesFile: string;
  xpi: string;
  downloadOutput?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<{
  version: string;
  releaseNotesVerified: boolean;
  releaseNotesStatus: "missing" | "mismatch" | "verified";
  signedXpiVerified: true;
  qualifiedXpiSha256: string;
  signedXpiSha256: string;
  signedXpiSize: number;
  reviewerSourceVerification: "unknown";
  reviewerTestingNotesVerification: "unknown";
}>;
