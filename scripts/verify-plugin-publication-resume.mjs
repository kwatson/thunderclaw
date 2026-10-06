import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyPluginPublicationResume({ repository, tag, commit, runId, run, jobs, state, provenance, bytes }) {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  require(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository), "Invalid repository");
  require(/^openclaw-plugin-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(tag), "Invalid release tag");
  require(/^[a-f0-9]{40}$/u.test(commit), "Invalid release commit");
  require(Number.isSafeInteger(runId) && runId > 0, "Invalid source run");
  require(run.id === runId && run.repository?.full_name === repository && run.event === "push"
    && run.path?.split("@")[0] === ".github/workflows/release-openclaw-plugin.yml"
    && run.head_sha === commit && run.head_branch === tag, "Source run is not the exact protected-tag release");
  for (const name of ["Select fail-closed release lane", "Validate and build plugin once", "Qualify exact plugin archive",
    "Qualify exact plugin with pinned extension / Protected real-agent pair qualification", "Create plugin GitHub release"]) {
    const matches = jobs.filter((job) => job.name === name);
    require(matches.length === 1 && matches[0].status === "completed" && matches[0].conclusion === "success",
      `Required release gate did not pass: ${name}`);
  }
  require(["tagged", "github-published", "clawhub-verified", "closeout-open", "complete"].includes(state.phase)
    && state.outputs?.preparation?.tag === tag && state.outputs?.merge?.mergeSha === commit,
  "Release is not the active qualified reservation");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const version = tag.slice("openclaw-plugin-v".length);
  const name = `thunderclaw-openclaw-plugin-${version}.tgz`;
  require(state.outputs.qualification?.candidateArtifactSha256 === sha256,
    "Public archive differs from the qualified candidate");
  require(provenance.format === "thunderclaw-release-provenance-v2" && provenance.component === "openclaw-plugin"
    && provenance.source?.repository === `https://github.com/${repository}` && provenance.source?.tag === tag
    && provenance.source?.commit === commit && provenance.build?.run === `https://github.com/${repository}/actions/runs/${runId}`
    && provenance.build?.workflow === `${repository}/.github/workflows/release-openclaw-plugin.yml@refs/tags/${tag}`,
  "Public provenance does not identify the original release");
  require(provenance.artifacts?.length === 1 && provenance.artifacts[0].name === name
    && provenance.artifacts[0].sha256 === sha256 && provenance.artifacts[0].size === bytes.length,
  "Public archive does not match its provenance");
  return { tag, commit, version, sha256, size: bytes.length };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const options = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) =>
      [process.argv[2 + i * 2].replace(/^--/u, ""), process.argv[3 + i * 2]]));
    const json = (name) => JSON.parse(readFileSync(join(options.directory, name), "utf8"));
    const result = verifyPluginPublicationResume({ repository: options.repository, tag: options.tag, commit: options.commit,
      runId: Number(options["run-id"]), run: json("run.json"), jobs: json("jobs.json"), state: json("state.json"),
      provenance: json("release-provenance.json"),
      bytes: readFileSync(join(options.directory, `thunderclaw-openclaw-plugin-${options.tag.slice("openclaw-plugin-v".length)}.tgz`)) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
