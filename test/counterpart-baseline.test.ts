import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyCounterpartBaseline } from "../scripts/verify-counterpart-baseline.mjs";

test("counterpart baseline manifest pins each independently published component", async () => {
  const manifest = JSON.parse(await readFile(new URL("../e2e/qualification/counterpart-baselines.json", import.meta.url), "utf8"));
  assert.equal(manifest["openclaw-plugin"].tag, "openclaw-plugin-v0.1.5");
  assert.equal(manifest["thunderbird-extension"].tag, "thunderbird-extension-v0.1.2");
  assert.match(manifest["openclaw-plugin"].sha256, /^[a-f0-9]{64}$/u);
  assert.match(manifest["thunderbird-extension"].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest["openclaw-plugin"].size, 108571);
  assert.equal(manifest["thunderbird-extension"].size, 119484);
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
