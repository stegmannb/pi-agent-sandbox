import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
for (const [pkg, file] of [
  ["oxfmt", "bindings-BiJhCnYE.js"],
  ["oxlint", "bindings.js"],
]) {
  test(`${pkg}: actual native loader prefers Node glibc over host musl`, () => {
    const source = readFileSync(
      join(dirname(require.resolve(`${pkg}/package.json`)), "dist", file),
      "utf8",
    );
    const match = source.match(
      /(?:const isMusl|const loadErrors = \[\], isMusl) = \(\) => \{([\s\S]*?)\n\}/,
    );
    assert.ok(match);
    const check = (glibc, filesystem) =>
      runInNewContext(`(function(){${match[1]}})()`, {
        process: {
          platform: "linux",
          report: { getReport: () => ({ header: glibc ? { glibcVersionRuntime: glibc } : {} }) },
        },
        isMuslFromFilesystem: () => filesystem,
        isMuslFromReport: () => null,
        isMuslFromChildProcess: () => true,
      });
    assert.equal(check("2.42", true), false);
    assert.equal(check(undefined, true), true);
    assert.equal(check(undefined, false), false);
  });
}
