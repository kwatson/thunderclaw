export function assessClawHubPublisher(options: {
  run: any; submission?: any; repository: string; tag: string; commit: string;
}): 'await' | 'complete' | 'verify-public';

export function selectOriginalClawHubPublisher(runs: any[], identity: { repository: string; tag: string; commit: string }): any | null;
export function findOriginalClawHubPublisher(identity: { repository: string; tag: string; commit: string }, execute?: any): any | null;
