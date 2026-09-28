import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import extension from "../pasa-extension.mjs";

const CHANNEL = "pasa:protection:snapshot:v1";
const original = {
  initialize: SandboxManager.initialize,
  reset: SandboxManager.reset,
  wrapWithSandbox: SandboxManager.wrapWithSandbox,
  getConfig: SandboxManager.getConfig,
};
const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let managerConfig;
let initialize = async (config) => {
  managerConfig = config;
};

async function fixture(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pasa-sandbox-")));
  const cwd = join(root, "parent");
  const target = join(root, "child");
  mkdirSync(cwd);
  mkdirSync(target);
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  initialize = async (config) => {
    managerConfig = config;
  };
  SandboxManager.initialize = (...args) => initialize(...args);
  SandboxManager.reset = async () => {
    managerConfig = undefined;
  };
  SandboxManager.wrapWithSandbox = async () => "true"; // lifecycle unit tests only
  SandboxManager.getConfig = () => managerConfig;
  const hooks = new Map(),
    bus = new Map(),
    commands = new Map(),
    tools = new Map();
  let currentSession = "session-one",
    noSandbox = false;
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => currentSession },
    ui: { setStatus() {}, notify() {}, theme: { fg: (_color, text) => text } },
  };
  extension({
    on: (name, fn) => hooks.set(name, fn),
    events: { on: (name, fn) => bus.set(name, fn) },
    registerFlag() {},
    getFlag: () => noSandbox,
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, value) => commands.set(name, value),
  });
  function snapshot(overrides = {}) {
    const replies = [];
    const request = {
      version: 1,
      requestId: crypto.randomUUID(),
      protectionId: "pi-agent-sandbox",
      expectedSessionId: currentSession,
      targetCwd: cwd,
      respond: (reply) => replies.push(reply),
      ...overrides,
    };
    bus.get(CHANNEL)(request);
    assert.equal(replies.length, 1);
    return replies[0];
  }
  try {
    await run({
      cwd,
      target,
      root,
      ctx,
      hooks,
      bus,
      tools,
      commands,
      snapshot,
      start: () => hooks.get("session_start")({}, ctx),
      session: (id) => {
        currentSession = id;
      },
      disable: () => {
        noSandbox = true;
      },
    });
  } finally {
    await hooks.get("session_shutdown")();
    Object.assign(SandboxManager, original);
    process.chdir(originalCwd);
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}

test("actual extension: ready is bound, read-only, sanitized, and independently reproducible in target cwd", async () =>
  fixture(async (f) => {
    assert.equal(f.snapshot().reason, "NOT_INITIALIZED");
    await f.start();
    const ready = f.snapshot();
    assert.equal(ready.status, "ready", JSON.stringify(ready));
    assert.equal(ready.binding.sessionId, "session-one");
    assert.equal(ready.binding.cwd, f.cwd);
    assert.ok(ready.codeFiles.some((ref) => ref.path.endsWith("/index.ts")));
    assert.ok(ready.codeFiles.some((ref) => ref.path.endsWith("/sandbox/sandbox-manager.js")));
    assert.ok(ready.codeFiles.some((ref) => ref.path.endsWith("/sandbox/macos-sandbox-utils.js")));
    assert.equal(f.snapshot().binding.generation, ready.binding.generation);
    assert.equal(f.snapshot({ expectedSessionId: "wrong" }).reason, "SESSION_MISMATCH");
    const child = f.snapshot({ targetCwd: f.target });
    assert.equal(child.status, "ready");
    assert.equal(child.binding.cwd, f.cwd);
    assert.equal(child.replay.verifiedCwd, f.target);
    assert.notEqual(child.replay.stateDigest, ready.stateDigest);
    process.chdir(f.target);
    f.ctx.cwd = f.target;
    f.session("child-session");
    await f.start();
    const actualChild = f.snapshot({ targetCwd: f.target });
    // Each real instance retains its original bash cwd, so create a fresh one for children.
    assert.equal(actualChild.reason, "CWD_UNREPRODUCIBLE");
  }));

test("startup OS failure never returns ready or raw errors", async () =>
  fixture(async (f) => {
    initialize = async () => {
      throw new Error("credential-SENTINEL");
    };
    await f.start();
    assert.equal(f.snapshot().reason, "INITIALIZATION_FAILED");
    assert.ok(!JSON.stringify(f.snapshot()).includes("SENTINEL"));
  }));

