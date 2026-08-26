import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAtnJwt, submitToThunderbirdAddons, versionEndpoint } from "../scripts/submit-thunderbird-addon.mjs";
import { expectedArtifactNames, parseChecksums, verifyMarketplaceRelease } from "../scripts/verify-marketplace-release.mjs";

test("ATN submission uses short-lived HS256 JWTs and the Thunderbird API", () => {
  const token = createAtnJwt({ issuer: "user:1", secret: "test-secret", now: 100, nonce: "unique" });
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    iss: "user:1", jti: "unique", iat: 100, exp: 160,
  });
  assert.equal(signature, createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url"));
  assert.equal(
    versionEndpoint("https://addons.thunderbird.net/api/v4/", "1.2.3"),
    "https://addons.thunderbird.net/api/v4/addons/thunderclaw%40addons.thunderbird.net/versions/1.2.3/",
  );
  assert.throws(() => versionEndpoint("https://example.test", "1.2.3-beta.1"), /canonical form/u);
});

test("ATN submission uploads listed exact bytes and waits for validation", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-atn-test-"));
  const xpi = path.join(directory, "thunderclaw.xpi");
  await writeFile(xpi, "exact-xpi-fixture");
  let polls = 0;
  const server = createServer((request, response) => {
    assert.match(request.headers.authorization ?? "", /^JWT [^.]+\.[^.]+\.[^.]+$/u);
    if (request.method === "PUT") {
      let body = "";
      request.setEncoding("latin1");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        assert.match(body, /name="channel"[\s\S]*listed/u);
        assert.match(body, /filename="thunderclaw\.xpi"[\s\S]*exact-xpi-fixture/u);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ processed: false }));
      });
      return;
    }
    polls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ processed: true, valid: true, reviewed: false, active: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address !== "string");

  const result = await submitToThunderbirdAddons({
    xpi,
    version: "1.2.3",
    issuer: "user:1",
    secret: "test-secret",
    apiBase: `http://127.0.0.1:${address.port}`,
    pollIntervalMs: 1,
    timeoutMs: 1_000,
  });
  assert.equal(result.valid, true);
  assert.equal(polls, 1);
});

test("marketplace verification binds exact bytes to release provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-marketplace-test-"));
  const tag = "v1.2.3";
  const commit = "a".repeat(40);
  const artifacts = [];
  const checksumLines = [];
  for (const name of expectedArtifactNames("1.2.3")) {
    const bytes = Buffer.from(`fixture:${name}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(directory, name), bytes);
    artifacts.push({ name, sha256, size: bytes.length });
    checksumLines.push(`${sha256}  ${name}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
  await writeFile(path.join(directory, "release-provenance.json"), `${JSON.stringify({
    format: "thunderclaw-release-provenance-v1",
    source: { repository: "https://github.com/owner/repo", commit, tag },
    artifacts,
  })}\n`);

  assert.equal(parseChecksums(`${checksumLines[0]}\n`).size, 1);
  const result = await verifyMarketplaceRelease({ directory, tag, repository: "owner/repo", commit });
  assert.equal(result.version, "1.2.3");
  await writeFile(path.join(directory, artifacts[0].name), "tampered");
  await assert.rejects(
    verifyMarketplaceRelease({ directory, tag, repository: "owner/repo", commit }),
    /Checksum mismatch/u,
  );
});
