export const AUTOPILOT_VARIABLE: "OPENCLAW_AUTOPILOT_ENABLED";
export function assertOpenClawAutopilotEnabled(input?: {
  apiUrl?: string;
  repository?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ enabled: true; variable: typeof AUTOPILOT_VARIABLE }>;