test("pending initialization and stale completion after shutdown cannot certify readiness", async () =>
  fixture(async (f) => {
    let release;
    initialize = (config) =>
      new Promise((resolve) => {
        managerConfig = config;
        release = resolve;
      });
    const starting = f.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.snapshot().reason, "NOT_INITIALIZED");
    const stopping = f.hooks.get("session_shutdown")();
    release();
    await starting;
    await stopping;
    assert.equal(f.snapshot().reason, "NOT_INITIALIZED");
  }));

test("session replacement increments generation and rejects stale session; shutdown revokes", async () =>
  fixture(async (f) => {
    await f.start();
    const first = f.snapshot();
    f.session("replacement");
    assert.equal(f.snapshot().reason, "SESSION_MISMATCH");
    await f.start();
    const next = f.snapshot();
    assert.equal(next.status, "ready");
    assert.ok(next.binding.generation > first.binding.generation);
    await f.hooks.get("session_shutdown")();
    assert.equal(f.snapshot().reason, "NOT_INITIALIZED");
  }));

for (const event of ["allow-write", "deny-write", "allow-read", "reset-session"]) {
  test(`runtime ${event} stays unsupported after reinitialization and reset`, async () =>
    fixture(async (f) => {
      await f.start();
      f.bus.get(`sandbox:${event}`)({ path: join(f.cwd, "grant") });
      assert.equal(f.snapshot().reason, "NOT_INITIALIZED");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(f.snapshot().reason, "RUNTIME_MUTATION");
      f.bus.get("sandbox:reset-session")();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(f.snapshot().reason, "RUNTIME_MUTATION");
    }));
}

test("pending and failed reinitialization cannot reuse old readiness or run unsandboxed bash", async () =>
  fixture(async (f) => {
    await f.start();
    let reject;
    initialize = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    f.bus.get("sandbox:allow-write")({ path: f.cwd });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.snapshot().reason, "NOT_INITIALIZED");
    await assert.rejects(
      f.tools.get("bash").execute("id", { command: "true" }, undefined, undefined, f.ctx),
      /not initialized/,
    );
    reject(new Error("secret"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.snapshot().reason, "INITIALIZATION_FAILED");
  }));

test("new/edited config files and environment drift are refused", async () =>
  fixture(async (f) => {
    await f.start();
    mkdirSync(join(f.cwd, ".pi"));
    const path = join(f.cwd, ".pi", "sandbox.json");
    writeFileSync(path, "{}");
    assert.equal(f.snapshot().reason, "CONFIG_DRIFT");
    rmSync(path);
    assert.equal(f.snapshot().status, "ready");
    process.env.PI_CODING_AGENT_DIR += "-changed";
    assert.equal(f.snapshot().reason, "CONFIG_DRIFT");
  }));

test("target new/changed config and invalid cwd are refused without parent mutation", async () =>
  fixture(async (f) => {
    await f.start();
    const before = f.snapshot();
    mkdirSync(join(f.target, ".pi"));
    writeFileSync(join(f.target, ".pi", "sandbox.json"), "{}");
    assert.equal(f.snapshot({ targetCwd: f.target }).reason, "CWD_UNREPRODUCIBLE");
    writeFileSync(
      join(f.target, ".pi", "sandbox.json"),
      JSON.stringify({ filesystem: { allowWrite: ["/extra"] } }),
    );
    assert.equal(f.snapshot({ targetCwd: f.target }).reason, "CWD_UNREPRODUCIBLE");
    assert.equal(f.snapshot().stateDigest, before.stateDigest);
    assert.equal(f.snapshot().binding.generation, before.binding.generation);
  }));

test("toggle and disabled flag never certify readiness", async () =>
  fixture(async (f) => {
    f.disable();
    await f.start();
    assert.equal(f.snapshot().reason, "DISABLED");
  }));

test("toggle off/on is permanently runtime-mutated for this instance", async () =>
  fixture(async (f) => {
    await f.start();
    await f.commands.get("sandbox-toggle").handler("", f.ctx);
    assert.equal(f.snapshot().reason, "DISABLED");
    await f.commands.get("sandbox-toggle").handler("", f.ctx);
    assert.equal(f.snapshot().reason, "RUNTIME_MUTATION");
  }));

