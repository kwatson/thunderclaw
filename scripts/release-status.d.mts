export interface ReleaseStatusClient {
  state(): Promise<unknown>;
  workflows(): Promise<any[]>;
  rollout(): Promise<boolean>;
  rules(): Promise<any[]>;
  run(id: number, attempt: number): Promise<any>;
  jobs(id: number, attempt: number): Promise<any[]>;
  runs(workflow: string, tag: string): Promise<any[]>;
  release(tag: string): Promise<any>;
  pullRequest(id: number): Promise<any>;
  baseline(): Promise<any>;
  main(): Promise<string>;
  checks(commit: string): Promise<any[]>;
  artifacts(id: number): Promise<any[]>;
  artifactText(artifact: any, member: string): Promise<string>;
  verifyPublic(options: { state: any; release: any }): Promise<any>;
}
export interface ReleaseStatusReport {
  format: "thunderclaw-release-status-v1";
  repository: string;
  inspectedAt: string;
  assessment: "unknown" | "incomplete" | "blocked" | "verified-complete";
  issues: string[];
  evidence: Record<string, any>;
  nextActions: string[];
}
export function createGitHubStatusClient(): ReleaseStatusClient;
export function collectReleaseStatus(client?: ReleaseStatusClient): Promise<ReleaseStatusReport>;
export function formatReleaseStatus(report: ReleaseStatusReport): string;
