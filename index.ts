/**
 * Based on https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
 * by Mario Zechner, used under the MIT License.
 *
 * Sandbox Extension - OS-level sandboxing for bash commands, plus path policy
 * enforcement for pi's read/write/edit tools, with interactive permission prompts.
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux). Also intercepts the read, write, and edit tools to
 * apply the same denyRead/denyWrite/allowWrite filesystem rules, which OS-level
 * sandboxing cannot cover (those tools run directly in Node.js, not in a
 * subprocess).
 *
 * When a block is triggered, the user is prompted to:
 *   (a) Abort (keep blocked)
 *   (b) Allow for this session only  — stored in memory, agent cannot access
 *   (c) Allow for this project       — written to .pi/sandbox.json
 *   (d) Allow for all projects       — written to ~/.pi/agent/sandbox.json
 *
 * What gets prompted vs. hard-blocked:
 *   - domains: prompted if not whitelisted nor explicitly denied
 *   - write: prompted if not whitelisted nor explicitly denied
 *   - read: always prompted (because denyRead is used for broad block, may want to punch holes)
 *
 * IMPORTANT — precedence for read:
 *   Read:  allowRead OVERRIDES denyRead (prompt grant adds to allowRead)
 *   Write: denyWrite OVERRIDES allowWrite (most-specific deny wins)
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json  (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["/Users", "/home"],
 *     "allowRead": [".", "~/.config", "~/.local", "Library"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";

interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
}

/**
 * Validate a parsed sandbox config object and throw a descriptive error if
 * any field has the wrong type.  Called after JSON.parse so that structural
 * issues surface immediately instead of being silently ignored.
 */
function validateConfig(raw: unknown, filePath: string): Partial<SandboxConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `Invalid sandbox config in "${filePath}": expected a JSON object at the top level.`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if ("enabled" in obj && typeof obj["enabled"] !== "boolean") {
    throw new Error(
      `Invalid sandbox config in "${filePath}": "enabled" must be a boolean, got ${JSON.stringify(obj["enabled"])}.`,
    );
  }

  if ("network" in obj) {
    const net = obj["network"];
    if (typeof net !== "object" || net === null || Array.isArray(net)) {
      throw new Error(`Invalid sandbox config in "${filePath}": "network" must be an object.`);
    }
    const netObj = net as Record<string, unknown>;
    for (const key of ["allowedDomains", "deniedDomains"] as const) {
      if (key in netObj && !Array.isArray(netObj[key])) {
        throw new Error(
          `Invalid sandbox config in "${filePath}": "network.${key}" must be an array.`,
        );
      }
      if (Array.isArray(netObj[key])) {
        for (const entry of netObj[key] as unknown[]) {
          if (typeof entry !== "string") {
            throw new Error(
              `Invalid sandbox config in "${filePath}": every entry in "network.${key}" must be a string, got ${JSON.stringify(entry)}.`,
            );
          }
        }
      }
    }
  }

  if ("filesystem" in obj) {
    const fs = obj["filesystem"];
    if (typeof fs !== "object" || fs === null || Array.isArray(fs)) {
      throw new Error(`Invalid sandbox config in "${filePath}": "filesystem" must be an object.`);
    }
    const fsObj = fs as Record<string, unknown>;
    for (const key of ["denyRead", "allowRead", "allowWrite", "denyWrite"] as const) {
      if (key in fsObj && !Array.isArray(fsObj[key])) {
        throw new Error(
          `Invalid sandbox config in "${filePath}": "filesystem.${key}" must be an array.`,
        );
      }
      if (Array.isArray(fsObj[key])) {
        for (const entry of fsObj[key] as unknown[]) {
          if (typeof entry !== "string") {
            throw new Error(
              `Invalid sandbox config in "${filePath}": every entry in "filesystem.${key}" must be a string, got ${JSON.stringify(entry)}.`,
            );
          }
        }
      }
    }
  }

  return raw as Partial<SandboxConfig>;
}

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
    // Allow Unix sockets (needed for SSH ControlMaster, etc.) and local
    // port binding by default so tools like git-over-SSH work out of the box.
    allowAllUnixSockets: true,
    allowLocalBinding: true,
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local", "Library"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    // Allow reading git config so `git` commands work without prompts.
    allowGitConfig: true,
  },
};

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const globalConfigPath = join(agentDir, "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};

  if (existsSync(globalConfigPath)) {
    const raw = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
    globalConfig = validateConfig(raw, globalConfigPath);
  }

  if (existsSync(projectConfigPath)) {
    const raw = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
    projectConfig = validateConfig(raw, projectConfigPath);
  }

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.network) {
    result.network = {
      // Merge array fields by concatenation
      allowedDomains: [
        ...(base.network?.allowedDomains ?? []),
        ...(overrides.network.allowedDomains ?? []),
      ],
      deniedDomains: [
        ...(base.network?.deniedDomains ?? []),
        ...(overrides.network.deniedDomains ?? []),
      ],
      // Scalar/optional fields: override takes precedence, fall back to base
      allowAllUnixSockets:
        overrides.network.allowAllUnixSockets ?? base.network?.allowAllUnixSockets,
      allowLocalBinding: overrides.network.allowLocalBinding ?? base.network?.allowLocalBinding,
      allowUnixSockets: [
        ...(base.network?.allowUnixSockets ?? []),
        ...(overrides.network.allowUnixSockets ?? []),
      ],
      allowMachLookup: [
        ...(base.network?.allowMachLookup ?? []),
        ...(overrides.network.allowMachLookup ?? []),
      ],
      httpProxyPort: overrides.network.httpProxyPort ?? base.network?.httpProxyPort,
      socksProxyPort: overrides.network.socksProxyPort ?? base.network?.socksProxyPort,
      mitmProxy: overrides.network.mitmProxy ?? base.network?.mitmProxy,
      parentProxy: overrides.network.parentProxy ?? base.network?.parentProxy,
    };
  }
  if (overrides.filesystem) {
    result.filesystem = {
      denyRead: [...(base.filesystem?.denyRead ?? []), ...(overrides.filesystem.denyRead ?? [])],
      allowRead: [...(base.filesystem?.allowRead ?? []), ...(overrides.filesystem.allowRead ?? [])],
      allowWrite: [
        ...(base.filesystem?.allowWrite ?? []),
        ...(overrides.filesystem.allowWrite ?? []),
      ],
      denyWrite: [...(base.filesystem?.denyWrite ?? []), ...(overrides.filesystem.denyWrite ?? [])],
      // allowGitConfig: override wins, fall back to base
      allowGitConfig: overrides.filesystem.allowGitConfig ?? base.filesystem?.allowGitConfig,
    };
  }

  const extOverrides = overrides as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations;
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
  }
  if (extOverrides.allowBrowserProcess !== undefined) {
    extResult.allowBrowserProcess = extOverrides.allowBrowserProcess;
  }

  return result;
}

