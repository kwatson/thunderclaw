export const AUTOPILOT_WORKFLOW: ".github/workflows/openclaw-autopilot.yml";
export function assertOpenClawAutopilotEnabled(input?: {
  apiUrl?: string;
  repository?: string;
  token?: string;
  rolloutEnabled?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ enabled: true; workflow: typeof AUTOPILOT_WORKFLOW }>;
