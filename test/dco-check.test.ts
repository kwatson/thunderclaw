import assert from "node:assert/strict";
import test from "node:test";

import { validAuthorSignoff } from "../scripts/check-dco.mjs";

test("accepts a matching DCO author signoff", () => {
  assert.equal(
    validAuthorSignoff("contributor@example.com", [
      "Signed-off-by: Example Contributor <contributor@example.com>",
    ]),
    true,
  );
});

test("matches signoff email addresses case-insensitively", () => {
  assert.equal(
    validAuthorSignoff("Contributor@Example.com", [
      "Signed-off-by: Example Contributor <contributor@example.com>",
    ]),
    true,
  );
});

test("rejects a signoff from someone other than the commit author", () => {
  assert.equal(
    validAuthorSignoff("author@example.com", [
      "Signed-off-by: Helpful Maintainer <maintainer@example.com>",
    ]),
    false,
  );
});

test("rejects malformed and unrelated trailers", () => {
  assert.equal(
    validAuthorSignoff("author@example.com", [
      "Co-authored-by: Author <author@example.com>",
      "Signed-off-by: author@example.com",
    ]),
    false,
  );
});
