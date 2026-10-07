export function assessClawHubPublisher(options: {
  run: any; submission?: any; repository: string; tag: string; commit: string;
}): 'await' | 'complete' | 'verify-public';
