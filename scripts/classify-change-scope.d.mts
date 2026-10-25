export interface ChangeScope {
  extension: string[]; internal: string[]; documentation: string[];
  runChecks: boolean; qualifyExtension: boolean;
}
export function classifyChangeScope(files: string[]): ChangeScope;
export function changedFiles(root: string, base: string, target: string): string[];
