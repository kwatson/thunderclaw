import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractChangelogSection,
  prepareRelease,
  validateManifestVersions,
  versionFromTag,
} from "../scripts/release-metadata.mjs";

test("release tags must be canonical stable semantic versions", () => {
  assert.equal(versionFromTag("v0.1.0"), "0.1.0");
  for (const tag of ["0.1.0", "v01.1.0", "v1.2", "v1.2.3-rc.1", "refs/tags/v1.2.3", "v1.2.3\n"]) {
    assert.throws(() => versionFromTag(tag), /canonical form/u);
  }
});

test("changelog extraction returns only the requested non-empty section", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [1.2.3] - 2026-08-12",
    "",
    "### Added",
    "",
    "- First line",
    "- Second line",
    "",
    "## [1.2.2] - 2026-08-01",
    "",
    "- Older",
  ].join("\r\n");
  assert.equal(extractChangelogSection(changelog, "1.2.3"), "### Added\n\n- First line\n- Second line\n");
});

test("changelog extraction rejects absent, duplicate, malformed, and empty sections", () => {
  assert.throws(() => extractChangelogSection("# Changelog\n", "1.0.0"), /exactly one/u);
  assert.throws(
    () => extractChangelogSection("## [1.0.0]\nOne\n## [1.0.0] - 2026-08-12\nTwo\n", "1.0.0"),
    /exactly one/u,
  );
  assert.throws(() => extractChangelogSection("## 1.0.0\nText\n", "1.0.0"), /exactly one/u);
  assert.throws(() => extractChangelogSection("## [1.0.0] release\nText\n", "1.0.0"), /malformed/u);
  assert.throws(() => extractChangelogSection("## [1.0.0] - 2026-02-30\nText\n", "1.0.0"), /invalid date/u);
  assert.throws(() => extractChangelogSection("## [1.0.0]\n\n## [0.9.0]\nOld\n", "1.0.0"), /empty/u);
});

test("manifest validation reports every mismatch", () => {
  assert.doesNotThrow(() => validateManifestVersions("1.2.3", { a: "1.2.3", b: "1.2.3" }));
  assert.throws(
    () => validateManifestVersions("1.2.3", { root: "1.2.2", plugin: undefined, extension: "1.2.3" }),
    /root="1\.2\.2", plugin=undefined/u,
  );
});

test("prepareRelease validates all four manifests and writes notes without overwrite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thunderclaw-release-test-"));
  try {
    const files = [
      "package.json",
      "packages/openclaw-plugin/package.json",
      "packages/thunderbird-extension/package.json",
      "packages/thunderbird-extension/src/manifest.json",
    ];
    for (const relative of files) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), '{"version":"1.2.3"}\n');
    }
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      version: "1.2.3",
      packages: {
        "": { version: "1.2.3" },
        "packages/openclaw-plugin": { version: "1.2.3" },
        "packages/thunderbird-extension": { version: "1.2.3" },
      },
    }));
    await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.2.3]\n\nRelease notes.\n");
    const notesOutput = path.join(root, "notes.md");
    const result = await prepareRelease({ root, tag: "v1.2.3", notesOutput });
    assert.equal(result.version, "1.2.3");
    assert.equal(await readFile(notesOutput, "utf8"), "Release notes.\n");
    await assert.rejects(() => prepareRelease({ root, tag: "v1.2.3", notesOutput }), /EEXIST/u);

    await writeFile(path.join(root, files[1]), '{"version":"1.2.4"}\n');
    await assert.rejects(
      () => prepareRelease({ root, tag: "v1.2.3", notesOutput: path.join(root, "other.md") }),
      /openclaw-plugin\/package\.json="1\.2\.4"/u,
    );

    await writeFile(path.join(root, files[1]), '{"version":"1.2.3"}\n');
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      version: "1.2.3",
      packages: { "": { version: "1.2.3" } },
    }));
    await assert.rejects(
      () => prepareRelease({ root, tag: "v1.2.3", notesOutput: path.join(root, "lock-notes.md") }),
      /plugin workspace=undefined, package-lock\.json extension workspace=undefined/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
