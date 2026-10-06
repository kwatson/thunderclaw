import assert from "node:assert/strict";
import test from "node:test";
import { assertOpenClawAutopilotEnabled, AUTOPILOT_WORKFLOW } from "../scripts/assert-openclaw-autopilot-enabled.mjs";

test("live autopilot guard authenticates the exact active controller and requires rollout admission", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ path: AUTOPILOT_WORKFLOW, state: "active" });
  };
  assert.deepEqual(await assertOpenClawAutopilotEnabled({
    apiUrl: "https://github.example/api/v3/", repository: "owner/repo", token: "fixture-token", rolloutEnabled: "true", fetchImpl,
  }), { enabled: true, workflow: AUTOPILOT_WORKFLOW });
  assert.deepEqual(calls, [{
    url: "https://github.example/api/v3/repos/owner/repo/actions/workflows/openclaw-autopilot.yml",
    authorization: "Bearer fixture-token",
  }]);
  const original = process.env.OPENCLAW_AUTOPILOT_ENABLED;
  delete process.env.OPENCLAW_AUTOPILOT_ENABLED;
  try {
    for (const rolloutEnabled of [undefined, "false", "TRUE", ""]) {
      await assert.rejects(assertOpenClawAutopilotEnabled({
        repository: "owner/repo", token: "fixture-token", rolloutEnabled, fetchImpl,
      }), /rollout setting/u);
    }
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_AUTOPILOT_ENABLED;
    else process.env.OPENCLAW_AUTOPILOT_ENABLED = original;
  }
  assert.equal(calls.length, 1, "a disabled rollout must not reach the live authorization boundary");
});

test("autopilot guard uses rollout admission from the job environment when omitted", async () => {
  const original = process.env.OPENCLAW_AUTOPILOT_ENABLED;
  const input = { repository: "owner/repo", token: "fixture-token",
    fetchImpl: async () => Response.json({ path: AUTOPILOT_WORKFLOW, state: "active" }) };
  try {
    process.env.OPENCLAW_AUTOPILOT_ENABLED = "true";
    await assertOpenClawAutopilotEnabled(input);
    process.env.OPENCLAW_AUTOPILOT_ENABLED = "false";
    await assert.rejects(assertOpenClawAutopilotEnabled(input), /rollout setting/u);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_AUTOPILOT_ENABLED;
    else process.env.OPENCLAW_AUTOPILOT_ENABLED = original;
  }
});

test("live autopilot guard fails closed for disabled, malformed, missing, and unreadable workflows", async () => {
  for (const response of [
    ...["disabled_manually", "disabled_inactivity", "disabled_fork", "deleted"].map((state) => Response.json({ path: AUTOPILOT_WORKFLOW, state })),
    Response.json({ path: AUTOPILOT_WORKFLOW, state: true }),
    Response.json({ path: ".github/workflows/other.yml", state: "active" }),
    Response.json({ state: "active" }),
    Response.json({ message: "not found" }, { status: 404 }),
    Response.json({ message: "forbidden" }, { status: 403 }),
  ]) {
    await assert.rejects(assertOpenClawAutopilotEnabled({
      repository: "owner/repo", token: "fixture-token", rolloutEnabled: "true", fetchImpl: async () => response.clone(),
    }), /disabled|could not read/u);
  }
  await assert.rejects(assertOpenClawAutopilotEnabled({ repository: "owner/repo", token: "", rolloutEnabled: "true" }), /token is required/u);
});

test("disabling the controller revokes the next mutation boundary in an already running job", async () => {
  let state = "active";
  const input = {
    repository: "owner/repo", token: "fixture-token", rolloutEnabled: "true",
    fetchImpl: async () => Response.json({ path: AUTOPILOT_WORKFLOW, state }),
  };
  await assertOpenClawAutopilotEnabled(input);
  state = "disabled_manually";
  await assert.rejects(assertOpenClawAutopilotEnabled(input), /live controller workflow pause switch/u);
});
