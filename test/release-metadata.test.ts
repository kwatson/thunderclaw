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
  assert.deepEqual(parseReleaseTag("thunderbird-extension-v0.1.2"), {
    component: "thunderbird-extension", version: "0.1.2", tag: "thunderbird-extension-v0.1.2",
  });
  assert.equal(versionFromTag("thunderbird-extension-v1.2.3"), "1.2.3");
  for (const tag of ["v0.1.0", "plugin-v1.2.3", "thunderbird-extension-v01.1.0", "thunderbird-extension-v1.2", "thunderbird-extension-v1.2.3-rc.1", "refs/tags/thunderbird-extension-v1.2.3", "thunderbird-extension-v1.2.3\n"]) {
    assert.throws(() => parseReleaseTag(tag), /canonical form/u);
  }
});

test("changelog extraction returns only one exact non-empty section", () => {
  const changelog = "# Changelog\r\n\r\n## OpenClaw plugin [1.2.3] - 2026-08-12\r\n\r\n### Added\r\n\r\n- Plugin\r\n\r\n## Thunderbird extension [1.2.3]\r\n\r\n- Extension\r\n";
  assert.throws(() => parseReleaseTag("openclaw-plugin-v1.2.3"), /canonical form/u);
  assert.equal(extractChangelogSection(changelog, "thunderbird-extension", "1.2.3"), "- Extension\n");
  assert.throws(() => extractChangelogSection("# Changelog\n", "thunderbird-extension", "1.0.0"), /exactly one/u);
  assert.throws(() => extractChangelogSection(changelog, "unknown", "1.2.3"), /Unknown release component/u);
  assert.throws(() => extractChangelogSection("## Thunderbird extension [1.0.0]\nOne\n## Thunderbird extension [1.0.0]\nTwo\n", "thunderbird-extension", "1.0.0"), /exactly one/u);
  assert.throws(() => extractChangelogSection("## Thunderbird extension [1.0.0] release\nText\n", "thunderbird-extension", "1.0.0"), /malformed/u);
  assert.throws(() => extractChangelogSection("## Thunderbird extension [1.0.0] - 2026-02-30\nText\n", "thunderbird-extension", "1.0.0"), /invalid date/u);
  assert.throws(() => extractChangelogSection("## Thunderbird extension [1.0.0]\n\n## Thunderbird extension [0.9.0]\nOld\n", "thunderbird-extension", "1.0.0"), /empty/u);
});

test("manifest validation reports every mismatch", () => {
  assert.doesNotThrow(() => validateManifestVersions("1.2.3", { a: "1.2.3", b: "1.2.3" }));
  assert.throws(() => validateManifestVersions("1.2.3", { plugin: "1.2.2", lock: undefined }), /plugin="1\.2\.2", lock=undefined/u);
});

test("prepareRelease validates extension manifests and writes canonical notes without overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thunderclaw-release-test-"));
  try {
    await mkdir(path.join(root, "packages/thunderbird-extension/src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), '{"name":"thunderclaw","private":true}\n');
    await writeFile(path.join(root, "packages/thunderbird-extension/package.json"), '{"version":"1.2.3"}\n');
    await writeFile(path.join(root, "packages/thunderbird-extension/src/manifest.json"), '{"version":"1.2.3"}\n');
    await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Thunderbird extension [1.2.3]\n\nExtension notes.\n");
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ packages: {
      "": { name: "thunderclaw" }, "packages/thunderbird-extension": { version: "1.2.3" },
    } }));
    const notesOutput = path.join(root, "release-notes.md");
    const result = await prepareRelease({ root, tag: "thunderbird-extension-v1.2.3", notesOutput });
    assert.equal(result.component, "thunderbird-extension");
    assert.equal(await readFile(notesOutput, "utf8"), "Extension notes.\n");
    await assert.rejects(() => prepareRelease({ root, tag: "thunderbird-extension-v1.2.3", notesOutput }), /EEXIST/u);
    await assert.rejects(() => prepareRelease({ root, tag: "thunderbird-extension-v1.2.3", notesOutput: path.join(root, "notes.md") }), /canonical filename/u);
    await writeFile(path.join(root, "packages/thunderbird-extension/src/manifest.json"), '{"version":"1.2.4"}\n');
    await assert.rejects(() => prepareRelease({ root, tag: "thunderbird-extension-v1.2.3" }), /does not match component manifest versions/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
