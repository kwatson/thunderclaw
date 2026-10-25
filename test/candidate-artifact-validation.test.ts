import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "scripts/validate-candidate-artifact.mjs");

function validate(kind: "xpi", artifact: string, expectedVersion?: string) {
  return spawnSync(process.execPath, [validator, kind, artifact, ...(expectedVersion === undefined ? [] : ["--expected-version", expectedVersion])], { cwd: root, encoding: "utf8" });
}

test("candidate artifact validator accepts current ThunderClaw archives and reports their digest", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-artifact-build-"));
  try {
    const extensionPackage = JSON.parse(await readFile(path.join(root, "packages/thunderbird-extension/package.json"), "utf8"));
    const xpi = execFileSync(process.execPath, [path.join(root, "scripts/build-extension.mjs"), "--isolated-parent", temporary], {
      cwd: root, encoding: "utf8",
    }).trim();
    const result = validate("xpi", xpi);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(report.kind, "xpi");
    assert.equal(report.component, "thunderbird-extension");
    assert.equal(report.version, extensionPackage.version);
    assert.match(String(report.sha256), /^[a-f0-9]{64}$/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("candidate artifact validator rejects wrong suffixes, versions, and identities", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-artifact-validation-"));
  try {
    const wrongSuffix = path.join(temporary, "candidate.zip");
    await writeFile(wrongSuffix, "not an xpi");
    assert.notEqual(validate("xpi", wrongSuffix).status, 0);

    const xpiSource = path.join(temporary, "xpi-source");
    execFileSync("mkdir", [xpiSource]);
    await writeFile(path.join(xpiSource, "manifest.json"), JSON.stringify({
      name: "ThunderClaw", version: "999.0.0",
      browser_specific_settings: { gecko: { id: "thunderclaw@addons.thunderbird.net" } },
    }));
    const wrongVersion = path.join(temporary, "wrong-version.xpi");
    execFileSync("zip", ["-q", wrongVersion, "manifest.json"], { cwd: xpiSource });
    assert.match(validate("xpi", wrongVersion).stderr, /version does not match/u);

    const extensionPackage = JSON.parse(await readFile(path.join(root, "packages/thunderbird-extension/package.json"), "utf8"));
    await writeFile(path.join(xpiSource, "manifest.json"), JSON.stringify({
      name: "Other extension", version: extensionPackage.version,
      browser_specific_settings: { gecko: { id: "thunderclaw@addons.thunderbird.net" } },
    }));
    const wrongIdentity = path.join(temporary, "wrong-identity.xpi");
    execFileSync("zip", ["-q", wrongIdentity, "manifest.json"], { cwd: xpiSource });
    assert.match(validate("xpi", wrongIdentity).stderr, /stable ThunderClaw identity/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("old public XPI recovery requires an explicit exact version while ordinary candidates follow the checkout", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-old-public-xpi-"));
  try {
    const oldVersion = "0.0.0";
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({
      name: "ThunderClaw", version: oldVersion,
      browser_specific_settings: { gecko: { id: "thunderclaw@addons.thunderbird.net" } },
    }));
    const xpi = path.join(temporary, "old-public.xpi");
    execFileSync("zip", ["-q", xpi, "manifest.json"], { cwd: temporary });
    assert.match(validate("xpi", xpi).stderr, /version does not match/u);
    assert.equal(validate("xpi", xpi, oldVersion).status, 0);
    assert.match(validate("xpi", xpi, "0.0.1").stderr, /version does not match/u);
    for (const version of ["", "00.0.0", "0.0", "0.0.0-beta.1", "0.0.0\n"]) {
      assert.match(validate("xpi", xpi, version).stderr, /Usage:/u);
    }
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({ name: "Other", version: oldVersion }));
    execFileSync("zip", ["-q", xpi, "manifest.json"], { cwd: temporary });
    assert.match(validate("xpi", xpi, oldVersion).stderr, /stable ThunderClaw identity/u);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
