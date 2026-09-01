import assert from "node:assert/strict";
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
});
