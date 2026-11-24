import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getOrCreateToken, validateAuthToken } from "../auth.ts";

describe("loopback auth token manager", () => {
  it("creates, persists, and reuses a 32-char hex token with 0600 permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "figcp-auth-"));
    try {
      const token1 = getOrCreateToken(dir);
      assert.match(token1, /^[0-9a-f]{32}$/);

      const mode = statSync(join(dir, "token")).mode & 0o777;
      assert.equal(mode, 0o600);

      const token2 = getOrCreateToken(dir);
      assert.equal(token2, token1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates matching tokens and rejects invalid ones", () => {
    const expected = "0123456789abcdef0123456789abcdef";
    assert.equal(validateAuthToken(expected, expected), true);
    assert.equal(validateAuthToken("0123456789abcdef0123456789abcdee", expected), false);
    assert.equal(validateAuthToken("short", expected), false);
    assert.equal(validateAuthToken("", expected), false);
    assert.equal(validateAuthToken(undefined, expected), false);
  });
});