// ── Domain helpers ────────────────────────────────────────────────────────────

function extractDomainsFromCommand(command: string): string[] {
  const urlRegex = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const domains = new Set<string>();
  let match;
  while ((match = urlRegex.exec(command)) !== null) {
    domains.add(match[1]);
  }
  return [...domains];
}

function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith("." + base);
  }
  return domain === pattern;
}

function domainIsAllowed(domain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((p) => domainMatchesPattern(domain, p));
}

// ── Output analysis ───────────────────────────────────────────────────────────

/** Extract a path from a bash "Operation not permitted" OS sandbox error. */
function extractBlockedWritePath(output: string): string | null {
  const match = output.match(/(?:\/bin\/bash|bash|sh): (\/[^\s:]+): Operation not permitted/);
  return match ? match[1] : null;
}

// ── Path pattern matching ─────────────────────────────────────────────────────

function matchesPattern(filePath: string, patterns: string[]): boolean {
  const expanded = filePath.replace(/^~/, homedir());
  const abs = resolve(expanded);
  return patterns.some((p) => {
    const expandedP = p.replace(/^~/, homedir());
    const absP = resolve(expandedP);
    if (p.includes("*")) {
      const escaped = absP.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(abs);
    }
    return abs === absP || abs.startsWith(absP + "/");
  });
}

// ── Config file updaters (Node.js process — not OS-sandboxed) ─────────────────

