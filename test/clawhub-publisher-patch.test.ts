import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import test from "node:test";
import { patchClawHubPublisherSource } from "../scripts/patch-clawhub-publisher.mjs";

const pinnedClawHubExcerpt = `
const CURL_WRITE_OUT_FORMAT = [
  "%{header:x-ratelimit-limit}",
  "%{header:x-ratelimit-remaining}",
  "%{header:x-ratelimit-reset}",
  "%{header:ratelimit-limit}",
  "%{header:ratelimit-remaining}",
  "%{header:ratelimit-reset}",
  "%{header:retry-after}",
];
return /(?:curl failed|fetch failed|network|socket|ECONN|EAI_AGAIN|ENET|ETIMEDOUT|request timed out)/i.test(error.message);
formArgs.push("-F", \`\${key}=@\${filePath};filename=\${filename}\`);
formArgs.push("-F", \`\${key}=\${value}\`);
`;

test("patches the pinned ClawHub client for the observed curl timeout and header syntax", () => {
  const patched = patchClawHubPublisherSource(pinnedClawHubExcerpt);

  assert.doesNotMatch(patched, /%\{header:/u);
  assert.match(patched, /%header\{x-ratelimit-limit\}/u);
  assert.match(patched, /%header\{retry-after\}/u);
  const classifierSource = /return \/\(\?:([^/]+)\)\/i\.test/u.exec(patched)?.[1];
  assert.ok(classifierSource);
  const classifier = new RegExp(`(?:${classifierSource})`, "i");
  assert.equal(classifier.test("curl: (28) Connection timed out after 15002 milliseconds"), true);
});

test("refuses to patch an unexpected ClawHub source revision", () => {
  assert.throws(
    () => patchClawHubPublisherSource(pinnedClawHubExcerpt.replace("%{header:retry-after}", "%header{retry-after}")),
    /Expected seven invalid ClawHub curl header expansions/u,
  );
  assert.throws(() => patchClawHubPublisherSource(pinnedClawHubExcerpt.replace('formArgs.push("-F", `${key}=${value}`);', 'formArgs.push("--form-string", `${key}=${value}`);')),
    /Expected one unpatched ClawHub literal form-field upload/u);
});

test("patched ClawHub upload preserves literal metadata through the real curl multipart boundary", async (context) => {
  const patched = patchClawHubPublisherSource(pinnedClawHubExcerpt);
  const literalFlag = /formArgs\.push\("([^"]+)", `\$\{key\}=\$\{value\}`\);/u.exec(patched)?.[1];
  assert.ok(literalFlag);
  assert.match(patched, /formArgs\.push\("-F", `\$\{key\}=@\$\{filePath\};filename=\$\{filename\}`\);/u,
    "binary archive uploads must retain their file semantics");
  const metadata = JSON.stringify({ changelog: 'First line; second line\nA "quoted" note with @file and <input.' });
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const runCurl = promisify(execFile);
  await runCurl("curl", ["--silent", "--show-error", "--max-time", "5", "-F", `metadata=${metadata}`, url]);
  assert.equal(bodies[0].includes(metadata), false, "the upstream upload truncates JSON at the semicolon");
  await runCurl("curl", ["--silent", "--show-error", "--max-time", "5", literalFlag, `metadata=${metadata}`, url]);
  assert.equal(bodies[1].includes(metadata), true, "the audited patch must preserve the exact changelog JSON");
});
