import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PairingRegistry,
  approvalCodeVerifier,
  claimCredentialVerifier,
  deviceCredentialVerifier,
} from "../packages/openclaw-plugin/src/pairing-registry.js";

const REQUEST_ID = "request_native_123456789012345";
const DEVICE_ID = "device_native_1234567890123456";
const CREDENTIAL_ID = "credential_native_123456789012";
const CLAIM_SECRET = "claim-native-abcdefghijklmnopqrstuvwxyz-0123456789";
const DEVICE_SECRET = "device-native-abcdefghijklmnopqrstuvwxyz-0123456789";
const APPROVAL_CODE = "ABCDE23456";

type WindowsAclResult = {
  identity: string;
  owners: string[];
  unexpectedAccess: Array<{ identity: string; rights: string; inherited: boolean }>;
};

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function assertRegularPrivateFile(path: string): void {
  const stat = lstatSync(path);
  assert.equal(stat.isFile(), true, `${path} must be a regular file`);
  assert.equal(stat.isSymbolicLink(), false, `${path} must not be a symbolic link`);
  assert.equal(stat.nlink, 1, `${path} must have exactly one hard link`);
  if (process.platform === "darwin") assert.equal(mode(path), 0o600, `${path} must have mode 0600`);
}

function inspectWindowsAcl(paths: string[]): WindowsAclResult {
  const encodedPaths = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const command = `
$ErrorActionPreference = 'Stop'
$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPaths}')) | ConvertFrom-Json
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($current, 'S-1-3-0', 'S-1-5-18', 'S-1-5-32-544')
$findings = @()
$owners = @()
foreach ($path in $paths) {
  $acl = Get-Acl -LiteralPath $path
  $owners += $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $allowed -notcontains $rule.IdentityReference.Value) {
      $findings += [PSCustomObject]@{ identity = $rule.IdentityReference.Value; rights = $rule.FileSystemRights.ToString(); inherited = $rule.IsInherited }
    }
  }
}
[PSCustomObject]@{ identity = $current; owners = @($owners | Select-Object -Unique); unexpectedAccess = $findings } | ConvertTo-Json -Compress -Depth 4
`;
  let output: string | undefined;
  let lastError: unknown;
  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    try {
      output = execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        encoding: "utf8",
        windowsHide: true,
      }).trim();
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!output) throw new Error("PowerShell ACL inspection failed", { cause: lastError });
  return JSON.parse(output) as WindowsAclResult;
}

function qualifyLifecycle(stateDir: string): string[] {
  let registry = PairingRegistry.open(stateDir);
  assert.equal(registry.isAvailable, true, "registry must open on the native filesystem");
  registry.issue({
    requestId: REQUEST_ID,
    deviceId: DEVICE_ID,
    deviceName: `GitHub-hosted ${process.platform} qualification`,
    credentialId: CREDENTIAL_ID,
    credentialVerifier: deviceCredentialVerifier(`${CREDENTIAL_ID}.${DEVICE_SECRET}`),
    claimVerifier: claimCredentialVerifier(`${REQUEST_ID}.${CLAIM_SECRET}`),
    approvalCodeVerifier: approvalCodeVerifier(APPROVAL_CODE),
  });
  registry.approve(REQUEST_ID, APPROVAL_CODE);
  registry.claim(REQUEST_ID, `${REQUEST_ID}.${CLAIM_SECRET}`);
  registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "status:read");

  const pluginDirectory = join(stateDir, "plugins", "thunderclaw");
  const databasePath = join(pluginDirectory, "pairing.sqlite");
  const paths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].filter(existsSync);
  assert.equal(lstatSync(pluginDirectory).isDirectory(), true);
  assert.equal(lstatSync(pluginDirectory).isSymbolicLink(), false);
  if (process.platform === "darwin") assert.equal(mode(pluginDirectory), 0o700, "plugin state directory must have mode 0700");
  for (const path of paths) assertRegularPrivateFile(path);

  for (const path of paths) {
    const bytes = readFileSync(path);
    for (const secret of [CLAIM_SECRET, DEVICE_SECRET, APPROVAL_CODE]) {
      assert.equal(bytes.includes(Buffer.from(secret)), false, `${path} contained raw secret material`);
    }
  }

  if (process.platform === "win32") {
    const acl = inspectWindowsAcl([pluginDirectory, ...paths]);
    const allowedOwners = new Set([acl.identity, "S-1-5-18", "S-1-5-32-544"]);
    assert.equal(acl.owners.every((owner) => allowedOwners.has(owner)), true, `unexpected Windows registry owner: ${JSON.stringify(acl.owners)}`);
    assert.equal(acl.unexpectedAccess.length, 0, `unexpected Windows principals have registry access: ${JSON.stringify(acl.unexpectedAccess)}`);
  }

  registry.close();
  if (process.platform === "darwin") {
    chmodSync(pluginDirectory, 0o777);
    chmodSync(databasePath, 0o666);
  }
  registry = PairingRegistry.open(stateDir);
  assert.equal(registry.isAvailable, true, "registry must reopen after restart");
  assert.equal(
    registry.authenticate(CREDENTIAL_ID, `${CREDENTIAL_ID}.${DEVICE_SECRET}`, "message:transform").credentialId,
    CREDENTIAL_ID,
  );
  if (process.platform === "darwin") {
    assert.equal(mode(pluginDirectory), 0o700, "reopen must repair the plugin directory mode");
    assert.equal(mode(databasePath), 0o600, "reopen must repair the database mode");
  }
  registry.close();
  return paths.map((path) => path.slice(pluginDirectory.length + 1));
}

function qualifyHostileObjects(root: string): void {
  const linkState = join(root, "link-state");
  const linkTarget = join(root, "link-target");
  mkdirSync(join(linkState, "plugins"), { recursive: true });
  mkdirSync(linkTarget);
  symlinkSync(linkTarget, join(linkState, "plugins", "thunderclaw"), process.platform === "win32" ? "junction" : "dir");
  const linked = PairingRegistry.open(linkState);
  assert.equal(linked.isAvailable, false, "registry must reject a linked or reparse-point plugin directory");
  linked.close();

  const hardlinkState = join(root, "hardlink-state");
  mkdirSync(hardlinkState);
  let registry = PairingRegistry.open(hardlinkState);
  assert.equal(registry.isAvailable, true);
  registry.close();
  const databasePath = join(hardlinkState, "plugins", "thunderclaw", "pairing.sqlite");
  linkSync(databasePath, join(root, "pairing-hardlink.sqlite"));
  registry = PairingRegistry.open(hardlinkState);
  assert.equal(registry.isAvailable, false, "registry must reject a multiply-linked database");
  registry.close();
}

if (process.platform !== "win32" && process.platform !== "darwin") {
  throw new Error(`native desktop filesystem qualification supports win32 and darwin, not ${process.platform}`);
}

const root = mkdtempSync(join(tmpdir(), "thunderclaw-native-filesystem-"));
try {
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const checkedFiles = qualifyLifecycle(stateDir);
  qualifyHostileObjects(root);
  process.stdout.write(`${JSON.stringify({
    qualification: "thunderclaw-native-filesystem-v1",
    platform: process.platform,
    arch: process.arch,
    filesChecked: checkedFiles,
    checks: ["lifecycle-restart", "raw-secret-absence", "native-permissions", "linked-directory-rejection", "hardlink-rejection"],
    result: "passed",
  })}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
