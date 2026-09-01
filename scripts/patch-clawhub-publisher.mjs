import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const invalidHeaderPattern = /%\{header:([^}]+)\}/gu;
const retryPattern = "curl failed|fetch failed|network|socket|ECONN|EAI_AGAIN|ENET|ETIMEDOUT|request timed out";
const patchedRetryPattern = "curl failed|fetch failed|network|socket|ECONN|EAI_AGAIN|ENET|ETIMEDOUT|request timed out|connection timed out";

export function patchClawHubPublisherSource(source) {
  if (typeof source !== "string") throw new Error("ClawHub HTTP source must be a string");
  const invalidHeaders = [...source.matchAll(invalidHeaderPattern)];
  if (invalidHeaders.length !== 7) {
    throw new Error(`Expected seven invalid ClawHub curl header expansions, found ${invalidHeaders.length}`);
  }
  const retryOccurrences = source.split(retryPattern).length - 1;
  if (retryOccurrences !== 1 || source.includes(patchedRetryPattern)) {
    throw new Error("Expected one unpatched ClawHub transient-error classifier");
  }

  const patched = source
    .replace(invalidHeaderPattern, "%header{$1}")
    .replace(retryPattern, patchedRetryPattern);
  if (patched.match(invalidHeaderPattern) || !patched.includes(patchedRetryPattern)) {
    throw new Error("ClawHub publisher transport patch did not apply completely");
  }
  return patched;
}

export async function patchClawHubPublisher(file) {
  const source = await readFile(file, "utf8");
  const patched = patchClawHubPublisherSource(source);
  await writeFile(file, patched, "utf8");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    process.stderr.write("Usage: patch-clawhub-publisher.mjs <clawhub-http.ts>\n");
    process.exitCode = 1;
  } else {
    try {
      await patchClawHubPublisher(file);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
