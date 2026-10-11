export type DiagnosticInput = { phase: string; outcome: string; [key: string]: unknown };
export function diagnosticRecord(input: DiagnosticInput): Record<string, unknown>;
export function writeQualificationDiagnostic(input: DiagnosticInput, file?: string): void;
export function containerDiagnostic(container: string, run?: (
  program: string,
  args: string[],
  options: { encoding: string; timeout: number; maxBuffer: number },
) => { status: number | null; stdout?: string; error?: unknown }): Record<string, unknown>;
