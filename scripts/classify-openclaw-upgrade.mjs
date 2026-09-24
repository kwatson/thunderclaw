import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildPreparedFiles, PREPARATION_FILES } from "./prepare-openclaw-upgrade.mjs";

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedKeys(left, right) {
  return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])].filter((key) => !same(left?.[key], right?.[key]));
}

function dependencyClosure(lock) {
  const packages = lock.packages ?? {};
  const seen = new Set();
  const queue = ["node_modules/openclaw"];
  while (queue.length > 0) {
    const key = queue.shift();
    if (seen.has(key) || !packages[key]) continue;
    seen.add(key);
    for (const dependency of Object.keys(packages[key].dependencies ?? {})) {
      let owner = key;
      let found;
      while (owner.startsWith("node_modules/")) {
        const nested = `${owner}/node_modules/${dependency}`;
        if (packages[nested]) { found = nested; break; }
        const cut = owner.lastIndexOf("/node_modules/");
        if (cut < 0) break;
        owner = owner.slice(0, cut);
      }
      found ??= `node_modules/${dependency}`;
      if (packages[found]) queue.push(found);
    }
  }
  return seen;
}

export function classifyLockfileChange(beforeText, afterText) {
  const before = JSON.parse(beforeText);
  const after = JSON.parse(afterText);
  const findings = [];
  for (const key of changedKeys(before, after)) if (key !== "packages") findings.push(`package-lock top-level field changed: ${key}`);
  const oldPackages = before.packages ?? {};
  const newPackages = after.packages ?? {};
  const allowedPackageKeys = new Set([...dependencyClosure(before), ...dependencyClosure(after), "", "packages/openclaw-plugin"]);
  for (const key of changedKeys(oldPackages, newPackages)) {
    if (!allowedPackageKeys.has(key)) findings.push(`unrelated lockfile package changed: ${key}`);
  }
  const allowedRoot = new Set(["devDependencies"]);
  for (const key of changedKeys(oldPackages[""], newPackages[""])) if (!allowedRoot.has(key)) findings.push(`root lockfile metadata changed: ${key}`);
  for (const key of changedKeys(oldPackages[""]?.devDependencies, newPackages[""]?.devDependencies)) {
    if (key !== "openclaw") findings.push(`unrelated root dependency changed: ${key}`);
  }
  const allowedPlugin = new Set(["version", "peerDependencies"]);
  for (const key of changedKeys(oldPackages["packages/openclaw-plugin"], newPackages["packages/openclaw-plugin"])) {
    if (!allowedPlugin.has(key)) findings.push(`plugin lockfile metadata changed: ${key}`);
  }
  for (const key of changedKeys(oldPackages["packages/openclaw-plugin"]?.peerDependencies,
    newPackages["packages/openclaw-plugin"]?.peerDependencies)) {
    if (key !== "openclaw") findings.push(`unrelated plugin dependency changed: ${key}`);
  }
  for (const key of changedKeys(oldPackages, newPackages)) {
    if (!allowedPackageKeys.has(key)) continue;
    const fields = ["hasInstall", "hasInstallScript", "scripts", ...(oldPackages[key] && newPackages[key] ? ["bin"] : [])];
    for (const field of fields) {
      if (!same(oldPackages[key]?.[field], newPackages[key]?.[field])) findings.push(`lockfile package changed lifecycle behavior: ${key}.${field}`);
    }
  }
  return [...new Set(findings)];
}

function descriptor(value) {
  if (typeof value === "string") return { type: "file", mode: "100644", content: value };
  return value;
}

