export function planPublicationRecovery(options: {
  repository: string; state: any; sourceRuns: any[]; recoveryRuns: any[]; release: any; operatorRetry?: boolean; publisher?: any; reconciliation?: any;
}): { action: string; reason: string; tag?: string; runId?: number };
export function closeoutChecksPassed(checks: { name: string; workflow: string; state: string }[]): boolean;

export function verifyCloseoutEvidence(evidence: any): any;
export function authenticateCloseout(state: any, repository: string, execute?: any): any;
