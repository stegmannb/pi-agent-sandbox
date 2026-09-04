import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultConfig, deepMerge, matchesPattern, validateConfig } from "../src/policy.ts";

test("rejects a non-object sandbox configuration", () => {
  assert.throws(
    () => validateConfig([], "fixture.json"),
    /expected a JSON object at the top level/,
  );
});

test("rejects a non-boolean enabled flag", () => {
  assert.throws(
    () => validateConfig({ enabled: "yes" }, "fixture.json"),
    /enabled.*must be a boolean/,
  );
});

test("rejects a non-object filesystem policy", () => {
  assert.throws(
    () => validateConfig({ filesystem: [] }, "fixture.json"),
    /filesystem.*must be an object/,
  );
});

test("rejects non-string filesystem entries", () => {
  assert.throws(
    () => validateConfig({ filesystem: { denyWrite: [42] } }, "fixture.json"),
    /every entry.*filesystem\.denyWrite.*must be a string/,
  );
});

test("path prefixes stop at directory boundaries", () => {
  assert.equal(matchesPattern("/tmp/allowed/file.txt", ["/tmp/allowed"]), true);
  assert.equal(matchesPattern("/tmp/allowed-bypass/file.txt", ["/tmp/allowed"]), false);
});

test("deny patterns match protected secret suffixes", () => {
  assert.equal(matchesPattern("/tmp/project/client.key", ["/tmp/project/*.key"]), true);
  assert.equal(matchesPattern("/tmp/project/client.txt", ["/tmp/project/*.key"]), false);
});

test("configuration merges retain default write denials", () => {
  const merged = deepMerge(createDefaultConfig(), {
    filesystem: {
      denyRead: [],
      allowWrite: ["/workspace"],
      denyWrite: ["/workspace/private"],
    },
  });

  assert.ok(merged.filesystem?.denyWrite?.includes(".env"));
  assert.ok(merged.filesystem?.denyWrite?.includes("/workspace/private"));
});

test("a deny fixture remains matched when an allow rule also matches", () => {
  const merged = deepMerge(createDefaultConfig(), {
    filesystem: {
      denyRead: [],
      allowWrite: ["/workspace"],
      denyWrite: ["/workspace/secrets"],
    },
  });
  const protectedPath = "/workspace/secrets/token";

  assert.equal(matchesPattern(protectedPath, merged.filesystem?.allowWrite ?? []), true);
  assert.equal(matchesPattern(protectedPath, merged.filesystem?.denyWrite ?? []), true);
});
