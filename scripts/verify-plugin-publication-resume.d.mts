export function verifyPluginPublicationResume(options: {
  repository: string; tag: string; commit: string; runId: number;
  run: any; jobs: any[]; state: any; provenance: any; bytes: Uint8Array;
}): { tag: string; commit: string; version: string; sha256: string; size: number };
