export function verifyAtnRelease(options: {
  version: string;
  notesFile: string;
  xpi: string;
  downloadOutput?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown>;
