import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseReleaseTag } from "./release-metadata.mjs";
import { normalizeMarketplaceNotes } from "./verify-marketplace-notes.mjs";

const repository = "kwatson/thunderclaw";
const unknown = (reason) => ({ state: "unknown", reason });

export function githubObservation(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) return { state: result.stderr?.includes("(HTTP 404)") ? "absent" : "unknown" };
  try { return { state: "observed", data: JSON.parse(result.stdout) }; }
  catch { return { state: "unknown" }; }
}

function jobStage(jobs, names) {
  const matches = names.map((name) => jobs.find((job) => job.name === name));
  if (matches.some((job) => !job)) return unknown("Required job evidence is unavailable");
  if (matches.some((job) => job.status !== "completed")) return { state: "pending" };
  return { state: matches.every((job) => job.conclusion === "success") ? "observed" : "failed" };
}

export async function releaseStatus({ tag, query = githubObservation, fetchImpl = fetch }) {
  const { version } = parseReleaseTag(tag);
  const result = { tag, version, built: unknown("No build evidence inspected"), qualified: unknown("No qualification evidence inspected"),
    github: unknown("GitHub unavailable"), atnAcceptance: unknown("No accepted upload evidence inspected"), atn: unknown("Public ATN unavailable"), publicVerification: unknown("No matching successful public verification observed") };
  const release = await query(`repos/${repository}/releases/tags/${tag}`);
  if (release.state === "observed") result.github = { state: "observed", url: release.data.html_url, draft: release.data.draft };
  else result.github = { state: release.state, ...(release.state === "unknown" ? { reason: "GitHub release could not be inspected" } : {}) };
  // Inspect the original tag build even if publication or a later promotion failed.
  const builds = await query(`repos/${repository}/actions/workflows/release.yml/runs?branch=${encodeURIComponent(tag)}&per_page=10`);
  const build = builds.data?.workflow_runs?.find((run) => run.head_branch === tag);
  if (build) {
    const jobs = await query(`repos/${repository}/actions/runs/${build.id}/attempts/${build.run_attempt}/jobs?per_page=100`);
    if (jobs.state === "observed") {
      result.built = { ...jobStage(jobs.data.jobs, ["Validate and build once"]), run: build.html_url, attempt: build.run_attempt };
      result.qualified = { ...jobStage(jobs.data.jobs, ["Qualify prebuilt Thunderbird extension", "Native Thunderbird qualification (Windows)", "Reproduce XPI from reviewer source"]), run: build.html_url, attempt: build.run_attempt };
      if (jobs.data.jobs.some((job) => job.steps?.some((step) => step.name === "Submit exact XPI to ATN signing" && step.conclusion === "success"))) {
        result.atnAcceptance = { state: "observed", run: build.html_url, attempt: build.run_attempt };
      }
    }
  }
  try {
    const response = await fetchImpl(`https://addons.thunderbird.net/api/v4/addons/addon/thunderclaw%40addons.thunderbird.net/versions/?fresh=${Date.now()}`, {
      cache: "no-store", headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const payload = await response.json();
      if (Array.isArray(payload.results)) {
        const record = payload.results.find((candidate) => candidate?.version === version);
        if (record) {
          const file = record.files?.find((candidate) => candidate.status === "public");
          const notes = typeof record.release_notes === "string" ? record.release_notes : record.release_notes?.["en-US"] ?? record.release_notes?.en_US ?? record.release_notes?.en;
          let notesStatus = typeof notes === "string" && notes.trim() ? "uncompared" : "missing";
          if (notesStatus !== "missing" && typeof release.data?.body === "string") {
            notesStatus = normalizeMarketplaceNotes(notes) === normalizeMarketplaceNotes(release.data.body) ? "verified" : "mismatch";
          }
          result.atn = { state: file ? "observed" : "pending", version, publicFile: Boolean(file), releaseNotes: notesStatus };
        } else result.atn = payload.next ? unknown("Version absent from the inspected ATN page; history is paginated") : { state: "absent" };
      }
    }
  } catch { /* Availability is unknown, never public absence. */ }
  // A recent successful verification must retain an artifact naming this exact version and all three public gates.
  // A successful upload or a failed run without retained evidence cannot establish completion.
  const publications = await query(`repos/${repository}/actions/workflows/publish-thunderbird-addons.yml/runs?per_page=10`);
  for (const run of publications.data?.workflow_runs ?? []) {
    const artifacts = await query(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`);
    if (!artifacts.data?.artifacts?.some((artifact) => artifact.name === `thunderclaw-atn-submission-${version}` && !artifact.expired)) continue;
    const jobs = await query(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (jobs.data?.jobs?.some((job) => job.steps?.some((step) => step.name === "Submit exact XPI to ATN signing" && step.conclusion === "success"))) {
      result.atnAcceptance = { state: "observed", run: run.html_url, attempt: run.run_attempt };
    }
    const gates = ["Verify and download public ATN XPI and report release notes", "Verify public XPI is identical or adds only signature metadata", "Smoke-test the exact public ATN-signed XPI"];
    if (run.conclusion === "success" && jobs.data?.jobs?.some((job) => gates.every((gate) => job.steps?.some((step) => step.name === gate && step.conclusion === "success")))) {
      result.publicVerification = { state: "observed", run: run.html_url, attempt: run.run_attempt };
      break;
    }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--help") {
      process.stdout.write("Usage: npm run release:status -- thunderbird-extension-vX.Y.Z\nReports observed build, qualification, GitHub, accepted upload, public ATN, and public verification evidence. Unavailable evidence stays unknown; no state is changed.\n");
    } else {
    if (process.argv.length !== 3) throw new Error("Usage: npm run release:status -- thunderbird-extension-vX.Y.Z");
    process.stdout.write(`${JSON.stringify(await releaseStatus({ tag: process.argv[2] }), null, 2)}\n`);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
