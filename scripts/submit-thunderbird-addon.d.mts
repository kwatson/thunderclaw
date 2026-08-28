export function createAtnJwt(options: {
  issuer: string;
  secret: string;
  now?: number;
  nonce?: string;
}): string;

export function versionEndpoint(apiBase: string, version: string): string;

export function submitToThunderbirdAddons(options: {
  xpi: string;
  version: string;
  issuer: string;
  secret: string;
  apiBase?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{
  addonId: string;
  version: string;
  processed: boolean;
  valid: boolean;
  reviewed: boolean;
  active: boolean;
  manualHandoffRequired: true;
  validationUrl: string | null;
}>;
