export type ProviderEvidenceRecord = {
  sequence: number;
  roles: unknown[];
};

export function providerRepairObserved(records: readonly ProviderEvidenceRecord[]): boolean;
