import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { updateCounterpartManifest } from "../scripts/update-counterpart-baseline.mjs";
import { validateCounterpartBaselines, verifyCounterpartBaseline } from "../scripts/verify-counterpart-baseline.mjs";

test("counterpart baseline manifest pins each independently published component", async () => {
  const manifest = JSON.parse(await readFile(new URL("../e2e/qualification/counterpart-baselines.json", import.meta.url), "utf8"));
  const validated = validateCounterpartBaselines(manifest);
  for (const component of ["openclaw-plugin", "thunderbird-extension"] as const) {
    assert.match(validated[component].sha256, /^[a-f0-9]{64}$/u);
    assert.ok(validated[component].size > 0);
  }
});

test("counterpart updater derives exact baseline metadata only from an advancing verified release", async () => {
  const manifest = JSON.parse(await readFile(new URL("../e2e/qualification/counterpart-baselines.json", import.meta.url), "utf8"));
  const updated = updateCounterpartManifest(manifest, {
    component: "openclaw-plugin",
    tag: "openclaw-plugin-v0.1.10",
    version: "0.1.10",
    artifacts: [{ name: "thunderclaw-openclaw-plugin-0.1.10.tgz", sha256: "a".repeat(64), size: 12345 }],
  });
  assert.deepEqual(updated["openclaw-plugin"], {
    tag: "openclaw-plugin-v0.1.10",
    name: "thunderclaw-openclaw-plugin-0.1.10.tgz",
    sha256: "a".repeat(64),
    size: 12345,
  });
  assert.deepEqual(updated["thunderbird-extension"], manifest["thunderbird-extension"]);
  assert.throws(() => updateCounterpartManifest(manifest, {
    component: "openclaw-plugin",
    tag: "openclaw-plugin-v0.1.8",
    version: "0.1.8",
    artifacts: [{ name: "thunderclaw-openclaw-plugin-0.1.8.tgz", sha256: "b".repeat(64), size: 1 }],
  }), /must advance openclaw-plugin/u);

  const alreadyComplete = updateCounterpartManifest(updated, {
    component: "openclaw-plugin",
    tag: "openclaw-plugin-v0.1.10",
    version: "0.1.10",
    artifacts: [{ name: "thunderclaw-openclaw-plugin-0.1.10.tgz", sha256: "a".repeat(64), size: 12345 }],
  });
  assert.deepEqual(alreadyComplete, updated);
  assert.throws(() => updateCounterpartManifest(updated, {
    component: "openclaw-plugin",
    tag: "openclaw-plugin-v0.1.10",
    version: "0.1.10",
    artifacts: [{ name: "thunderclaw-openclaw-plugin-0.1.10.tgz", sha256: "b".repeat(64), size: 12345 }],
  }), /already has a different release identity/u);
});

test("counterpart verifier rejects bytes that do not match the permanent pin", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-counterpart-test-"));
  const artifact = path.join(directory, "thunderclaw-thunderbird-0.1.2.xpi");
  await writeFile(artifact, "not the published XPI");
  await assert.rejects(
    verifyCounterpartBaseline({ forComponent: "openclaw-plugin", artifact }),
    /does not match the pinned thunderbird-extension-v0.1.2 thunderbird-extension bytes/u,
  );
  await assert.rejects(
    verifyCounterpartBaseline({ forComponent: "other" as "openclaw-plugin", artifact }),
    /Unknown release component/u,
  );
});
