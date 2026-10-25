import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAtnJwt, submitToThunderbirdAddons, versionEndpoint } from "../scripts/submit-thunderbird-addon.mjs";
import { verifyAtnRelease } from "../scripts/verify-atn-release.mjs";
import { verifyAtnXpiPayload } from "../scripts/verify-atn-xpi-payload.mjs";
import { normalizeMarketplaceNotes, verifyMarketplaceNotes } from "../scripts/verify-marketplace-notes.mjs";
import { expectedArtifactNames, parseChecksums, verifyMarketplaceRelease } from "../scripts/verify-marketplace-release.mjs";

async function createZipFixture(root: string, name: string, entries: Record<string, string>) {
  const staging = path.join(root, `${name}-files`);
  await mkdir(staging);
  for (const [entry, contents] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(staging, entry)), { recursive: true });
    await writeFile(path.join(staging, entry), contents);
  }
  const archive = path.join(root, `${name}.xpi`);
  execFileSync("zip", ["-X", "-q", archive, ...Object.keys(entries).sort()], { cwd: staging });
  return archive;
}

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
    assert.notEqual(request.method, "PATCH");
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
  assert.equal(result.publicationStatus, "awaiting-public-verification");
  assert.equal(result.reviewerActions, "inspect-platform-requirements");
  assert.equal("manualHandoffRequired" in result, false);
  assert.equal(polls, 1);
});

