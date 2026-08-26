import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

function workflowRunBlocks(workflow: string): Array<{ line: number; script: string }> {
  const lines = workflow.split("\n");
  const blocks: Array<{ line: number; script: string }> = [];

  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)run: \|\s*$/u.exec(line);
    if (!match) continue;

    const keyIndent = match[1].length;
    const scriptIndent = keyIndent + 2;
    const body: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex];
      const indentation = /^(\s*)/u.exec(bodyLine)?.[1].length ?? 0;
      if (bodyLine.trim() !== "" && indentation <= keyIndent) break;
      body.push(bodyLine.slice(Math.min(bodyLine.length, scriptIndent)));
    }
    blocks.push({ line: index + 1, script: body.join("\n") });
  }

  return blocks;
}

test("tag release builds once, qualifies exact bytes, and gates publication", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(workflow, /tags:\n\s+- "v\*"/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /node scripts\/release-metadata\.mjs/u);
  assert.match(workflow, /git fetch --no-tags origin '\+refs\/heads\/main:refs\/remotes\/origin\/main'/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/u);
  assert.equal((workflow.match(/npm run pack:release/gu) ?? []).length, 1);
  assert.match(workflow, /THUNDERCLAW_OPENCLAW_PLUGIN_TGZ:/u);
  assert.match(workflow, /THUNDERCLAW_E2E_XPI:/u);
  assert.match(workflow, /environment:\n\s+name: release/u);
  assert.match(workflow, /native-qualification:/u);
  assert.match(workflow, /source-qualification:/u);
  assert.match(workflow, /windows-2025/u);
  assert.match(workflow, /macos-15/u);
  assert.match(workflow, /--xpi "release\/thunderclaw-thunderbird-/u);
  assert.match(workflow, /gitleaks_8\.30\.1_linux_x64\.tar\.gz/u);
  assert.match(workflow, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/u);
  assert.match(workflow, /diff --recursive --brief "\$candidate_root" "\$rebuilt_root"/u);
  assert.match(workflow, /needs:\n\s+- build\n\s+- openclaw-qualification\n\s+- thunderbird-qualification\n\s+- native-qualification\n\s+- source-qualification/u);
  assert.match(workflow, /attestations: write/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /gh release create/u);
  assert.match(
    workflow,
    /release:\n[\s\S]*?steps:\n\s+- name: Check out tagged source\n\s+uses: actions\/checkout@[a-f0-9]{40}[\s\S]*?persist-credentials: false[\s\S]*?gh release create/u,
  );
  assert.match(workflow, /uses: \.\/\.github\/workflows\/marketplace-publish\.yml/u);
  assert.doesNotMatch(workflow, /npm publish|addons\.mozilla\.org/u);

  for (const reference of workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/gu)) {
    assert.match(reference[1], /^[a-f0-9]{40}$/u, `action is not pinned to a full commit: ${reference[0]}`);
  }
});

test("marketplace workflow promotes GitHub release bytes without rebuilding", async () => {
  const workflow = await readFile(new URL("../.github/workflows/marketplace-publish.yml", import.meta.url), "utf8");

  assert.match(workflow, /workflow_call:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /gh release download "\$RELEASE_TAG"/u);
  assert.match(workflow, /node scripts\/verify-marketplace-release\.mjs/u);
  assert.match(workflow, /environment:\n\s+name: clawhub/u);
  assert.match(workflow, /environment:\n\s+name: thunderbird-addons/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /ref: 87ca030c30f3cfb78ab15c8e66b5ff1469c8f9c8 # v0\.23\.3/u);
  assert.match(workflow, /package publish "\$PLUGIN_ARCHIVE"/u);
  assert.match(
    workflow,
    /if \[\[ -n "\$CLAWHUB_TOKEN" \]\]; then[\s\S]*?publish_auth_args=\([\s\S]*?--owner thunderclaw[\s\S]*?--manual-override-reason/u,
  );
  assert.match(workflow, /CLAWHUB_TOKEN is required to promote a historical release/u);
  assert.match(workflow, /"\$GITHUB_SHA" != "\$RELEASE_COMMIT"/u);
  assert.match(workflow, /"\$GITHUB_REF" != "refs\/tags\/\$RELEASE_TAG"/u);
  assert.doesNotMatch(workflow, /--family code-plugin \\\n\s+--owner thunderclaw/u);
  assert.match(workflow, /"\$\{publish_auth_args\[@\]\}"/u);
  assert.match(workflow, /node scripts\/submit-thunderbird-addon\.mjs/u);
  assert.match(workflow, /ATN does not expose a supported API for reviewer-source/u);
  assert.doesNotMatch(workflow, /npm run pack:release|npm publish|addons\.mozilla\.org/u);

  for (const reference of workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/gu)) {
    assert.match(reference[1], /^[a-f0-9]{40}$/u, `action is not pinned to a full commit: ${reference[0]}`);
  }
  for (const block of workflowRunBlocks(workflow)) {
    const result = spawnSync("bash", ["-n"], { input: block.script, encoding: "utf8" });
    assert.equal(result.status, 0, `invalid shell syntax in run block at workflow line ${block.line}:\n${result.stderr}`);
  }
});

test("release workflow multiline run blocks have valid Bash syntax", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  for (const block of workflowRunBlocks(workflow)) {
    const result = spawnSync("bash", ["-n"], { input: block.script, encoding: "utf8" });
    assert.equal(result.status, 0, `invalid shell syntax in run block at workflow line ${block.line}:\n${result.stderr}`);
  }
});
