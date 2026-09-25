import { pathToFileURL } from "node:url";

export const AUTOPILOT_VARIABLE = "OPENCLAW_AUTOPILOT_ENABLED";

export async function assertOpenClawAutopilotEnabled({
  apiUrl = "https://api.github.com",
  repository,
  token,
  fetchImpl = fetch,
} = {}) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("GITHUB_REPOSITORY is missing or malformed");
  }
  if (typeof token !== "string" || token.length < 1) throw new Error("a GitHub token is required for the live autopilot guard");
  const response = await fetchImpl(`${apiUrl.replace(/\/$/u, "")}/repos/${repository}/actions/variables/${AUTOPILOT_VARIABLE}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`live autopilot guard could not read the repository variable (HTTP ${response.status})`);
  const body = await response.json();
  if (body?.name !== AUTOPILOT_VARIABLE || body?.value !== "true") {
    throw new Error("OpenClaw autopilot is disabled by the live repository kill switch");
  }
  return { enabled: true, variable: AUTOPILOT_VARIABLE };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await assertOpenClawAutopilotEnabled({
      apiUrl: process.env.GITHUB_API_URL,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
