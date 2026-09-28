import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadedSources } from "../protection.ts";
import { captureSources } from "../protection-source.mjs";

async function fixture(run, scope = null) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pasa-source-")));
  const entry = join(root, "entry.mjs"),
    dep = join(root, "dep.mjs"),
    late = join(root, "late.mjs"),
    pkg = join(root, "package.json");
  try {
    fs.writeFileSync(
      entry,
      'export { value } from "./dep.mjs"; export const grow = () => import("./late.mjs");',
    );
    fs.writeFileSync(dep, "export const value = 1;");
    fs.writeFileSync(late, "export const late = 1;");
    if (scope !== null) fs.writeFileSync(pkg, scope);
    const url = pathToFileURL(entry).href;
    const module = await import(url);
    const proof = loadedSources(url);
    assert.ok(proof);
    assert.equal(proof.check(), true);
    await run({ root, entry, dep, late, pkg, url, module, proof });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Delegate all actual reads to fs. Only schedule real on-disk mutations or
// count operations, without substituting bytes, hashes or graph observations.
function duringReads(onRead, run) {
  const original = fs.readFileSync;
  fs.readFileSync = (...args) => {
    const bytes = original(...args);
    onRead(args[0]);
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    fs.readFileSync = original;
    syncBuiltinESMExports();
  }
}

function changePreservingMetadata(path, bytes) {
  const before = fs.statSync(path);
  fs.writeFileSync(path, bytes);
  fs.utimesSync(path, before.atime, before.mtime);
  assert.equal(fs.statSync(path).size, before.size);
  assert.equal(fs.statSync(path).mtimeMs, before.mtimeMs);
}

test("source and scope bytes are fresh despite identical size and mtime", async () => {
  await fixture(({ dep, pkg, url, proof }) => {
    // Use exactly representable timestamps so the equality is strict on all hosts.
    fs.utimesSync(dep, 1700000000, 1700000000);
    changePreservingMetadata(dep, "export const value = 2;");
    assert.throws(() => proof.check(), /source drift/);
    assert.equal(loadedSources(url), undefined);
    fs.writeFileSync(dep, "export const value = 1;");
    assert.equal(proof.check(), true);
    fs.utimesSync(pkg, 1700000000, 1700000000);
    changePreservingMetadata(pkg, '{"type":"module","x":2}');
    assert.throws(() => proof.check(), /package scope drift/);
    fs.writeFileSync(pkg, '{"type":"module","x":1}');
    assert.equal(proof.check(), true);
  }, '{"type":"module","x":1}');
});

test("new and missing package scopes refuse on successive checks", async () => {
  await fixture(({ pkg, proof }) => {
    fs.writeFileSync(pkg, '{"type":"module"}');
    assert.throws(() => proof.check(), /package scope drift/);
    fs.unlinkSync(pkg);
    assert.equal(proof.check(), true);
  });
  await fixture(({ pkg, proof }) => {
    fs.unlinkSync(pkg);
    assert.throws(() => proof.check(), /package scope drift/);
  }, '{"type":"module"}');
});

test("same-byte symlink substitution refuses", async () => {
  await fixture(({ dep, root, proof }) => {
    const target = join(root, "replacement.mjs");
    fs.copyFileSync(dep, target);
    fs.unlinkSync(dep);
    fs.symlinkSync(target, dep);
    assert.throws(() => proof.check(), /source drift/);
  });
});

test("an actual late import grows the graph and invalidates the earlier proof", async () => {
  await fixture(async ({ module, late, url, proof }) => {
    assert.equal(
      captureSources(url).some((ref) => ref.path === late),
      false,
    );
    await module.grow();
    assert.equal(
      captureSources(url).some((ref) => ref.path === late),
      true,
    );
    assert.equal(proof.check(), false);
    assert.equal(loadedSources(url).check(), true);
  });
});

test("a reachable unobserved module refuses", async () => {
  await fixture(async ({ late, module, proof }) => {
    fs.writeFileSync(late, 'import "data:text/javascript,export default 1";');
    await module.grow();
    assert.throws(() => proof.check(), /unobserved module/);
  });
});

for (const original of [null, '{"type":"module","x":1}']) {
  test(`conflicting captured scope expectations refuse, initial scope ${original}`, async () => {
    await fixture(async ({ pkg, module, url }) => {
      fs.writeFileSync(pkg, '{"type":"module","x":2}');
      await module.grow();
      assert.throws(() => captureSources(url), /package scope drift/);
      if (original === null) fs.unlinkSync(pkg);
      else fs.writeFileSync(pkg, original);
      assert.throws(() => captureSources(url), /package scope drift/);
      assert.equal(loadedSources(url), undefined);
    }, original);
  });
}

test("persistent scope drift during source traversal refuses", async () => {
  await fixture(({ dep, pkg, proof }) => {
    let changed = false;
    duringReads(
      (path) => {
        if (path === dep) {
          fs.writeFileSync(pkg, '{"type":"module","x":2}');
          changed = true;
        }
      },
      () => assert.throws(() => proof.check(), /package scope drift/),
    );
    assert.equal(changed, true);
  }, '{"type":"module","x":1}');
});

test("the separate final scope check catches drift after the last module scope read", async () => {
  await fixture(({ pkg, proof }) => {
    let reads = 0;
    duringReads(
      (path) => {
        if (path === pkg && ++reads === 2) fs.writeFileSync(pkg, '{"type":"module","x":2}');
      },
      () => assert.equal(proof.check(), false),
    );
    assert.equal(reads, 3);
    assert.throws(() => proof.check(), /package scope drift/);
  }, '{"type":"module","x":1}');
});

test("drift after the last scope read is outside the snapshot and refuses next time", async () => {
  await fixture(({ pkg, proof }) => {
    let totalReads = 0;
    duringReads(
      (path) => {
        if (path === pkg) totalReads++;
      },
      () => assert.equal(proof.check(), true),
    );
    assert.ok(totalReads >= 2);
    let reads = 0;
    duringReads(
      (path) => {
        if (path === pkg && ++reads === totalReads)
          fs.writeFileSync(pkg, '{"type":"module","x":2}');
      },
      () => assert.equal(proof.check(), true),
    );
    assert.equal(reads, totalReads);
    assert.throws(() => proof.check(), /package scope drift/);
  }, '{"type":"module","x":1}');
});

// Regression for the rejected one-read scope union. The original per-module
// scope observation must refuse before the dependency can restore the bytes.
test("transient scope drift after entry read refuses before dependency restoration", async () => {
  await fixture(({ entry, dep, pkg, proof }) => {
    const events = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      fs.writeFileSync(pkg, '{"type":"module","x":1}');
      assert.equal(proof.check(), true);
      duringReads(
        (path) => {
          if (path === entry) {
            fs.writeFileSync(pkg, '{"type":"module","x":2}');
            events.push("entry");
          }
          if (path === dep) {
            fs.writeFileSync(pkg, '{"type":"module","x":1}');
            events.push("dep");
          }
        },
        () => assert.throws(() => proof.check(), /package scope drift/),
      );
      assert.throws(() => proof.check(), /package scope drift/);
    }
    assert.deepEqual(events, ["entry", "entry"]);
    fs.writeFileSync(pkg, '{"type":"module","x":1}');
    assert.equal(proof.check(), true);
  }, '{"type":"module","x":1}');
});

test("each module repeats every fresh scope observation before its dependencies", async () => {
  await fixture(({ entry, dep, proof, url }) => {
    const names = ["realpathSync", "existsSync", "readFileSync"];
    const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
    const expected = [];
    for (const source of [entry, dep]) {
      expected.push(["realpathSync", source], ["readFileSync", source]);
      let directory = dirname(source);
      while (true) {
        const path = join(directory, "package.json");
        expected.push(["existsSync", path]);
        if (fs.existsSync(path)) expected.push(["readFileSync", path]);
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const actual = [];
    for (const name of names) {
      fs[name] = (...args) => {
        actual.push([name, args[0]]);
        return originals[name](...args);
      };
    }
    syncBuiltinESMExports();
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        actual.length = 0;
        captureSources(url);
        assert.deepEqual(actual, expected);
      }
    } finally {
      Object.assign(fs, originals);
      syncBuiltinESMExports();
    }
    assert.equal(proof.check(), true);
  }, '{"type":"module","x":1}');
});
