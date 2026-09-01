import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "scripts/validate-candidate-artifact.mjs");

function validate(kind: "xpi" | "plugin-tgz", artifact: string) {
  return spawnSync(process.execPath, [validator, kind, artifact], { cwd: root, encoding: "utf8" });
}

test("candidate artifact validator accepts current ThunderClaw archives and reports their digest", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-artifact-build-"));
  try {
    const xpi = execFileSync(process.execPath, [path.join(root, "scripts/build-extension.mjs"), "--isolated-parent", temporary], {
      cwd: root, encoding: "utf8",
    }).trim();
    const plugin = execFileSync("npm", ["run", "--silent", "pack:plugin"], {
      cwd: root, encoding: "utf8",
    }).trim().split("\n").at(-1)!;
    for (const [kind, component, version, artifact] of [
      ["xpi", "thunderbird-extension", "0.1.1", xpi],
      ["plugin-tgz", "openclaw-plugin", "0.1.3", plugin],
    ] as const) {
      const result = validate(kind, artifact);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.equal(report.kind, kind);
      assert.equal(report.component, component);
      assert.equal(report.version, version);
      assert.match(String(report.sha256), /^[a-f0-9]{64}$/u);
    }
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

    const pluginSource = path.join(temporary, "plugin-source", "package");
    execFileSync("mkdir", ["-p", pluginSource]);
    await writeFile(path.join(pluginSource, "package.json"), JSON.stringify({
      name: "@someone/other-plugin", version: "0.1.3",
    }));
    await writeFile(path.join(pluginSource, "openclaw.plugin.json"), JSON.stringify({
      id: "thunderclaw", name: "ThunderClaw",
    }));
    const wrongIdentity = path.join(temporary, "wrong-identity.tgz");
    execFileSync("tar", ["-czf", wrongIdentity, "package"], { cwd: path.dirname(pluginSource) });
    assert.match(validate("plugin-tgz", wrongIdentity).stderr, /package identity/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
