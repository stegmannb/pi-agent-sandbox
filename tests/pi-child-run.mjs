import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const [entry, sdkPath, cwd, agentDir, mode] = process.argv.slice(2);
process.chdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
const sdk = await import(sdkPath ? pathToFileURL(sdkPath).href : "@mariozechner/pi-coding-agent");
process.env.PASA_SANDBOX_PI_ENTRY =
  sdkPath || fileURLToPath(import.meta.resolve("@mariozechner/pi-coding-agent"));
const { SandboxManager } = await import(
  pathToFileURL(createRequire(entry).resolve("@anthropic-ai/sandbox-runtime")).href
);
if (mode === "mock") {
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
const events = sdk.createEventBus();
const settingsManager = sdk.SettingsManager.inMemory({});
const loader = new sdk.DefaultResourceLoader({
  cwd,
  agentDir,
  eventBus: events,
  additionalExtensionPaths: [entry],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  settingsManager,
});
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error("extension load failed");
const sessionManager = sdk.SessionManager.inMemory(cwd);
const { session } = await sdk.createAgentSession({
  cwd,
  agentDir,
  resourceLoader: loader,
  sessionManager,
  settingsManager,
  authStorage: sdk.AuthStorage.inMemory(),
});
try {
  await session.bindExtensions({});
  const replies = [];
  events.emit("pasa:protection:snapshot:v1", {
    version: 1,
    requestId: crypto.randomUUID(),
    protectionId: "pi-agent-sandbox",
    expectedSessionId: sessionManager.getSessionId(),
    targetCwd: cwd,
    respond: (r) => replies.push(r),
  });
  if (replies.length !== 1) throw new Error("missing/duplicate reply");
  console.log(JSON.stringify(replies[0]));
} finally {
  session.dispose();
  await SandboxManager.reset();
}