export function classifyPreparedUpgrade({ before, after, preflight, preparedDate, expectedLockfile }) {
  const findings = [];
  const advisories = [...new Set([
    ...(preflight?.advisoryFindings ?? []),
    ...(preflight?.proposed?.upstream?.verifiedTag === false ? ["upstream release tag is unsigned or unverified"] : []),
    ...(preflight?.proposed?.upstream?.verifiedCommit === false ? ["upstream release commit is unsigned or unverified"] : []),
    ...(preflight?.upstreamCi?.waived === true ? ["upstream CI was waived"] : []),
  ])];
  for (const blocker of preflight?.blockingFindings ?? []) findings.push(`preflight blocker: ${blocker}`);
  for (const entrypoint of preflight?.sdk?.missingEntrypoints ?? []) findings.push(`missing required export ${entrypoint}`);
  const changed = [];
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const file of paths) {
    const oldFile = descriptor(before[file]);
    const newFile = descriptor(after[file]);
    if (!same(oldFile, newFile)) changed.push(file);
    if (!PREPARATION_FILES.includes(file) && !same(oldFile, newFile)) findings.push(`unexpected changed path: ${file}`);
    if (newFile && (newFile.type !== "file" || newFile.mode !== oldFile?.mode)) findings.push(`file type or mode changed: ${file}`);
  }
  const beforeContents = Object.fromEntries(PREPARATION_FILES.map((file) => [file, descriptor(before[file])?.content]));
  const afterContents = Object.fromEntries(PREPARATION_FILES.map((file) => [file, descriptor(after[file])?.content]));
  for (const file of PREPARATION_FILES) if (typeof beforeContents[file] !== "string" || typeof afterContents[file] !== "string") findings.push(`required preparation file missing: ${file}`);
  let expected;
  if (findings.length === 0) {
    try {
      expected = buildPreparedFiles({ files: beforeContents, preflight, generatedLockfile: afterContents["package-lock.json"], preparedDate });
      for (const file of PREPARATION_FILES) {
        if (file !== "package-lock.json" && afterContents[file] !== expected.files[file]) findings.push(`noncanonical content change: ${file}`);
      }
      if (typeof expectedLockfile !== "string") findings.push("independently regenerated lockfile evidence is missing");
      else if (afterContents["package-lock.json"] !== expectedLockfile) findings.push("package-lock.json differs from independent regeneration");
      findings.push(...classifyLockfileChange(beforeContents["package-lock.json"], afterContents["package-lock.json"]));
    } catch (error) {
      findings.push(`cannot derive canonical upgrade: ${error.message}`);
    }
  }
  const fileEvidence = [...changed].sort().map((file) => {
    const project = (entry) => entry ? { type: entry.type, mode: entry.mode,
      sha256: createHash("sha256").update(entry.content).digest("hex") } : { type: "absent", mode: "000000", sha256: createHash("sha256").update("").digest("hex") };
    return { path: file, before: project(descriptor(before[file])), after: project(descriptor(after[file])) };
  });
  const evidenceBody = { changed: [...changed].sort(), files: fileEvidence, findings: [...new Set(findings)].sort(), advisories: [...advisories].sort(),
    version: preflight?.proposed?.version ?? null, pluginVersion: expected?.pluginVersion ?? null };
  return {
    format: "thunderclaw-openclaw-upgrade-classification-v1",
    decision: evidenceBody.findings.length === 0 ? "compatibility-only" : "blocked",
    ...evidenceBody,
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidenceBody)).digest("hex"),
  };
}

