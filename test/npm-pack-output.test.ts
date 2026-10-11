import assert from "node:assert/strict";
import test from "node:test";
import { npmPackFilename } from "../scripts/npm-pack-output.mjs";

const name = "@openclaw/example-provider";
const version = "2026.10.1";
const entry = { name, version, filename: "openclaw-example-provider-2026.10.1.tgz" };

test("npm pack accepts npm 11 arrays and npm 12 package-keyed objects", () => {
  assert.equal(npmPackFilename([entry], name, version), entry.filename);
  assert.equal(npmPackFilename({ [name]: entry }, name, version), entry.filename);
  assert.equal(npmPackFilename([{ ...entry, name: "openclaw", filename: "openclaw-2026.10.1.tgz" }], "openclaw", version),
    "openclaw-2026.10.1.tgz");
});

test("npm pack rejects ambiguous or malformed archive metadata", () => {
  for (const packed of [null, "archive.tgz", {}, [], [entry, entry], { [name]: entry, extra: entry },
    { wrong: entry }, [null], [{ ...entry, name: "other" }], [{ ...entry, version: "2026.9.9" }],
    { [name]: { ...entry, name: "other" } }, { [name]: { ...entry, version: "2026.9.9" } }]) {
    assert.throws(() => npmPackFilename(packed, name, version), /exactly one safe archive/u);
  }
});

test("npm pack rejects filenames that escape the staging directory or carry unsafe syntax", () => {
  for (const filename of ["", "../provider.tgz", "/tmp/provider.tgz", "C:\\provider.tgz", "nested\\provider.tgz",
    "nested/provider.tgz", "--provider.tgz", "provider.zip", "provider.tgz\n", "provider .tgz"]) {
    for (const packed of [[{ ...entry, filename }], { [name]: { ...entry, filename } }]) {
      assert.throws(() => npmPackFilename(packed, name, version), /safe archive/u);
    }
  }
});
