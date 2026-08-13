import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.doesNotMatch(workflow, /npm publish|addons\.mozilla\.org|clawhub/u);

  for (const reference of workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/gu)) {
    assert.match(reference[1], /^[a-f0-9]{40}$/u, `action is not pinned to a full commit: ${reference[0]}`);
  }
});