function getConfigPaths(cwd: string): {
  globalPath: string;
  projectPath: string;
} {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return {
    globalPath: join(agentDir, "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

function readOrEmptyConfig(configPath: string): Partial<SandboxConfig> {
  if (!existsSync(configPath)) return {};
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return validateConfig(raw, configPath);
}

function writeConfigFile(configPath: string, config: Partial<SandboxConfig>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function addDomainToConfig(configPath: string, domain: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.network?.allowedDomains ?? [];
  if (!existing.includes(domain)) {
    config.network = {
      ...config.network,
      allowedDomains: [...existing, domain],
      deniedDomains: config.network?.deniedDomains ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowRead ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowRead: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      allowWrite: config.filesystem?.allowWrite ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowWrite ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowWrite: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

// ── Sandboxed bash ops ────────────────────────────────────────────────────────

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let userDisabled = false; // set by /sandbox-disable; prevents session_start from re-enabling

  // Session-temporary allowances and denials — held in JS memory, not accessible by the agent.
  // These are added on top of whatever is in the config files.
  const sessionAllowedDomains: string[] = [];
  const sessionAllowedReadPaths: string[] = [];
  const sessionAllowedWritePaths: string[] = [];
  const sessionDeniedWritePaths: string[] = [];

  // ── Effective config helpers ────────────────────────────────────────────────

  function getEffectiveAllowedDomains(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.network?.allowedDomains ?? []), ...sessionAllowedDomains];
  }

  function getEffectiveAllowRead(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.filesystem?.allowRead ?? []), ...sessionAllowedReadPaths];
  }

  function getEffectiveAllowWrite(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.filesystem?.allowWrite ?? []), ...sessionAllowedWritePaths];
  }

  function getEffectiveDenyWrite(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.filesystem?.denyWrite ?? []), ...sessionDeniedWritePaths];
  }

  // ── Sandbox reinitialize ────────────────────────────────────────────────────
  // Called after granting a session/permanent allowance so the OS-level sandbox
  // picks up the new rules before the next bash subprocess starts.

  async function reinitializeSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    const config = loadConfig(cwd);
    try {
      await SandboxManager.reset();
      await SandboxManager.initialize({
        network: {
          ...config.network,
          allowedDomains: [...(config.network?.allowedDomains ?? []), ...sessionAllowedDomains],
          deniedDomains: config.network?.deniedDomains ?? [],
        },
        filesystem: {
          ...config.filesystem,
          denyRead: config.filesystem?.denyRead ?? [],
          allowRead: [...(config.filesystem?.allowRead ?? []), ...sessionAllowedReadPaths],
          allowWrite: [...(config.filesystem?.allowWrite ?? []), ...sessionAllowedWritePaths],
          denyWrite: [...(config.filesystem?.denyWrite ?? []), ...sessionDeniedWritePaths],
        },
        enableWeakerNetworkIsolation: true,
      });
    } catch (e) {
      console.error(`Warning: Failed to reinitialize sandbox: ${e}`);
    }
  }

  // ── UI prompts ──────────────────────────────────────────────────────────────

  async function promptDomainBlock(
    ctx: ExtensionContext,
    domain: string,
  ): Promise<"abort" | "session" | "project" | "global"> {
    if (!ctx.hasUI) return "abort";
    const choice = await ctx.ui.select(`🌐 Network blocked: "${domain}" is not in allowedDomains`, [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ]);
    if (!choice || choice.startsWith("Abort")) return "abort";
    if (choice.startsWith("Allow for this session")) return "session";
    if (choice.startsWith("Allow for this project")) return "project";
    return "global";
  }

  async function promptReadBlock(
    ctx: ExtensionContext,
    filePath: string,
  ): Promise<"abort" | "session" | "project" | "global"> {
    if (!ctx.hasUI) return "abort";
    const choice = await ctx.ui.select(`📖 Read blocked: "${filePath}" is not in allowRead`, [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ]);
    if (!choice || choice.startsWith("Abort")) return "abort";
    if (choice.startsWith("Allow for this session")) return "session";
    if (choice.startsWith("Allow for this project")) return "project";
    return "global";
  }

  async function promptWriteBlock(
    ctx: ExtensionContext,
    filePath: string,
  ): Promise<"abort" | "session" | "project" | "global"> {
    if (!ctx.hasUI) return "abort";
    const choice = await ctx.ui.select(`📝 Write blocked: "${filePath}" is not in allowWrite`, [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ]);
    if (!choice || choice.startsWith("Abort")) return "abort";
    if (choice.startsWith("Allow for this session")) return "session";
    if (choice.startsWith("Allow for this project")) return "project";
    return "global";
  }

  // ── Apply allowance choices ─────────────────────────────────────────────────

  async function applyDomainChoice(
    choice: "session" | "project" | "global",
    domain: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedDomains.includes(domain)) sessionAllowedDomains.push(domain);
    if (choice === "project") addDomainToConfig(projectPath, domain);
    if (choice === "global") addDomainToConfig(globalPath, domain);
    await reinitializeSandbox(cwd);
  }

  async function applyReadChoice(
    choice: "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedReadPaths.includes(filePath)) sessionAllowedReadPaths.push(filePath);
    if (choice === "project") addReadPathToConfig(projectPath, filePath);
    if (choice === "global") addReadPathToConfig(globalPath, filePath);
    await reinitializeSandbox(cwd);
  }

  async function applyWriteChoice(
    choice: "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedWritePaths.includes(filePath)) sessionAllowedWritePaths.push(filePath);
    if (choice === "project") addWritePathToConfig(projectPath, filePath);
    if (choice === "global") addWritePathToConfig(globalPath, filePath);
    await reinitializeSandbox(cwd);
  }

  // ── Bash tool — with write-block detection and retry ───────────────────────

  pi.registerTool({
    ...localBash,
    label: "bash (sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      const runBash = () => {
        if (!sandboxEnabled || !sandboxInitialized) {
          return localBash.execute(id, params, signal, onUpdate);
        }
        const sandboxedBash = createBashTool(localCwd, {
          operations: createSandboxedBashOps(),
        });
        return sandboxedBash.execute(id, params, signal, onUpdate);
      };

      const result = await runBash();

      // Post-execution: detect OS-level write block and offer to allow.
      if (sandboxEnabled && sandboxInitialized && ctx?.hasUI) {
        const outputText = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");

        const blockedPath = extractBlockedWritePath(outputText);
        if (blockedPath) {
          const choice = await promptWriteBlock(ctx, blockedPath);
          if (choice !== "abort") {
            await applyWriteChoice(choice, blockedPath, ctx.cwd);

            // Check if denyWrite would still block it even after allowing.
            const config = loadConfig(ctx.cwd);
            const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
            if (matchesPattern(blockedPath, config.filesystem?.denyWrite ?? [])) {
              ctx.ui.notify(
                `⚠️ "${blockedPath}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
                  `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
                "warning",
              );
              return result;
            }

            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `\n--- Write access granted for "${blockedPath}", retrying ---\n`,
                },
              ],
              details: {},
            });
            return runBash();
          }
        }
      }

      return result;
    },
  });

  // ── user_bash — network pre-check ──────────────────────────────────────────

  pi.on("user_bash", async (event, ctx) => {
    if (!sandboxEnabled || !sandboxInitialized) return;

    const domains = extractDomainsFromCommand(event.command);
    const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);

    for (const domain of domains) {
      if (!domainIsAllowed(domain, effectiveDomains)) {
        const choice = await promptDomainBlock(ctx, domain);
        if (choice === "abort") {
          return {
            result: {
              output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
              exitCode: 1,
              cancelled: false,
              truncated: false,
            },
          };
        }
        await applyDomainChoice(choice, domain, ctx.cwd);
      }
    }

    return { operations: createSandboxedBashOps() };
  });

  // ── tool_call — network pre-check for bash, path policy for read/write/edit

  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled || !sandboxEnabled) return;

    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    // Network pre-check for bash tool calls.
    if (sandboxEnabled && sandboxInitialized && isToolCallEventType("bash", event)) {
      const domains = extractDomainsFromCommand(event.input.command);
      const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);
      for (const domain of domains) {
        if (!domainIsAllowed(domain, effectiveDomains)) {
          const choice = await promptDomainBlock(ctx, domain);
          if (choice === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyDomainChoice(choice, domain, ctx.cwd);
        }
      }
    }

    // Path policy: read tool.
    //   - If the path is already in effectiveAllowRead, allow silently.
    //   - Otherwise always prompt, regardless of denyRead.
    //   - Granting (session or permanent) adds to allowRead, which overrides denyRead.
    //   - denyRead is never a hard-block on its own — it just sets the default
    //     denied state that the prompt can override.
    if (isToolCallEventType("read", event)) {
      const filePath = event.input.path;
      const effectiveAllowRead = getEffectiveAllowRead(ctx.cwd);

      if (!matchesPattern(filePath, effectiveAllowRead)) {
        const choice = await promptReadBlock(ctx, filePath);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: read access denied for "${filePath}"`,
          };
        }
        await applyReadChoice(choice, filePath, ctx.cwd);
        // Allowed — fall through, tool runs.
        return;
      }
    }

    // Path policy: write/edit — prompt for allowWrite, hard-block for denyWrite.
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = (event.input as { path: string }).path;
      const allowWrite = getEffectiveAllowWrite(ctx.cwd);
      const denyWrite = getEffectiveDenyWrite(ctx.cwd);

      if (allowWrite.length > 0 && !matchesPattern(path, allowWrite)) {
        const choice = await promptWriteBlock(ctx, path);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
          };
        }
        await applyWriteChoice(choice, path, ctx.cwd);

        // denyWrite takes precedence — warn if it would still block.
        if (matchesPattern(path, denyWrite)) {
          ctx.ui.notify(
            `⚠️ "${path}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
              `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
            "warning",
          );
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (also in denyWrite)`,
          };
        }

        // Allowed — fall through, tool runs.
        return;
      }

      if (matchesPattern(path, denyWrite)) {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        };
      }
    }
  });

  // ── sandbox:* event listeners ────────────────────────────────────────────────
  // Allow other extensions (e.g. pi-task-flow) to adjust sandbox rules at runtime
  // via the shared pi.events bus without touching config files.

  pi.events.on("sandbox:allow-write", (data) => {
    const { path } = data as { path: string };
    if (!sessionAllowedWritePaths.includes(path)) {
      sessionAllowedWritePaths.push(path);
    }
    reinitializeSandbox(localCwd).catch((e) =>
      console.error(`sandbox:allow-write reinitialize failed: ${e}`),
    );
  });

  pi.events.on("sandbox:deny-write", (data) => {
    const { path } = data as { path: string };
    if (!sessionDeniedWritePaths.includes(path)) {
      sessionDeniedWritePaths.push(path);
    }
    reinitializeSandbox(localCwd).catch((e) =>
      console.error(`sandbox:deny-write reinitialize failed: ${e}`),
    );
  });

  pi.events.on("sandbox:allow-read", (data) => {
    const { path } = data as { path: string };
    if (!sessionAllowedReadPaths.includes(path)) {
      sessionAllowedReadPaths.push(path);
    }
    reinitializeSandbox(localCwd).catch((e) =>
      console.error(`sandbox:allow-read reinitialize failed: ${e}`),
    );
  });

  pi.events.on("sandbox:reset-session", () => {
    sessionAllowedDomains.length = 0;
    sessionAllowedReadPaths.length = 0;
    sessionAllowedWritePaths.length = 0;
    sessionDeniedWritePaths.length = 0;
    reinitializeSandbox(localCwd).catch((e) =>
      console.error(`sandbox:reset-session reinitialize failed: ${e}`),
    );
  });

  // ── session_start ───────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const noSandbox = pi.getFlag("no-sandbox") as boolean;

    if (noSandbox) {
      sandboxEnabled = false;
      ctx.ui.setStatus("sandbox", "🔒 Sandbox: off");
      ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
      return;
    }

    if (userDisabled) {
      sandboxEnabled = false;
      ctx.ui.setStatus("sandbox", "🔒 Sandbox: off");
      ctx.ui.notify("Sandbox disabled (user override active)", "warning");
      return;
    }

    let config: SandboxConfig;
    try {
      config = loadConfig(ctx.cwd);
    } catch (err) {
      sandboxEnabled = false;
      ctx.ui.setStatus("sandbox", "🔒 Sandbox: off");
      ctx.ui.notify(
        `Sandbox config error — sandbox disabled: ${err instanceof Error ? err.message : err}`,
        "error",
      );
      return;
    }

    if (!config.enabled) {
      sandboxEnabled = false;
      ctx.ui.setStatus("sandbox", "🔒 Sandbox: off");
      ctx.ui.notify("Sandbox disabled via config", "warning");
      return;
    }

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      sandboxEnabled = false;
      ctx.ui.setStatus("sandbox", "🔒 Sandbox: off");
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return;
    }

    try {
      const configExt = config as unknown as {
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNestedSandbox?: boolean;
      };

      await SandboxManager.initialize({
        network: config.network,
        filesystem: config.filesystem,
        ignoreViolations: configExt.ignoreViolations,
        enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
        enableWeakerNetworkIsolation: true,
      });

      // Make Node's built-in fetch() honour HTTP_PROXY / HTTPS_PROXY in this
      // process and any child processes that inherit the environment.
      // undici (which powers globalThis.fetch) ignores proxy env vars by default;
      // --use-env-proxy (Node 22+) opts it in. We set this here so that node
      // subprocesses spawned directly from bash (e.g. `node script.ts`) also
      // pick it up without needing to go through wrapWithSandbox.
      const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
      if (nodeMajor >= 22) {
        const existing = process.env.NODE_OPTIONS ?? "";
        process.env.NODE_OPTIONS = existing ? `${existing} --use-env-proxy` : "--use-env-proxy";
      }

      sandboxEnabled = true;
      sandboxInitialized = true;

      const networkCount = config.network?.allowedDomains?.length ?? 0;
      const writeCount = config.filesystem?.allowWrite?.length ?? 0;
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
      );
    } catch (err) {
      sandboxEnabled = false;
      ctx.ui.setStatus("sandbox", "🔒 Sandbox: off");
      ctx.ui.notify(
        `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  });

  // ── session_shutdown ────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ── /sandbox command ────────────────────────────────────────────────────────

  pi.registerCommand("sandbox-enable", {
    description: "Enable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (sandboxEnabled) {
        ctx.ui.notify("Sandbox is already enabled", "info");
        return;
      }

      let config: SandboxConfig;
      try {
        config = loadConfig(ctx.cwd);
      } catch (err) {
        ctx.ui.notify(
          `Sandbox config error — cannot enable: ${err instanceof Error ? err.message : err}`,
          "error",
        );
        return;
      }

      const platform = process.platform;
      if (platform !== "darwin" && platform !== "linux") {
        ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
        return;
      }

      try {
        const configExt = config as unknown as {
          ignoreViolations?: Record<string, string[]>;
          enableWeakerNestedSandbox?: boolean;
        };

        await SandboxManager.initialize({
          network: config.network,
          filesystem: config.filesystem,
          ignoreViolations: configExt.ignoreViolations,
          enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
          enableWeakerNetworkIsolation: true,
        });

        sandboxEnabled = true;
        sandboxInitialized = true;
        userDisabled = false;

        const networkCount = config.network?.allowedDomains?.length ?? 0;
        const writeCount = config.filesystem?.allowWrite?.length ?? 0;
        ctx.ui.setStatus(
          "sandbox",
          ctx.ui.theme.fg(
            "accent",
            `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`,
          ),
        );
        ctx.ui.notify("Sandbox enabled", "info");
      } catch (err) {
        ctx.ui.notify(
          `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("sandbox-disable", {
    description: "Disable the sandbox for this session",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is already disabled", "info");
        return;
      }

      if (sandboxInitialized) {
        try {
          await SandboxManager.reset();
        } catch {
          // Ignore cleanup errors
        }
      }

      sandboxEnabled = false;
      sandboxInitialized = false;
      userDisabled = true;
      ctx.ui.setStatus("sandbox", "🔒 Sandbox: off");
      ctx.ui.notify("Sandbox disabled", "warning");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox configuration",
    handler: async (_args, ctx) => {
      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }

      const config = loadConfig(ctx.cwd);
      const { globalPath, projectPath } = getConfigPaths(ctx.cwd);

      const lines = [
        "Sandbox Configuration",
        `  Project config: ${projectPath}`,
        `  Global config:  ${globalPath}`,
        "",
        "Network (bash + !cmd):",
        `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        ...(sessionAllowedDomains.length > 0
          ? [`  Session allowed: ${sessionAllowedDomains.join(", ")}`]
          : []),
        "",
        "Filesystem (bash + read/write/edit tools):",
        `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        ...(sessionAllowedReadPaths.length > 0
          ? [`  Session read:  ${sessionAllowedReadPaths.join(", ")}`]
          : []),
        ...(sessionAllowedWritePaths.length > 0
          ? [`  Session write: ${sessionAllowedWritePaths.join(", ")}`]
          : []),
        "",
        "Note: ALL reads are prompted unless the path is already in allowRead.",
        "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
        "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
