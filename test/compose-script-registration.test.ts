import assert from "node:assert/strict";
import test from "node:test";
import {
  createComposeScriptRegistrar,
  type ComposeScriptsApi,
  type RegisteredComposeScript,
} from "../packages/thunderbird-extension/src/compose-script-registration.js";

test("compose-script registration is exact and idempotent within one background lifetime", async () => {
  const registered: RegisteredComposeScript = { unregister: async () => undefined };
  const calls: unknown[] = [];
  const api: ComposeScriptsApi = {
    async register(options) {
      calls.push(options);
      return registered;
    },
  };
  const ensureRegistered = createComposeScriptRegistrar(api);
  const first = ensureRegistered();
  const second = ensureRegistered();
  assert.equal(first, second);
  assert.equal(await first, registered);
  assert.deepEqual(calls, [{ js: [{ file: "compose.js" }] }]);
});

test("a failed registration remains failed closed without duplicate retry", async () => {
  let calls = 0;
  const failure = new Error("synthetic registration failure");
  const ensureRegistered = createComposeScriptRegistrar({
    async register() {
      calls += 1;
      throw failure;
    },
  });
  await assert.rejects(ensureRegistered(), failure);
  await assert.rejects(ensureRegistered(), failure);
  assert.equal(calls, 1);
});

test("a new background lifetime registers a new compose script", async () => {
  let calls = 0;
  const api: ComposeScriptsApi = {
    async register() {
      calls += 1;
      return { unregister: async () => undefined };
    },
  };
  await createComposeScriptRegistrar(api)();
  await createComposeScriptRegistrar(api)();
  assert.equal(calls, 2);
});
