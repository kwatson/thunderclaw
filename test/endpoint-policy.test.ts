import assert from "node:assert/strict";
import test from "node:test";
import { DirectClientError } from "../packages/thunderbird-extension/src/direct-client-contract.js";
import { canonicalizeApiBase } from "../packages/thunderbird-extension/src/endpoint-policy.js";

test("endpoint policy accepts only canonical HTTPS or explicit loopback API bases", () => {
  const accepted = [
    ["https://gateway.example/thunderclaw/v1", "https://gateway.example/thunderclaw/v1", "https://gateway.example/*"],
    ["HTTPS://GATEWAY.EXAMPLE:8443/thunderclaw/v1/", "https://gateway.example:8443/thunderclaw/v1", "https://gateway.example/*"],
    ["http://127.0.0.1:18789/thunderclaw/v1", "http://127.0.0.1:18789/thunderclaw/v1", "http://127.0.0.1/*"],
    ["http://[::1]:18789/thunderclaw/v1/", "http://[::1]:18789/thunderclaw/v1", "http://[::1]/*"],
  ] as const;
  for (const [input, apiBase, permissionPattern] of accepted) {
    const endpoint = canonicalizeApiBase(input);
    assert.equal(endpoint.apiBase, apiBase, input);
    assert.equal(endpoint.permissionPattern, permissionPattern, input);
    assert.equal(Object.isFrozen(endpoint), true, input);
  }
});

test("endpoint policy rejects localhost and every ambiguous or over-broad form", () => {
  const rejected: unknown[] = [
    "http://localhost:18789/thunderclaw/v1",
    "https://localhost/thunderclaw/v1",
    "http://127.0.0.1.evil.test/thunderclaw/v1",
    "http://127.1/thunderclaw/v1",
    "http://2130706433/thunderclaw/v1",
    "http://0177.0.0.1/thunderclaw/v1",
    "http://127.0.0.1./thunderclaw/v1",
    "http://[::ffff:127.0.0.1]/thunderclaw/v1",
    "http://[0:0:0:0:0:0:0:1]/thunderclaw/v1",
    "http://192.168.1.2/thunderclaw/v1",
    "http://100.64.0.1/thunderclaw/v1",
    "https://user:password@gateway.example/thunderclaw/v1",
    "https://gateway.example/thunderclaw/v1?token=x",
    "https://gateway.example/thunderclaw/v1#fragment",
    "https://gateway.example/other",
    "https://gateway.example/thunderclaw/v1/status",
    "https://gateway.example\\thunderclaw/v1",
    "https://gateway.example/%74hunderclaw/v1",
    "https://xn--e1awd7f.example/thunderclaw/v1",
    "https://gateway.example:0/thunderclaw/v1",
    "https://gateway.example:65536/thunderclaw/v1",
    "https://gateway.example:/thunderclaw/v1",
    "ftp://gateway.example/thunderclaw/v1",
    " https://gateway.example/thunderclaw/v1",
    "https://gateway.example/thunderclaw/v1\n",
    "",
    null,
  ];
  for (const input of rejected) {
    assert.throws(() => canonicalizeApiBase(input), (error: unknown) => {
      assert.ok(error instanceof DirectClientError, String(input));
      assert.equal(error.kind, "configuration", String(input));
      assert.equal(error.code, "INVALID_API_BASE", String(input));
      return true;
    });
  }
});
