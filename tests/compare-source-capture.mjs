// Compare two bootstraps in separate processes at the same fixture paths.
// Usage: node tests/compare-source-capture.mjs /absolute/baseline/protection-source.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
if (process.argv[2] === "--measure") {
  const fixture = process.argv[3];
  const bootstrap = join(fixture, "protection-source.mjs");
  const { captureSources, captureScopes } = await import(pathToFileURL(bootstrap).href);
  const { loadedSources } = await import(pathToFileURL(join(fixture, "protection.ts")).href);
  const sdkPath = join(here, "pi-073/node_modules/@mariozechner/pi-coding-agent/dist/index.js");
  process.env.PASA_SANDBOX_PI_ENTRY = sdkPath;
  const sdk = await import(pathToFileURL(sdkPath).href);
  const entry = join(fixture, "pasa-extension.mjs");
  const url = pathToFileURL(entry).href;
  const loader = new sdk.DefaultResourceLoader({
    cwd: fixture,
    agentDir: join(fixture, "agent"),
    eventBus: sdk.createEventBus(),
    additionalExtensionPaths: [entry],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    settingsManager: sdk.SettingsManager.inMemory({}),
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
  const refs = captureSources(url);
  assert.ok(refs.some((ref) => ref.path === fs.realpathSync(sdkPath)));
  assert.ok(refs.some((ref) => ref.path.endsWith("/sandbox/sandbox-manager.js")));
  assert.ok(refs.length > 1000);
  const scopes = captureScopes(refs);
  const proof = loadedSources(url);
  assert.ok(proof);
  assert.equal(proof.check(), true);
  const reads = new Map();
  const trace = [];
  const originals = Object.fromEntries(
    ["readFileSync", "existsSync", "realpathSync"].map((name) => [name, fs[name]]),
  );
  for (const name of ["existsSync", "realpathSync"]) {
    fs[name] = (...args) => {
      trace.push([name, args[0]]);
      return originals[name](...args);
    };
  }
  const original = fs.readFileSync;
  fs.readFileSync = (...args) => {
    trace.push(["readFileSync", args[0]]);
    reads.set(args[0], (reads.get(args[0]) ?? 0) + 1);
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(captureSources(url), refs);
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
  const captureTrace = [...trace];
  trace.length = 0;
  Object.assign(fs, originals);
  const measured = refs.filter((ref) => ref.path !== bootstrap);
  for (const ref of measured.filter((ref) => !ref.path.endsWith("/package.json")))
    assert.equal(reads.get(ref.path), 1);
  for (const name of Object.keys(originals)) {
    fs[name] = (...args) => {
      trace.push([name, args[0]]);
      return originals[name](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    assert.equal(proof.check(), true);
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
  const checkTrace = [...trace];
  const captureMs = [],
    checkMs = [];
  for (let sample = 0; sample < 5; sample++) {
    let start = performance.now();
    const current = captureSources(url);
    captureMs.push(performance.now() - start);
    assert.deepEqual(current, refs);
    start = performance.now();
    const valid = proof.check();
    checkMs.push(performance.now() - start);
    assert.equal(valid, true);
  }
  // Exercise refusals on this same real SDK closure after the timing samples.
  // Only private fixture files change; shared SDK/runtime installations stay read-only.
  const refusals = [];
  for (const file of ["index.ts", "package.json"]) {
    const path = join(fixture, file);
    const bytes = fs.readFileSync(path);
    fs.utimesSync(path, 1700000000, 1700000000);
    const stat = fs.statSync(path);
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    try {
      fs.writeFileSync(path, changed);
      fs.utimesSync(path, stat.atime, stat.mtime);
      assert.equal(fs.statSync(path).size, stat.size);
      assert.equal(fs.statSync(path).mtimeMs, stat.mtimeMs);
      assert.throws(() => proof.check(), /(?:source|package scope) drift/);
      refusals.push(`same-size-same-mtime:${file}`);
    } finally {
      fs.writeFileSync(path, bytes);
    }
    assert.equal(proof.check(), true);
  }
  const pkg = join(fixture, "package.json");
  const packageBytes = fs.readFileSync(pkg);
  fs.unlinkSync(pkg);
  try {
    assert.throws(() => proof.check(), /package scope drift/);
    refusals.push("missing-scope");
  } finally {
    fs.writeFileSync(pkg, packageBytes);
  }
  const newScope = join(dirname(fixture), "package.json");
  assert.equal(fs.existsSync(newScope), false);
  fs.writeFileSync(newScope, "{}");
  try {
    assert.throws(() => proof.check(), /package scope drift/);
    refusals.push("new-scope");
  } finally {
    fs.unlinkSync(newScope);
  }
  const source = join(fixture, "index.ts"),
    replacement = join(fixture, "replacement.ts");
  fs.renameSync(source, replacement);
  fs.symlinkSync(replacement, source);
  try {
    assert.throws(() => proof.check(), /source drift/);
    refusals.push("symlink");
  } finally {
    fs.unlinkSync(source);
    fs.renameSync(replacement, source);
  }
  assert.equal(proof.check(), true);
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      sources: refs.length,
      scopes: scopes.length,
      existingScopes: scopes.filter(([, value]) => value !== null).length,
      sourceBytes: measured.reduce((sum, ref) => sum + fs.statSync(ref.path).size, 0),
      graphDigest: digest(measured),
      scopesDigest: digest(scopes),
      sourceReads: measured
        .filter((ref) => !ref.path.endsWith("/package.json"))
        .reduce((sum, ref) => sum + reads.get(ref.path), 0),
      scopeReads: [...reads]
        .filter(([path]) => path.endsWith("/package.json"))
        .reduce(
          (sum, [path, count]) => sum + count - (measured.some((ref) => ref.path === path) ? 1 : 0),
          0,
        ),
      captureTraceDigest: digest(captureTrace),
      captureTraceLength: captureTrace.length,
      checkTraceDigest: digest(checkTrace),
      checkTraceLength: checkTrace.length,
      captureMs,
      checkMs,
      refusals,
    }),
  );
} else {
  const baseline = process.argv[2];
  assert.ok(baseline, "supply the unchanged baseline protection-source.mjs");
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pasa-compare-")));
  const fixture = join(root, "sandbox");
  try {
    fs.mkdirSync(fixture);
    for (const file of ["index.ts", "protection.ts", "pasa-extension.mjs", "package.json"])
      fs.copyFileSync(join(repo, file), join(fixture, file));
    fs.symlinkSync(join(repo, "node_modules"), join(fixture, "node_modules"));
    const results = [];
    for (const variant of [
      "baseline",
      "candidate",
      "baseline",
      "candidate",
      "baseline",
      "candidate",
    ]) {
      fs.copyFileSync(
        variant === "baseline" ? baseline : join(repo, "protection-source.mjs"),
        join(fixture, "protection-source.mjs"),
      );
      const stdout = execFileSync(
        process.execPath,
        [
          "--import",
          join(fixture, "protection-source.mjs"),
          fileURLToPath(import.meta.url),
          "--measure",
          fixture,
        ],
        { encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "inherit"] },
      );
      const result = { variant, ...JSON.parse(stdout.trim()) };
      if (results.length) {
        assert.deepEqual(result.refusals, results[0].refusals);
        for (const key of [
          "platform",
          "arch",
          "node",
          "sources",
          "scopes",
          "existingScopes",
          "sourceBytes",
          "graphDigest",
          "scopesDigest",
          "sourceReads",
          "scopeReads",
          "captureTraceDigest",
          "captureTraceLength",
          "checkTraceDigest",
          "checkTraceLength",
        ])
          assert.equal(result[key], results[0][key], key);
      }
      results.push(result);
      console.log(JSON.stringify(result));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
