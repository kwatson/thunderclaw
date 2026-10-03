export interface ChangeScope {
  plugin: string[]; extension: string[]; internal: string[]; documentation: string[];
  runChecks: boolean; qualifyPlugin: boolean; qualifyExtension: boolean;
}
export function classifyChangeScope(files: string[]): ChangeScope;
export function changedFiles(root: string, base: string, target: string): string[];
export function assessPublishedPluginChanges(root: string, tag: string, base: string): ChangeScope & { findings: string[] };
