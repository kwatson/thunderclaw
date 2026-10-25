import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function workflowRunBlocks(workflow: string): Array<{ line: number; script: string }> {
  const lines = workflow.split("\n");
  const blocks: Array<{ line: number; script: string }> = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)run: \|\s*$/u.exec(line);
    if (!match) continue;
    const keyIndent = match[1].length;
    const body: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex];
      const indentation = /^(\s*)/u.exec(bodyLine)?.[1].length ?? 0;
      if (bodyLine.trim() !== "" && indentation <= keyIndent) break;
      body.push(bodyLine.slice(Math.min(bodyLine.length, keyIndent + 2)));
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
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-n"], { input: block.script, encoding: "utf8" });
    assert.equal(result.status, 0, `${filename}:${block.line} has invalid shell syntax:\n${result.stderr}`);
  }
}

const releaseUrl = new URL("../.github/workflows/release.yml", import.meta.url);
const publisherUrl = new URL("../.github/workflows/publish-thunderbird-addons.yml", import.meta.url);

test("standalone extension tags build once and preserve all qualification and approval gates", async () => {
  const workflow = await readFile(releaseUrl, "utf8");
  assert.match(workflow, /on:\n  push:\n    tags:\n      - "thunderbird-extension-v\*"/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$GITHUB_SHA" refs\/remotes\/origin\/main/u);
  assert.match(workflow, /--notes-output build\/release-notes\.md/u);
  assert.match(workflow, /test "\$\(jq -r \.component <<<"\$metadata"\)" = thunderbird-extension/u);
  assert.equal((workflow.match(/npm run build:extension/gu) ?? []).length, 2,
    "build the candidate once and reproduce it separately from reviewer source");
  assert.equal((workflow.match(/npm run pack:source/gu) ?? []).length, 1);
  assert.equal((workflow.match(/npm test/gu) ?? []).length, 1);
  assert.match(workflow, /npm run typecheck/u);
  assert.match(workflow, /gitleaks.*[\s\S]*--redact/u);
  assert.match(workflow, /release-provenance-v2/u);
  assert.match(workflow, /THUNDERCLAW_E2E_XPI: \$\{\{ github\.workspace \}\}\/release\/thunderclaw-thunderbird-/u);
  assert.match(workflow, /--xpi "release\/thunderclaw-thunderbird-/u);
  assert.match(workflow, /cmp -s "release\/thunderclaw-thunderbird-/u);
  const promotion = workflow.slice(workflow.indexOf("  release:"));
  assert.match(promotion, /needs:\n      - build\n      - thunderbird-qualification\n      - native-qualification\n      - source-qualification/u);
  assert.match(promotion, /environment:\n      name: release/u);
  assert.match(promotion, /attestations: write[\s\S]*contents: write[\s\S]*id-token: write/u);
  assert.match(promotion, /attest-build-provenance@[a-f0-9]{40}/u);
  assert.match(promotion, /--verify-tag[\s\S]*--notes-file release\/release-notes\.md/u);
  assert.match(promotion, /uses: \.\/\.github\/workflows\/publish-thunderbird-addons\.yml/u);
  assert.doesNotMatch(workflow, /openclaw|clawhub|autopilot|counterpart|qualify-release-pair|pack:release|native-filesystem/iu);
  verifyWorkflow(workflow, "release.yml");
});

test("native release qualification exercises pinned Windows Thunderbird and the exact candidate", async () => {
  const workflow = await readFile(releaseUrl, "utf8");
  const native = workflow.slice(workflow.indexOf("  native-qualification:"), workflow.indexOf("  source-qualification:"));
  assert.match(native, /runs-on: windows-2025/u);
  assert.match(native, /THUNDERBIRD_VERSION: 153\.0\.3/u);
  assert.match(native, /install-native-thunderbird\.ps1.*-Sha512 '[a-f0-9]{128}'/u);
  assert.match(native, /sha256sum --check SHA256SUMS/u);
  assert.match(native, /python e2e\/thunderbird\/run_compose\.py[\s\S]*--xpi "release\/thunderclaw-thunderbird-/u);
  assert.match(native, /--expected-version '\$\{\{ env\.THUNDERBIRD_VERSION \}\}'/u);
  assert.match(native, /--application-ini "\$THUNDERBIRD_APPLICATION_INI"/u);
  assert.match(native, /if: \$\{\{ !cancelled\(\) \}\}[\s\S]*actions\/upload-artifact/u);
  assert.doesNotMatch(native, /matrix|npm test|macos|npm ci/u);
});

test("candidate checksums block promotion when either qualified artifact changes", async () => {
  const workflow = await readFile(releaseUrl, "utf8");
  const promotion = workflow.slice(workflow.indexOf("  release:"));
  const verification = /- name: Verify qualified bytes\n        run: ([^\n]+)/u.exec(promotion)?.[1];
  assert.ok(verification);
  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-qualified-release-"));
  try {
    await mkdir(path.join(directory, "release"));
    const artifacts = ["thunderclaw-thunderbird-1.2.3.xpi", "thunderclaw-thunderbird-source-1.2.3.zip"];
    const checksums = artifacts.map((name) => `${createHash("sha256").update(name).digest("hex")}  ${name}`).join("\n");
    await writeFile(path.join(directory, "release/SHA256SUMS"), `${checksums}\n`);
    for (const tampered of [undefined, ...artifacts]) {
      for (const name of artifacts) await writeFile(path.join(directory, "release", name), name === tampered ? "tampered" : name);
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-o", "pipefail", "-c", verification], { cwd: directory, encoding: "utf8" });
      if (tampered) assert.notEqual(result.status, 0, `${tampered} must block publication`);
      else assert.equal(result.status, 0, result.stderr);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ATN rejects retired and noncanonical tags before checking out or installing publication code", async () => {
  const workflow = await readFile(publisherUrl, "utf8");
  const guard = workflowRunBlocks(workflow).find((block) => block.script.includes("canonical form thunderbird-extension-vX.Y.Z"));
  assert.ok(guard);
  assert.ok(workflow.indexOf("Reject unsupported publication tags") < workflow.indexOf("uses: actions/checkout@"));
  for (const tag of ["thunderbird-extension-v0.2.4", "openclaw-plugin-v0.1.19", "v0.1.1", "main", "thunderbird-extension-v01.2.3", "thunderbird-extension-v1.2.3-beta.1", "thunderbird-extension-v1.2.3\n"]) {
    const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-o", "pipefail", "-c", guard.script], {
      encoding: "utf8", env: { ...process.env, RELEASE_TAG: tag },
    });
    assert.equal(result.status, tag === "thunderbird-extension-v0.2.4" ? 0 : 1, tag);
  }
});

test("ATN authenticates tag ancestry before runtime setup or dependency lifecycle code", async () => {
  const workflow = await readFile(publisherUrl, "utf8");
  const ancestry = workflowRunBlocks(workflow).find((block) => block.script.includes("git merge-base --is-ancestor"));
  assert.ok(ancestry);
  const boundary = workflow.indexOf("Verify publication tag commit belongs to main");
  assert.ok(boundary > workflow.indexOf("uses: actions/checkout@"));
  assert.ok(boundary < workflow.indexOf("uses: jdx/mise-action@"));
  assert.ok(boundary < workflow.indexOf("mise exec -- npm ci"));
  assert.doesNotMatch(ancestry.script, /mise|npm|node/u);

  const directory = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-publish-ancestry-"));
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: "Synthetic author", GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic author", GIT_COMMITTER_EMAIL: "author@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, env: environment, stdio: "pipe" });
  try {
    git("init", "--bare", "origin.git");
    git("init", "--initial-branch=main");
    git("remote", "add", "origin", path.join(directory, "origin.git"));
    git("commit", "--allow-empty", "-m", "Synthetic reviewed source");
    git("tag", "thunderbird-extension-v1.2.3");
    git("push", "origin", "main");
    git("checkout", "-b", "unreviewed");
    git("commit", "--allow-empty", "-m", "Synthetic unreviewed source");
    git("tag", "thunderbird-extension-v1.2.4");
    for (const scenario of [
      { tag: "thunderbird-extension-v1.2.3", checkout: "thunderbird-extension-v1.2.3", status: 0 },
      { tag: "thunderbird-extension-v1.2.4", checkout: "thunderbird-extension-v1.2.4", status: 1 },
      { tag: "thunderbird-extension-v1.2.3", checkout: "thunderbird-extension-v1.2.4", status: 1 },
    ]) {
      git("checkout", "--detach", `refs/tags/${scenario.checkout}`);
      const result: SpawnSyncReturns<string> = spawnSync("bash", ["-e", "-o", "pipefail", "-c", ancestry.script], {
        cwd: directory, encoding: "utf8", env: { ...environment, RELEASE_TAG: scenario.tag },
      });
      assert.equal(result.status, scenario.status, `${scenario.tag} from ${scenario.checkout}: ${result.stderr}`);
      if (scenario.tag.endsWith("1.2.4")) assert.match(result.stderr, /must be contained in origin\/main/u);
      if (scenario.tag !== scenario.checkout) assert.match(result.stderr, /must match the publication tag commit/u);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ATN promotion verifies release provenance and keeps mandatory handoff and public signed checks", async () => {
  const workflow = await readFile(publisherUrl, "utf8");
  assert.match(workflow, /environment:\n      name: thunderbird-addons/u);
  assert.match(workflow, /ref: \$\{\{ inputs\.tag \}\}/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$commit" refs\/remotes\/origin\/main/u);
  assert.match(workflow, /verify-marketplace-release\.mjs[\s\S]*--component thunderbird-extension[\s\S]*--tag "\$RELEASE_TAG"[\s\S]*--commit "\$commit"/u);
  assert.match(workflow, /verifyMarketplaceNotes[\s\S]*release\/canonical\/release-notes\.md[\s\S]*release\/github-release-notes\.md/u);
  assert.match(workflow, /for artifact in .*\.xpi" .*\.zip"; do[\s\S]*gh attestation verify/u);
  assert.match(workflow, /--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml"/u);
  assert.match(workflow, /--source-ref "refs\/tags\/\$RELEASE_TAG"[\s\S]*--source-digest "\$commit"/u);
  assert.match(workflow, /if: \$\{\{ !inputs\.verify_metadata_only \}\}[\s\S]*submit-thunderbird-addon\.mjs/u);
  assert.match(workflow, /publication incomplete/u);
  assert.match(workflow, /cannot set ATN release notes, attach reviewer source, or enter private reviewer testing notes/u);
  assert.match(workflow, /inputs\.verify_metadata_only && \(!inputs\.reviewer_source_attached \|\| !inputs\.reviewer_testing_notes_entered\)/u);
  const publicVerification = workflow.slice(workflow.indexOf("      - name: Verify and download public"));
  assert.match(publicVerification, /verify-atn-release\.mjs/u);
  assert.match(publicVerification, /verify-atn-xpi-payload\.mjs/u);
  assert.match(publicVerification, /THUNDERCLAW_E2E_XPI: \$\{\{ runner\.temp \}\}\/thunderclaw-atn-signed-/u);
  assert.match(publicVerification, /npm run test:e2e:thunderbird/u);
  assert.ok(publicVerification.indexOf("verify-atn-xpi-payload.mjs") < publicVerification.indexOf("npm run test:e2e:thunderbird"));
  assert.match(publicVerification, /Retain ATN result[\s\S]*if: always\(\)/u);
  assert.doesNotMatch(workflow, /npm run (?:pack|build)|clawhub|openclaw|autopilot/iu);
  verifyWorkflow(workflow, "publish-thunderbird-addons.yml");
});

test("retired OpenClaw release and automation workflows cannot run", async () => {
  const names = await readdir(new URL("../.github/workflows/", import.meta.url));
  for (const retired of ["openclaw-autopilot.yml", "qualify-openclaw-autopilot.yml", "qualify-release-pair.yml", "release-openclaw-plugin.yml", "publish-clawhub.yml", "publish-legacy-release.yml", "complete-plugin-publication.yml", "complete-openclaw-autopilot-closeout.yml", "validate-release-automation.yml"]) {
    assert.ok(!names.includes(retired), `${retired} must remain retired`);
  }
});