function git(root, args, encoding = "utf8") {
  const result = spawnSync("git", args, { cwd: root, encoding, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}

function gitObjectDescriptor(root, ref, file) {
  const output = git(root, ["ls-tree", ref, "--", file]).trim();
  if (!output) return { type: "absent", mode: "000000", content: "" };
  const [metadata] = output.split("\t");
  const [mode, type] = metadata.split(/\s+/u);
  return { type: type === "blob" ? "file" : type, mode, content: type === "blob" ? git(root, ["show", `${ref}:${file}`]) : "" };
}

export function snapshotGitRange(root, beforeRef, afterRef) {
  const beforeCommit = git(root, ["rev-parse", "--verify", `${beforeRef}^{commit}`]).trim();
  const afterCommit = git(root, ["rev-parse", "--verify", `${afterRef}^{commit}`]).trim();
  const changed = git(root, ["diff", "--name-only", "--no-renames", "-z", beforeCommit, afterCommit]).split("\0").filter(Boolean);
  const files = new Set([...PREPARATION_FILES, ...changed]);
  return {
    before: Object.fromEntries([...files].map((file) => [file, gitObjectDescriptor(root, beforeCommit, file)])),
    after: Object.fromEntries([...files].map((file) => [file, gitObjectDescriptor(root, afterCommit, file)])),
    beforeCommit,
    afterCommit,
  };
}

async function repositorySnapshots(root) {
  const before = {};
  const after = {};
  for (const file of PREPARATION_FILES) {
    const tree = git(root, ["ls-tree", "HEAD", "--", file]).trim().split(/\s+/u);
    if (tree.length < 4) throw new Error(`HEAD does not contain ${file}`);
    before[file] = { type: tree[1] === "blob" ? "file" : tree[1], mode: tree[0], content: git(root, ["show", `HEAD:${file}`]) };
    const stats = await lstat(path.join(root, file));
    after[file] = { type: stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other",
      mode: stats.mode & 0o111 ? "100755" : "100644", content: stats.isFile() ? await readFile(path.join(root, file), "utf8") : "" };
  }
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  for (const entry of status.split("\0").filter(Boolean)) {
    const file = entry.slice(3).split(" -> ").at(-1);
    if (!PREPARATION_FILES.includes(file)) {
      before[file] = { type: "absent", mode: "000000", content: "" };
      const stats = await lstat(path.join(root, file));
      after[file] = { type: stats.isFile() ? "file" : stats.isSymbolicLink() ? "symlink" : "other",
        mode: stats.mode & 0o111 ? "100755" : "100644", content: stats.isFile() ? await readFile(path.join(root, file), "utf8") : "" };
    }
  }
  return { before, after, beforeCommit: git(root, ["rev-parse", "HEAD"]).trim() };
}

export async function regenerateLockfile(root, snapshots, preflight, preparedDate) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "thunderclaw-lock-verifier-"));
  const worktree = path.join(parent, "source");
  try {
    git(root, ["worktree", "add", "--detach", worktree, snapshots.beforeCommit]);
    const beforeContents = Object.fromEntries(PREPARATION_FILES.map((file) => [file, descriptor(snapshots.before[file])?.content]));
    const afterLock = descriptor(snapshots.after["package-lock.json"])?.content;
    const prepared = buildPreparedFiles({ files: beforeContents, preflight, generatedLockfile: afterLock, preparedDate });
    for (const file of PREPARATION_FILES.filter((entry) => entry !== "package-lock.json")) {
      await writeFile(path.join(worktree, file), prepared.files[file]);
    }
    const result = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", `openclaw@${preflight.proposed.version}`],
      { cwd: worktree, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`independent lockfile regeneration failed: ${result.stderr.trim()}`);
    return await readFile(path.join(worktree, "package-lock.json"), "utf8");
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, encoding: "utf8" });
    await rm(parent, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const preflightIndex = process.argv.indexOf("--preflight");
    const dateIndex = process.argv.indexOf("--date");
    const rootIndex = process.argv.indexOf("--root");
    if (preflightIndex < 0 || !process.argv[preflightIndex + 1]) throw new Error("Usage: classify-openclaw-upgrade.mjs --preflight <json> [--root <path>] [--date YYYY-MM-DD]");
    const root = path.resolve(rootIndex < 0 ? "." : process.argv[rootIndex + 1]);
    const preflight = JSON.parse(await readFile(process.argv[preflightIndex + 1], "utf8"));
    const beforeRefIndex = process.argv.indexOf("--before-ref");
    const afterRefIndex = process.argv.indexOf("--after-ref");
    if ((beforeRefIndex < 0) !== (afterRefIndex < 0)) throw new Error("--before-ref and --after-ref must be provided together");
    const snapshots = beforeRefIndex < 0
      ? await repositorySnapshots(root)
      : snapshotGitRange(root, process.argv[beforeRefIndex + 1], process.argv[afterRefIndex + 1]);
    const preparedDate = dateIndex < 0 ? preflight.observedAt.slice(0, 10) : process.argv[dateIndex + 1];
    const expectedLockfile = await regenerateLockfile(root, snapshots, preflight, preparedDate);
    const result = classifyPreparedUpgrade({ ...snapshots, preflight, preparedDate, expectedLockfile });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.decision === "blocked") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
