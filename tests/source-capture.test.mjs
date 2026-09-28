import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadedSources } from "../protection.ts";

test("source capture pins loaded dependency bytes, late imports, and package scope absence", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pasa-source-")));
  const entry = join(root, "entry.mjs"),
    dep = join(root, "dep.mjs");
  try {
    writeFileSync(entry, 'export { value } from "./dep.mjs";');
    writeFileSync(dep, "export const value = 1;");
    await import(pathToFileURL(entry).href);
    const proof = loadedSources(pathToFileURL(entry).href);
    assert.ok(proof);
    assert.ok(proof.check());
    writeFileSync(dep, "export const value = 2;");
    assert.throws(() => proof.check());
    assert.equal(loadedSources(pathToFileURL(entry).href), undefined);
    writeFileSync(dep, "export const value = 1;");
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    assert.throws(() => proof.check());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
