import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

function currentBindingSuffix(): string | undefined {
  if (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)) {
    return `darwin-${process.arch}`;
  }
  if (process.platform === "linux" && ["arm64", "x64"].includes(process.arch)) {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    const libc = report?.header?.glibcVersionRuntime ? "gnu" : "musl";
    return `linux-${process.arch}-${libc}`;
  }
  if (process.platform === "win32" && ["arm64", "x64"].includes(process.arch)) {
    return `win32-${process.arch}-msvc`;
  }
  return undefined;
}

test(
  "Oxc native bindings resolve through their owning packages",
  { skip: !currentBindingSuffix() },
  () => {
    const suffix = currentBindingSuffix();
    assert.ok(suffix);

    for (const tool of ["oxfmt", "oxlint"] as const) {
      const toolRequire = createRequire(require.resolve(tool));
      const binding = toolRequire.resolve(`@${tool}/binding-${suffix}`);
      assert.match(binding, new RegExp(`binding-${suffix}.+\\.node$`));
    }
  },
);
