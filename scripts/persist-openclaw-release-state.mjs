import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertOpenClawAutopilotEnabled } from "./assert-openclaw-autopilot-enabled.mjs";
import { applyReleaseStateIntent, validateReleaseState } from "./openclaw-release-state.mjs";

const STATE_REF = "refs/heads/automation/openclaw-autopilot-state";

// Promotion and completion share a fixed ref, authenticated parent and live
// pause guard. The lease is the final arbiter when callbacks and polling race.
export async function persistReleaseState({ root = process.cwd(), state, intent, expectedCommit, message, token, assertEnabled }) {
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit ?? "") || !token || typeof message !== "string" || !message.trim()) {
    throw new Error("State persistence requires an exact parent, token and commit message");
  }
  const git = (args, input) => {
    try { return execFileSync("git", args, { cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); }
    catch { throw new Error("State persistence failed; the recorded parent and compare-and-swap lease must be rechecked"); }
  };
  validateReleaseState(state);
  const parent = JSON.parse(git(["show", `${expectedCommit}:state.json`]));
  if (!isDeepStrictEqual(parent, state)) throw new Error("State snapshot differs from its recorded parent");
  const result = applyReleaseStateIntent(state, intent);
  if (result.decision === "already-applied") return { ...result, commit: expectedCommit };
  if (result.decision !== "applied") throw new Error(`State intent cannot be persisted: ${result.decision}`);
  const bytes = `${JSON.stringify(result.state, null, 2)}\n`;
  const blob = git(["hash-object", "-w", "--stdin"], bytes);
  const tree = git(["mktree"], `100644 blob ${blob}\tstate.json\n`);
  const commit = git(["commit-tree", tree, "-p", expectedCommit], `${message}\n`);
  await assertEnabled();
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  git(["-c", `http.extraheader=AUTHORIZATION: basic ${auth}`, "push", "origin",
    `--force-with-lease=${STATE_REF}:${expectedCommit}`, `${commit}:${STATE_REF}`]);
  return { ...result, commit };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [stateFile, intentFile, expectedCommit, message] = process.argv.slice(2);
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const result = await persistReleaseState({ state: JSON.parse(readFileSync(stateFile, "utf8")),
      intent: JSON.parse(readFileSync(intentFile, "utf8")), expectedCommit, message, token,
      assertEnabled: () => assertOpenClawAutopilotEnabled({ apiUrl: process.env.GITHUB_API_URL,
        repository: process.env.GITHUB_REPOSITORY, token }) });
    writeFileSync(stateFile, `${JSON.stringify(result.state, null, 2)}\n`);
    console.log(JSON.stringify({ commit: result.commit, decision: result.decision }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
