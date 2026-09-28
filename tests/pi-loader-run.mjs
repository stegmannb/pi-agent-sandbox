// Separate process: exercise the actual SDK ResourceLoader and kernel sandbox.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = realpathSync(mkdtempSync(join(tmpdir(), "pasa-real-os-")));
const previousCwd = process.cwd();
const parent = join(root, "parent"),
  child = join(root, "child");
mkdirSync(parent);
mkdirSync(child);
if (process.argv.includes("--project-config")) {
  for (const cwd of [parent, child]) {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(
      join(cwd, ".pi", "sandbox.json"),
      JSON.stringify({ filesystem: { allowWrite: ["./relative-output"] } }),
    );
  }
}
process.chdir(parent);
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const sdk = await import(
  process.env.PASA_PI_MODULE
    ? pathToFileURL(process.env.PASA_PI_MODULE).href
    : "@mariozechner/pi-coding-agent"
);
process.env.PASA_SANDBOX_PI_ENTRY =
  process.env.PASA_PI_MODULE ?? fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"));
const entry =
  process.env.PASA_SANDBOX_ENTRY ??
  fileURLToPath(new URL("../pasa-extension.mjs", import.meta.url));
if (process.argv.includes("--failed-native-fallback"))
  process.env.PASA_SANDBOX_PI_ENTRY = join(root, "missing-sdk.js");
const { SandboxManager } = await import(
  pathToFileURL(createRequire(entry).resolve("@anthropic-ai/sandbox-runtime")).href
);
const mocked = process.argv.includes("--mock-os");
if (mocked) {
  let config;
  SandboxManager.initialize = async (value) => {
    config = value;
  };
  SandboxManager.getConfig = () => config;
  SandboxManager.reset = async () => {
    config = undefined;
  };
  SandboxManager.wrapWithSandbox = async () => "true";
}
const agentDir = process.env.PI_CODING_AGENT_DIR;
const events = sdk.createEventBus();
const loader = new sdk.DefaultResourceLoader({
  cwd: parent,
  agentDir,
  eventBus: events,
  additionalExtensionPaths: [entry],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  settingsManager: sdk.SettingsManager.inMemory({}),
});
let session;
try {
  await loader.reload();
  const loaded = loader.getExtensions();
  if (process.argv.includes("--failed-native-fallback") && loaded.errors.length) {
    assert.equal(loaded.extensions.length, 0);
    const replies = [];
    events.emit("pasa:protection:snapshot:v1", {
      version: 1,
      requestId: crypto.randomUUID(),
      protectionId: "pi-agent-sandbox",
      expectedSessionId: "uninitialized",
      targetCwd: parent,
      respond: (reply) => replies.push(reply),
    });
    assert.deepEqual(replies, []);
    console.log(JSON.stringify({ ok: true, failedNativeLoadCannotCertify: true }));
  } else {
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.equal(loaded.extensions[0].path, entry);
    const sessionManager = sdk.SessionManager.inMemory(parent);
    const result = await sdk.createAgentSession({
      cwd: parent,
      agentDir,
      resourceLoader: loader,
      sessionManager,
      settingsManager: sdk.SettingsManager.inMemory({}),
      authStorage: sdk.AuthStorage.inMemory(),
    });
    session = result.session;
    await session.bindExtensions({});
    const snapshot = (targetCwd = parent) => {
      const replies = [];
      events.emit("pasa:protection:snapshot:v1", {
        version: 1,
        requestId: crypto.randomUUID(),
        protectionId: "pi-agent-sandbox",
        expectedSessionId: sessionManager.getSessionId(),
        targetCwd,
        respond: (r) => replies.push(r),
      });
      assert.equal(replies.length, 1);
      return replies[0];
    };
    const ready = snapshot();
    if (process.argv.includes("--expect-unbacked")) {
      assert.equal(ready.reason, "UNBACKED_CONFIGURATION");
      console.log(JSON.stringify({ ok: true, unknownClosureRefused: true }));
    } else {
      assert.equal(ready.status, "ready", JSON.stringify(ready));
      assert.equal(ready.binding.cwd, parent);
      assert.ok(ready.codeFiles.some((ref) => ref.path.endsWith("/sandbox/sandbox-manager.js")));
      assert.ok(
        ready.codeFiles.some((ref) => ref.path === realpathSync(process.env.PASA_SANDBOX_PI_ENTRY)),
      );
      assert.equal(snapshot(child).status, "ready");
      const replay = snapshot(child);
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          join(dirname(entry), "protection-source.mjs"),
          fileURLToPath(new URL("./pi-child-run.mjs", import.meta.url)),
          entry,
          process.env.PASA_PI_MODULE ?? "",
          child,
          agentDir,
          mocked ? "mock" : "real",
        ],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      );
      const childReady = JSON.parse(stdout);
      assert.equal(childReady.status, "ready", stdout);
      assert.equal(childReady.binding.cwd, child);
      assert.notEqual(childReady.binding.sessionId, ready.binding.sessionId);
      assert.equal(childReady.stateDigest, replay.replay.stateDigest);
      assert.deepEqual(childReady.codeFiles, ready.codeFiles);
      assert.deepEqual(
        childReady.configurationFiles,
        ready.configurationFiles.map((ref) => ({
          ...ref,
          path:
            ref.path === join(parent, ".pi", "sandbox.json")
              ? join(child, ".pi", "sandbox.json")
              : ref.path,
        })),
      );
      assert.deepEqual(childReady.environment, ready.environment);
      assert.equal(snapshot().stateDigest, ready.stateDigest);
      assert.equal(snapshot().binding.generation, ready.binding.generation);
      if (!mocked) {
        // Exercise actual OS denial using the initialized manager, without a model.
        const denied = join(parent, ".env");
        const wrapped = await SandboxManager.wrapWithSandbox(`printf forbidden > '${denied}'`);
        await assert.rejects(
          promisify(execFile)("bash", ["-c", wrapped], { cwd: parent, timeout: 10000 }),
        );
        assert.equal(existsSync(denied), false);
        const allowed = join(parent, "allowed.txt");
        const write = await SandboxManager.wrapWithSandbox(`printf allowed > '${allowed}'`);
        await promisify(execFile)("bash", ["-c", write], { cwd: parent, timeout: 10000 });
        assert.ok(existsSync(allowed));
      }
      mkdirSync(join(child, ".pi"), { recursive: true });
      writeFileSync(join(child, ".pi", "sandbox.json"), "{}");
      assert.equal(snapshot(child).reason, "CWD_UNREPRODUCIBLE");
      assert.equal(snapshot().status, "ready");
      console.log(
        JSON.stringify({
          ok: true,
          loadedEntry: entry,
          sourceFiles: ready.codeFiles.length,
          os: process.platform,
          realOS: !mocked,
          childParity: true,
          sessionId: ready.binding.sessionId,
        }),
      );
    }
  }
} finally {
  if (session) await session.dispose();
  await SandboxManager.reset();
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
}
