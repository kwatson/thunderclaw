interface Observation { state: string; data?: any }
export function githubObservation(endpoint: string): Observation;
export function releaseStatus(options: { tag: string; query?: (endpoint: string) => Observation | Promise<Observation>; fetchImpl?: typeof fetch }): Promise<any>;
