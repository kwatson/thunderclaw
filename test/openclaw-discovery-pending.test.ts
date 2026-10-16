import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = "2026.10.4";

test("discovery defers only an unpublished official release and preserves strict preflight elsewhere", async () => {
  const directory = await mkdtemp(join(tmpdir(), "thunderclaw-discovery-"));
  try {
    const stub = `#!${process.execPath}
const program = process.argv[1].split('/').at(-1);
const args = process.argv.slice(2);
const mode = process.env.DISCOVERY_TEST_MODE;
if (program === 'npm') {
  console.log(JSON.stringify({version:'${version}', 'dist.integrity':'sha512-synthetic', 'dist.tarball':'https://example.invalid/package.tgz'}));
} else if (program === 'gh') {
  if (args[1].includes('/releases/tags/')) {
    if (mode === 'tag-404') {
      console.log('HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' + JSON.stringify({tag_name:'v${version}', draft:false, prerelease:false, id:1, html_url:'https://example.invalid/release', published_at:'2026-10-16T00:36:19Z'}));
    } else {
      const status = mode === 'network' ? '' : 'HTTP/2.0 ' + mode + ' Error\\r\\n\\r\\n{}';
      console.log(status);
      console.error('synthetic API failure');
      process.exitCode = 1;
    }
  } else {
    console.log('{}');
    console.error('synthetic tag 404');
    process.exitCode = 1;
  }
} else {
  console.error('unexpected tool call');
  process.exitCode = 99;
}
`;
    for (const name of ["npm", "gh", "docker"]) {
      await writeFile(join(directory, name), stub, { mode: 0o755 });
    }
    for (const mode of ["404", "401", "403", "429", "500", "network", "tag-404"]) {
      for (const defer of [false, true]) {
        const result = spawnSync(process.execPath, ["scripts/preflight-openclaw-upgrade.mjs", "--version", version,
          ...(defer ? ["--defer-unpublished"] : [])], {
          cwd: root, encoding: "utf8", timeout: 10_000,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DISCOVERY_TEST_MODE: mode },
        });
        const pending = mode === "404" && defer;
        assert.equal(result.status, pending ? 75 : 1, `${mode}, defer=${defer}: ${result.stderr}`);
        if (pending) {
          assert.deepEqual(JSON.parse(result.stdout), {
            format: "thunderclaw-openclaw-discovery-pending-v1", version, reason: "official-github-release-pending",
          });
          assert.equal(result.stderr, "");
        } else {
          assert.equal(result.stdout, "");
          assert.ok(result.stderr.length > 0);
          if (mode === "tag-404") assert.match(result.stderr, /synthetic tag 404/u);
        }
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("controller blocks mutation before cancelling pending discovery and retries via unchanged discovery selection", async () => {
  const workflow = await readFile(join(root, ".github/workflows/openclaw-autopilot.yml"), "utf8");
  const inspect = workflow.slice(workflow.indexOf("\n  inspect:"), workflow.indexOf("\n  cancel-pending-discovery:"));
  assert.match(inspect, /actions: read/u);
  assert.doesNotMatch(inspect, /actions: write/u);
  assert.match(inspect, /eligible: \$\{\{ steps.version.outputs.eligible == 'true' && steps.evidence.outputs.pending != 'true' \}\}/u);
  assert.match(inspect, /Upload observation for the mutation boundary\n\s+if: .*steps.evidence.outputs.pending != 'true'/u);
  assert.equal((workflow.match(/--defer-unpublished/gu) ?? []).length, 1);
  const marker = inspect.slice(inspect.indexOf('if [[ "$status" -eq 75 ]]'), inspect.indexOf('if [[ "$status" -ne 0 ]]'));
  assert.ok(marker.length > 0);
  const directory = await mkdtemp(join(tmpdir(), "thunderclaw-discovery-marker-"));
  try {
    await writeFile(join(directory, "preflight.json"), JSON.stringify({
      format: "thunderclaw-openclaw-discovery-pending-v1", version, reason: "official-github-release-pending",
    }));
    for (const valid of [true, false]) {
      if (!valid) await writeFile(join(directory, "preflight.json"), "{}");
      const script = marker.replaceAll("evidence/preflight.json", "preflight.json")
        .replaceAll("${{ steps.version.outputs.version }}", version);
      const result = spawnSync("bash", ["-e", "-c", `status=75\n${script}`], {
        cwd: directory, encoding: "utf8",
        env: { ...process.env, GITHUB_OUTPUT: join(directory, "outputs"), GITHUB_STEP_SUMMARY: join(directory, "summary") },
      });
      assert.equal(result.status, valid ? 0 : 1, result.stderr);
    }
    assert.equal(await readFile(join(directory, "outputs"), "utf8"), "pending=true\n");
    assert.match(await readFile(join(directory, "summary"), "utf8"), /durable state is unchanged/u);
    const cancel = workflow.slice(workflow.indexOf("\n  cancel-pending-discovery:"), workflow.indexOf("\n  reserve:"));
    assert.match(cancel, /if: needs.inspect.outputs.pending == 'true'/u);
    assert.match(cancel, /actions: write/u);
    assert.match(cancel, /repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID\/cancel/u);
    assert.match(workflow, /reserve:[\s\S]*if: needs.inspect.outputs.eligible == 'true'/u);
    const cancelScript = cancel.split("run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
    await writeFile(join(directory, "gh"), `#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.DISCOVERY_TEST_REQUEST, JSON.stringify(process.argv.slice(2)));
process.exitCode = Number(process.env.DISCOVERY_TEST_CANCEL_EXIT);
`, { mode: 0o755 });
    await writeFile(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const exit of [0, 7]) {
      const result = spawnSync("bash", ["-e", "-c", cancelScript], {
        cwd: directory, encoding: "utf8", timeout: 5000,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
          GITHUB_REPOSITORY: "synthetic/project", GITHUB_RUN_ID: "123",
          DISCOVERY_TEST_REQUEST: join(directory, "request.json"), DISCOVERY_TEST_CANCEL_EXIT: String(exit) },
      });
      assert.deepEqual(JSON.parse(await readFile(join(directory, "request.json"), "utf8")),
        ["api", "--method", "POST", "repos/synthetic/project/actions/runs/123/cancel"]);
      // A rejected request or undelivered cancellation must never silently succeed.
      assert.equal(result.status, exit || 1, result.stderr);
      if (exit === 0) assert.match(result.stderr, /did not deliver/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
