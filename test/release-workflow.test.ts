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

function verifyWorkflow(workflow: string, filename: string) {
  for (const reference of workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/gu)) {
    assert.match(reference[1], /^[a-f0-9]{40}$/u, `${filename} action is not pinned: ${reference[0]}`);
  }
  for (const block of workflowRunBlocks(workflow)) {
    const result = spawnSync("bash", ["-n"], { input: block.script, encoding: "utf8" });
    assert.equal(result.status, 0, `${filename}:${block.line} has invalid shell syntax:\n${result.stderr}`);
  }
}

test("component release tags build, qualify, and publish only their own artifacts", async () => {
  const plugin = await readFile(new URL("../.github/workflows/release-openclaw-plugin.yml", import.meta.url), "utf8");
  const extension = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.match(plugin, /- "openclaw-plugin-v\*"/u);
  assert.match(extension, /- "thunderbird-extension-v\*"/u);
  for (const workflow of [plugin, extension]) {
    assert.match(workflow, /git fetch --no-tags origin '\+refs\/heads\/main:refs\/remotes\/origin\/main'/u);
    assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/u);
    assert.match(workflow, /--notes-file release\/release-notes\.md/u);
    assert.match(workflow, /component:/u);
    assert.match(workflow, /counterpart_tag=\$\(jq -r/u);
    assert.match(workflow, /verify-counterpart-baseline\.mjs/u);
    assert.match(workflow, /THUNDERCLAW_QUALIFICATION_COMPONENT:/u);
    assert.match(workflow, /THUNDERCLAW_OPENCLAW_PLUGIN_TGZ:/u);
    assert.match(workflow, /THUNDERCLAW_E2E_XPI:/u);
    assert.doesNotMatch(workflow, /npm run pack:release/u);
  }
  assert.match(plugin, /npm run pack:plugin/u);
  assert.match(plugin, /THUNDERCLAW_OPENCLAW_PLUGIN_TGZ:/u);
  assert.match(plugin, /uses: \.\/\.github\/workflows\/publish-clawhub\.yml/u);
  assert.match(plugin, /uses: \.\/\.github\/workflows\/qualify-release-pair\.yml/u);
  assert.doesNotMatch(plugin, /publish-thunderbird-addons/u);

  assert.match(extension, /npm run build:extension/u);
  assert.match(extension, /npm run pack:source/u);
  assert.match(extension, /THUNDERCLAW_E2E_XPI:/u);
  assert.match(extension, /source-qualification:/u);
  assert.match(extension, /uses: \.\/\.github\/workflows\/publish-thunderbird-addons\.yml/u);
  assert.match(extension, /uses: \.\/\.github\/workflows\/qualify-release-pair\.yml/u);
  assert.match(extension, /cmp -s "release\/thunderclaw-thunderbird-/u);
  assert.doesNotMatch(extension, /publish-clawhub/u);

  verifyWorkflow(plugin, "release-openclaw-plugin.yml");
  verifyWorkflow(extension, "release.yml");
});

test("protected pair qualification installs and exercises both exact component artifacts", async () => {
  const workflow = await readFile(new URL("../.github/workflows/qualify-release-pair.yml", import.meta.url), "utf8");
  assert.match(workflow, /environment:\n\s+name: release-qualification/u);
  assert.match(workflow, /verify-counterpart-baseline\.mjs/u);
  assert.match(workflow, /if \[\[ "\$RELEASE_COMPONENT" == openclaw-plugin \]\]; then[\s\S]*validate-candidate-artifact\.mjs plugin-tgz "\$candidate_plugin"[\s\S]*else[\s\S]*validate-candidate-artifact\.mjs xpi "\$candidate_xpi"/u);
  assert.match(workflow, /THUNDERCLAW_OPENCLAW_PLUGIN_TGZ: \$\{\{ steps\.pair\.outputs\.plugin \}\}/u);
  assert.match(workflow, /THUNDERCLAW_E2E_XPI: \$\{\{ steps\.pair\.outputs\.xpi \}\}/u);
  assert.match(workflow, /bash scripts\/bootstrap-spike\.sh/u);
  assert.match(workflow, /npm run qualify:real-agent/u);
  assert.doesNotMatch(workflow, /THUNDERCLAW_PLUGIN_TOKEN/u);
  verifyWorkflow(workflow, "qualify-release-pair.yml");
});

test("ClawHub publisher uses canonical notes and verifies the public catalog", async () => {
  const workflow = await readFile(new URL("../.github/workflows/publish-clawhub.yml", import.meta.url), "utf8");
  assert.match(workflow, /--component openclaw-plugin/u);
  assert.match(workflow, /--changelog "\$release_notes"/u);
  assert.match(workflow, /verify-marketplace-notes\.mjs[\s\S]*--artifact[\s\S]*--repository[\s\S]*--commit/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /--signer-workflow/u);
  assert.match(workflow, /--source-ref/u);
  assert.match(workflow, /--source-digest/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /gh release view "\$RELEASE_TAG" --json body/u);
  assert.match(workflow, /environment:\n\s+name: clawhub/u);
  assert.doesNotMatch(workflow, /publish_clawhub|submit_thunderbird|npm run pack/u);
  verifyWorkflow(workflow, "publish-clawhub.yml");
});

test("ATN publisher uses supported signing and a distinct manual metadata handoff", async () => {
  const workflow = await readFile(new URL("../.github/workflows/publish-thunderbird-addons.yml", import.meta.url), "utf8");
  assert.match(workflow, /--component thunderbird-extension/u);
  assert.match(workflow, /verify_metadata_only/u);
  assert.match(workflow, /verify-atn-release\.mjs/u);
  assert.match(workflow, /reviewer_source_attached/u);
  assert.match(workflow, /reviewer_testing_notes_entered/u);
  assert.match(workflow, /verify-atn-xpi-payload\.mjs/u);
  assert.match(workflow, /publication incomplete/u);
  assert.match(workflow, /cannot set ATN release notes, attach reviewer source, or enter private reviewer testing notes/u);
  assert.match(workflow, /THUNDERCLAW_E2E_XPI: \$\{\{ runner\.temp \}\}\/thunderclaw-atn-signed-/u);
  assert.match(workflow, /npm run test:e2e:thunderbird/u);
  assert.doesNotMatch(workflow, /THUNDERCLAW_RELEASE_NOTES:|THUNDERCLAW_SOURCE_ARCHIVE:/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /--signer-workflow/u);
  assert.match(workflow, /--source-ref/u);
  assert.match(workflow, /--source-digest/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.doesNotMatch(workflow, /publish_clawhub|submit_thunderbird|npm run pack/u);
  verifyWorkflow(workflow, "publish-thunderbird-addons.yml");
});

test("legacy audits and retries use current trusted automation, the immutable ledger, and one selected channel", async () => {
  const workflow = await readFile(new URL("../.github/workflows/publish-legacy-release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /options: \[v0\.1\.0, v0\.1\.1\]/u);
  assert.match(workflow, /options: \[openclaw-plugin, thunderbird-extension, both\]/u);
  assert.match(workflow, /release-channel-dispatch\.mjs/u);
  assert.match(workflow, /verify-legacy-marketplace-release\.mjs/u);
  assert.match(workflow, /gh attestation verify/u);
  assert.match(workflow, /--signer-workflow/u);
  assert.match(workflow, /verify-legacy-clawhub-release\.mjs/u);
  assert.doesNotMatch(workflow, /package publish/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.match(workflow, /inputs\.channel == 'openclaw-plugin'/u);
  assert.match(workflow, /inputs\.channel == 'thunderbird-extension'/u);
  assert.doesNotMatch(workflow, /publish_clawhub|submit_thunderbird/u);
  verifyWorkflow(workflow, "publish-legacy-release.yml");
});
