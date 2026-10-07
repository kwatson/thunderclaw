import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateReleaseState } from "./openclaw-release-state.mjs";

export async function reconcileAuthorizedTag({ state, repository, api, assertEnabled }) {
  validateReleaseState(state);
  if (state.phase !== "tagged") throw new Error("Tag creation requires durable exact tag authorization");
  const { tag, commit, tree } = state.outputs.tagged;
  const message = `ThunderClaw OpenClaw plugin ${state.outputs.preparation.pluginVersion}`;
  const prefix = `repos/${repository}/git`;
  const refPath = `${prefix}/ref/tags/${tag}`;
  const source = await api("GET", `${prefix}/commits/${commit}`);
  if (source.sha !== commit || source.tree?.sha !== tree) throw new Error("Authorized tag source tree differs");
  async function verify(ref) {
    if (ref.ref !== `refs/tags/${tag}` || ref.object?.type !== "tag") throw new Error("Existing tag is not the authorized annotated tag");
    const annotation = await api("GET", `${prefix}/tags/${ref.object.sha}`);
    if (annotation.tag !== tag || annotation.message !== message || annotation.object?.type !== "commit" || annotation.object.sha !== commit) {
      throw new Error("Existing immutable tag identity differs from authorization");
    }
  }
  let ref = await api("GET", refPath, undefined, { allowNotFound: true });
  if (ref) { await verify(ref); return { action: "verified", tag }; }
  await assertEnabled();
  const annotation = await api("POST", `${prefix}/tags`, { tag, message, object: commit, type: "commit" });
  if (!/^[a-f0-9]{40}$/u.test(annotation.sha)) throw new Error("Malformed annotated tag object");
  await assertEnabled();
  // No update/delete endpoint exists here. A race fails closed and is verified
  // during the next reconciliation; an ambiguous create is never force-pushed.
  await api("POST", `${prefix}/refs`, { ref: `refs/tags/${tag}`, sha: annotation.sha });
  ref = await api("GET", refPath);
  await verify(ref);
  return { action: "created", tag };
}

function githubApi(method, endpoint, payload, { allowNotFound = false } = {}) {
  const args = ["api", "--include", "--method", method, endpoint];
  if (payload) args.push("--input", "-");
  let output;
  try { output = execFileSync("gh", args, { input: payload ? JSON.stringify(payload) : undefined, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }
  catch (error) {
    const response = String(error.stdout ?? "");
    if (allowNotFound && /^HTTP\/\S+ 404\b/mu.test(response)) return null;
    throw new Error(`GitHub ${method} ${endpoint} failed; absent identity was not established`);
  }
  const separator = output.search(/\r?\n\r?\n/u);
  if (separator < 0) throw new Error("GitHub response headers are missing");
  return JSON.parse(output.slice(separator).trim());
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const result = await reconcileAuthorizedTag({ state: JSON.parse(readFileSync(process.argv[2], "utf8")), repository: process.env.GITHUB_REPOSITORY, api: githubApi,
      assertEnabled: () => execFileSync("mise", ["exec", "--", "node", "scripts/assert-openclaw-autopilot-enabled.mjs"], { stdio: "pipe" }) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
