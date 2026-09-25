import assert from "node:assert/strict";
import test from "node:test";
import { assertOpenClawAutopilotEnabled, AUTOPILOT_VARIABLE } from "../scripts/assert-openclaw-autopilot-enabled.mjs";

test("live autopilot guard accepts only an authenticated exact true repository variable", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ name: AUTOPILOT_VARIABLE, value: "true" });
  };
  assert.deepEqual(await assertOpenClawAutopilotEnabled({
    apiUrl: "https://github.example/api/v3/", repository: "owner/repo", token: "fixture-token", fetchImpl,
  }), { enabled: true, variable: AUTOPILOT_VARIABLE });
  assert.deepEqual(calls, [{
    url: `https://github.example/api/v3/repos/owner/repo/actions/variables/${AUTOPILOT_VARIABLE}`,
    authorization: "Bearer fixture-token",
  }]);
});

test("live autopilot guard fails closed for false, malformed, missing, and unreadable variables", async () => {
  for (const response of [
    Response.json({ name: AUTOPILOT_VARIABLE, value: "false" }),
    Response.json({ name: AUTOPILOT_VARIABLE, value: true }),
    Response.json({ name: "OTHER", value: "true" }),
    Response.json({ message: "not found" }, { status: 404 }),
  ]) {
    await assert.rejects(assertOpenClawAutopilotEnabled({
      repository: "owner/repo", token: "fixture-token", fetchImpl: async () => response.clone(),
    }), /disabled|could not read/u);
  }
  await assert.rejects(assertOpenClawAutopilotEnabled({ repository: "owner/repo", token: "" }), /token is required/u);
});
