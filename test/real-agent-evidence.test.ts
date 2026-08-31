import assert from "node:assert/strict";
import test from "node:test";
import { providerRepairObserved } from "../e2e/qualification/real-agent/evidence.mjs";

test("repair evidence follows request admission order instead of response completion order", () => {
  assert.equal(providerRepairObserved([
    { sequence: 16, roles: ["system", "user", "user", "user"] },
    { sequence: 15, roles: ["system", "user"] },
  ]), true);
  assert.equal(providerRepairObserved([
    { sequence: 15, roles: ["system", "user"] },
  ]), false);
  assert.equal(providerRepairObserved([
    { sequence: 15, roles: ["system", "user"] },
    { sequence: 16, roles: ["system", "user", "user", "user"] },
    { sequence: 17, roles: ["system", "user"] },
  ]), false, "a later whole-trial retry must determine the accepted attempt's repair state");
});

test("repair evidence rejects invalid provider sequences and missing initial calls", () => {
  assert.throws(() => providerRepairObserved([{ sequence: 0, roles: ["system", "user"] }]),
    /invalid request sequence/u);
  assert.throws(() => providerRepairObserved([{ sequence: 1, roles: ["system", "user", "user", "user"] }]),
    /no initial model request/u);
});