test("marketplace verification binds exact bytes to release provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-marketplace-test-"));
  const tag = "thunderbird-extension-v1.2.3";
  const commit = "a".repeat(40);
  const artifacts = [];
  const checksumLines = [];
  for (const name of expectedArtifactNames("thunderbird-extension", "1.2.3")) {
    const bytes = Buffer.from(`fixture:${name}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path.join(directory, name), bytes);
    artifacts.push({ name, sha256, size: bytes.length });
    checksumLines.push(`${sha256}  ${name}`);
  }
  await writeFile(path.join(directory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
  await writeFile(path.join(directory, "release-notes.md"), "Canonical extension notes.\n");
  await writeFile(path.join(directory, "release-provenance.json"), `${JSON.stringify({
    format: "thunderclaw-release-provenance-v2",
    component: "thunderbird-extension",
    source: { repository: "https://github.com/owner/repo", commit, tag },
    build: { workflow: "owner/repo/.github/workflows/release.yml@refs/tags/thunderbird-extension-v1.2.3", run: "https://github.com/owner/repo/actions/runs/1", attempt: 1 },
    artifacts,
  })}\n`);

  assert.equal(parseChecksums(`${checksumLines[0]}\n`).size, 1);
  const result = await verifyMarketplaceRelease({ directory, component: "thunderbird-extension", tag, repository: "owner/repo", commit });
  assert.equal(result.version, "1.2.3");
  await writeFile(path.join(directory, artifacts[0].name), "tampered");
  await assert.rejects(
    verifyMarketplaceRelease({ directory, component: "thunderbird-extension", tag, repository: "owner/repo", commit }),
    /Checksum mismatch/u,
  );
});

test("marketplace notes compare exactly after transport normalization", async () => {
  assert.equal(normalizeMarketplaceNotes("Cafe\u0301\r\n\r\n"), "Café");
  assert.equal(verifyMarketplaceNotes("One\nTwo\n", "One\r\nTwo", "fixture"), "One\nTwo");
  assert.throws(() => verifyMarketplaceNotes("One two", "One  two", "fixture"), /exactly match/u);
  assert.throws(() => verifyMarketplaceNotes("One", "One ", "fixture"), /exactly match/u);


});

test("ATN public verification binds canonical notes and downloads API-advertised signed XPI bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-atn-verify-"));
  const notesFile = path.join(directory, "notes.md");
  const xpi = path.join(directory, "extension.xpi");
  const signedXpi = path.join(directory, "signed-extension.xpi");
  await writeFile(notesFile, "Canonical extension notes.\n");
  await writeFile(xpi, "qualified-xpi");
  const qualifiedBytes = await readFile(xpi);
  const signedBytes = Buffer.from("atn-signed-xpi");
  const result = await verifyAtnRelease({
    version: "1.2.3", notesFile, xpi, downloadOutput: signedXpi,
    fetchImpl: async (url) => String(url).includes("/downloads/file/")
      ? new Response(signedBytes, { status: 200 })
      : new Response(JSON.stringify({ results: [{
        version: "1.2.3", release_notes: { "en-US": "Canonical extension notes." },
        files: [{ status: "public", hash: `sha256:${createHash("sha256").update(signedBytes).digest("hex")}`,
          size: signedBytes.byteLength, url: "https://addons.thunderbird.net/thunderbird/downloads/file/1/extension.xpi" }],
      }] }), { status: 200 }),
  });
  assert.deepEqual(await readFile(signedXpi), signedBytes);
  assert.deepEqual(result, {
    version: "1.2.3",
    releaseNotesVerified: true,
    releaseNotesStatus: "verified",
    signedXpiVerified: true,
    qualifiedXpiSha256: createHash("sha256").update(qualifiedBytes).digest("hex"),
    signedXpiSha256: createHash("sha256").update(signedBytes).digest("hex"),
    signedXpiSize: signedBytes.byteLength,
    reviewerSourceVerification: "unknown",
    reviewerTestingNotesVerification: "unknown",
  });
});

test("ATN public XPI payload accepts identical bytes or complete signature metadata only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-atn-payload-"));
  const payload = { "manifest.json": "{\"version\":\"1.2.3\"}", "background.js": "safe();" };
  const qualified = await createZipFixture(directory, "qualified", payload);
  const identical = path.join(directory, "identical.xpi");
  await writeFile(identical, await readFile(qualified));
  assert.equal((await verifyAtnXpiPayload({ qualifiedXpi: qualified, publicXpi: identical })).mode, "byte-identical");

  const signed = await createZipFixture(directory, "signed", {
    ...payload,
    "META-INF/cose.manifest": "signed manifest",
    "META-INF/cose.sig": "signature",
  });
  const signedResult = await verifyAtnXpiPayload({ qualifiedXpi: qualified, publicXpi: signed });
  assert.equal(signedResult.mode, "signature-metadata-added");
  assert.deepEqual(signedResult.signatureEntries, ["META-INF/cose.manifest", "META-INF/cose.sig"]);

  const changed = await createZipFixture(directory, "changed", { ...payload, "background.js": "tampered();" });
  await assert.rejects(
    verifyAtnXpiPayload({ qualifiedXpi: qualified, publicXpi: changed }),
    /changed qualified payload bytes/u,
  );
  const incomplete = await createZipFixture(directory, "incomplete", { ...payload, "META-INF/cose.sig": "signature" });
  await assert.rejects(
    verifyAtnXpiPayload({ qualifiedXpi: qualified, publicXpi: incomplete }),
    /incomplete Mozilla signature metadata group/u,
  );
});

test("ATN automatic activation is reported without inventing reviewer requirements", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-atn-auto-"));
  try {
    const xpi = path.join(directory, "extension.xpi"); await writeFile(xpi, "fixture");
    const options = { xpi, version: "1.2.3", issuer: "synthetic", secret: "synthetic", timeoutMs: 0 };
    const result = await submitToThunderbirdAddons({ ...options, fetchImpl: async () => Response.json({ processed: true, valid: true, reviewed: true, active: true }) });
    assert.equal(result.publicationStatus, "reported-active");
    assert.equal(result.reviewerActions, "inspect-platform-requirements");
    assert.equal("manualHandoffRequired" in result, false);
    await assert.rejects(submitToThunderbirdAddons({ ...options, fetchImpl: async () => Response.json({ processed: true, valid: false }) }), /ATN rejected/u);
    await assert.rejects(submitToThunderbirdAddons({ ...options, fetchImpl: async () => Response.json({ detail: "synthetic rejection" }, { status: 422 }) }), /submission failed/u);
    await assert.rejects(submitToThunderbirdAddons({ ...options, fetchImpl: async () => Response.json({ processed: false }) }), /Timed out/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ATN checks public bytes even when notes are absent or different and bypasses stale API caches", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-atn-notes-"));
  try {
    const notesFile = path.join(directory, "notes.md"); const xpi = path.join(directory, "qualified.xpi");
    const bytes = Buffer.from("qualified-public-fixture");
    await writeFile(notesFile, "Canonical notes.\n"); await writeFile(xpi, bytes);
    for (const [notes, expected] of [[undefined, "missing"], ["Different notes.", "mismatch"]] as const) {
      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (url, options) => {
        calls.push(String(url));
        if (String(url).includes("/downloads/file/")) return new Response(bytes);
        assert.equal(options?.cache, "no-store");
        assert.match(String(url), /\/versions\/\?fresh=\d+$/u);
        return Response.json({ results: [{ version: "1.2.3", release_notes: notes, files: [{ status: "public", hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length, url: "https://addons.thunderbird.net/thunderbird/downloads/file/1/fixture.xpi" }] }] });
      };
      const result = await verifyAtnRelease({ version: "1.2.3", notesFile, xpi, fetchImpl });
      assert.equal(result.releaseNotesStatus, expected);
      assert.equal(result.releaseNotesVerified, false); assert.equal(result.signedXpiVerified, true);
      assert.equal(result.qualifiedXpiSha256, result.signedXpiSha256);
      assert.equal(calls.length, 2, "one metadata request and one artifact download, without polling");
    }
    await assert.rejects(verifyAtnRelease({ version: "1.2.3", notesFile, xpi, fetchImpl: async () => Response.json({ results: [{ version: "1.2.3", files: [] }] }) }), /public XPI metadata is invalid/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
