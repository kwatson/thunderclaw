import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractChangelogSection,
  parseReleaseTag,
  prepareRelease,
  validateManifestVersions,
  versionFromTag,
} from "../scripts/release-metadata.mjs";

test("release tags strictly identify one component and stable semantic version", () => {
  assert.deepEqual(parseReleaseTag("openclaw-plugin-v0.1.2"), {
    component: "openclaw-plugin", version: "0.1.2", tag: "openclaw-plugin-v0.1.2",
  });
  assert.equal(versionFromTag("thunderbird-extension-v1.2.3"), "1.2.3");
  for (const tag of ["v0.1.0", "plugin-v1.2.3", "openclaw-plugin-v01.1.0", "thunderbird-extension-v1.2", "openclaw-plugin-v1.2.3-rc.1", "refs/tags/openclaw-plugin-v1.2.3", "openclaw-plugin-v1.2.3\n"]) {
    assert.throws(() => parseReleaseTag(tag), /canonical form/u);
  }
});

test("changelog extraction returns only one exact non-empty section", () => {
  const changelog = "# Changelog\r\n\r\n## [1.2.3] - 2026-08-12\r\n\r\n### Added\r\n\r\n- First\r\n\r\n## [1.2.2]\r\n\r\n- Older\r\n";
  assert.equal(extractChangelogSection(changelog, "1.2.3"), "### Added\n\n- First\n");
  assert.throws(() => extractChangelogSection("# Changelog\n", "1.0.0"), /exactly one/u);
  assert.throws(() => extractChangelogSection("## [1.0.0]\nOne\n## [1.0.0]\nTwo\n", "1.0.0"), /exactly one/u);
  assert.throws(() => extractChangelogSection("## [1.0.0] release\nText\n", "1.0.0"), /malformed/u);
  assert.throws(() => extractChangelogSection("## [1.0.0] - 2026-02-30\nText\n", "1.0.0"), /invalid date/u);
  assert.throws(() => extractChangelogSection("## [1.0.0]\n\n## [0.9.0]\nOld\n", "1.0.0"), /empty/u);
});

test("manifest validation reports every mismatch", () => {
  assert.doesNotThrow(() => validateManifestVersions("1.2.3", { a: "1.2.3", b: "1.2.3" }));
  assert.throws(() => validateManifestVersions("1.2.3", { plugin: "1.2.2", lock: undefined }), /plugin="1\.2\.2", lock=undefined/u);
});

test("prepareRelease validates only the tagged component and writes canonical notes without overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thunderclaw-release-test-"));
  try {
    for (const relative of ["packages/openclaw-plugin", "packages/thunderbird-extension/src"]) {
      await mkdir(path.join(root, relative), { recursive: true });
    }
    await writeFile(path.join(root, "package.json"), '{"name":"thunderclaw","private":true}\n');
    await writeFile(path.join(root, "packages/openclaw-plugin/package.json"), '{"version":"1.2.3"}\n');
    await writeFile(path.join(root, "packages/thunderbird-extension/package.json"), '{"version":"9.8.7"}\n');
    await writeFile(path.join(root, "packages/thunderbird-extension/src/manifest.json"), '{"version":"9.8.7"}\n');
    await writeFile(path.join(root, "packages/openclaw-plugin/CHANGELOG.md"), "# Plugin\n\n## [1.2.3]\n\nPlugin notes.\n");
    const realBaselines = await readFile(new URL("../release-baselines.json", import.meta.url), "utf8");
    await writeFile(path.join(root, "release-baselines.json"), realBaselines);
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: {
      "": { name: "thunderclaw" },
      "packages/openclaw-plugin": { version: "1.2.3" },
      "packages/thunderbird-extension": { version: "9.8.7" },
    } }));
    const notesOutput = path.join(root, "release-notes.md");
    const result = await prepareRelease({ root, tag: "openclaw-plugin-v1.2.3", notesOutput });
    assert.equal(result.component, "openclaw-plugin");
    assert.equal(await readFile(notesOutput, "utf8"), "Plugin notes.\n");
    await assert.rejects(() => prepareRelease({ root, tag: "openclaw-plugin-v1.2.3", notesOutput }), /EEXIST/u);
    await assert.rejects(
      () => prepareRelease({ root, tag: "openclaw-plugin-v1.2.3", notesOutput: path.join(root, "notes.md") }),
      /canonical filename/u,
    );
    await writeFile(path.join(root, "release-baselines.json"), '{}\n');
    await assert.rejects(
      () => prepareRelease({ root, tag: "openclaw-plugin-v1.2.3", notesOutput: path.join(root, "other", "release-notes.md") }),
      /invalid root schema/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