test("one request ID yields at most one response; wrong protection is ignored", async () =>
  fixture(async (f) => {
    let count = 0;
    const request = {
      version: 1,
      requestId: "one",
      protectionId: "pi-agent-sandbox",
      expectedSessionId: "session-one",
      targetCwd: f.cwd,
      respond: () => count++,
    };
    f.bus.get(CHANNEL)(request);
    f.bus.get(CHANNEL)(request);
    f.bus.get(CHANNEL)({ ...request });
    assert.equal(count, 1);
    f.bus.get(CHANNEL)({ ...request, protectionId: "pi-agent-guard" });
    assert.equal(count, 1);
  }));

test("source drift includes the loaded transitive protection module", async () =>
  fixture(async (f) => {
    await f.start();
    const ready = f.snapshot();
    assert.equal(ready.status, "ready");
    const ref = ready.codeFiles.find((ref) => ref.path.endsWith("/protection.ts"));
    const before = readFileSync(ref.path);
    try {
      writeFileSync(ref.path, Buffer.concat([before, Buffer.from("\n// drift\n")]));
      assert.equal(f.snapshot().reason, "CONFIG_DRIFT");
    } finally {
      writeFileSync(ref.path, before);
    }
  }));

test("kernel profile launch failure refuses even after manager initialize succeeds", async () =>
  fixture(async (f) => {
    SandboxManager.wrapWithSandbox = async () => "false";
    await f.start();
    assert.equal(f.snapshot().reason, "INITIALIZATION_FAILED");
  }));

test("interactive session and permanent grants invalidate file-backed replay", async () => {
  for (const choice of ["Allow for this session only", "Allow for this project"]) {
    await fixture(async (f) => {
      await f.start();
      f.ctx.hasUI = true;
      f.ctx.ui.select = async () => choice;
      await f.hooks.get("tool_call")(
        { toolName: "read", input: { path: "/pasa-outside-read" } },
        f.ctx,
      );
      assert.equal(f.snapshot().reason, "RUNTIME_MUTATION");
    });
  }
});

test("external manager config mutation and credential-backed configs are refused", async () =>
  fixture(async (f) => {
    await f.start();
    managerConfig = { ...managerConfig, filesystem: { allowWrite: ["/"] } };
    assert.equal(f.snapshot().reason, "RUNTIME_MUTATION");
    mkdirSync(join(f.cwd, ".pi"));
    writeFileSync(
      join(f.cwd, ".pi", "sandbox.json"),
      JSON.stringify({
        network: { parentProxy: { http: "http://user:credential-SENTINEL@localhost" } },
      }),
    );
    await f.start();
    const result = f.snapshot();
    assert.equal(result.reason, "UNBACKED_CONFIGURATION");
    assert.ok(!JSON.stringify(result).includes("SENTINEL"));
  }));

test("target must be canonical and existing; generation changes cannot be completed by stale init", async () =>
  fixture(async (f) => {
    await f.start();
    assert.equal(f.snapshot({ targetCwd: join(f.root, "missing") }).reason, "CWD_UNREPRODUCIBLE");
    assert.equal(f.snapshot({ targetCwd: f.target + "/.." }).reason, "CWD_UNREPRODUCIBLE");
    let release;
    initialize = (config) =>
      new Promise((resolve) => {
        managerConfig = config;
        release = resolve;
      });
    const first = f.start();
    await new Promise((resolve) => setImmediate(resolve));
    f.session("new-session");
    const second = f.start();
    initialize = async (config) => {
      managerConfig = config;
    };
    release();
    await first;
    await second;
    assert.equal(f.snapshot().status, "ready");
    assert.equal(f.snapshot().binding.sessionId, "new-session");
  }));

test("file targets and configuration changes during initialization refuse readiness", async () =>
  fixture(async (f) => {
    await f.start();
    const file = join(f.root, "not-a-directory");
    writeFileSync(file, "data");
    assert.equal(f.snapshot({ targetCwd: file }).reason, "CWD_UNREPRODUCIBLE");
    let release;
    initialize = (config) =>
      new Promise((resolve) => {
        managerConfig = config;
        release = resolve;
      });
    const starting = f.start();
    await new Promise((resolve) => setImmediate(resolve));
    mkdirSync(join(f.cwd, ".pi"));
    writeFileSync(join(f.cwd, ".pi", "sandbox.json"), "{}");
    release();
    await starting;
    assert.equal(f.snapshot().reason, "CONFIG_DRIFT");
  }));
