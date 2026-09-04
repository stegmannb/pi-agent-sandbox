import { homedir } from "node:os";
import { resolve } from "node:path";

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
}

/**
 * Validate a parsed sandbox config object and throw a descriptive error if
 * any field has the wrong type. Called after JSON.parse so that structural
 * issues surface immediately instead of being silently ignored.
 */
export function validateConfig(raw: unknown, filePath: string): Partial<SandboxConfig> {
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

export function createDefaultConfig(): SandboxConfig {
  return {
    enabled: true,
    // allowedDomains/deniedDomains intentionally omitted: runtime proxy not
    // injected → unrestricted network. Unix socket and local-binding rules
    // are still enforced via the OS profile.
    network: {
      allowAllUnixSockets: true,
      allowLocalBinding: true,
    } as any,
    filesystem: {
      denyRead: ["/Users", "/home"],
      allowRead: [".", "~/.config", "~/.local", "Library"],
      allowWrite: [".", "/tmp"],
      denyWrite: [".env", ".env.*", "*.pem", "*.key"],
      // Allow reading git config so `git` commands work without prompts.
      allowGitConfig: true,
    },
  };
}

export function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.network) {
    result.network = {
      // allowedDomains/deniedDomains intentionally omitted → unrestricted network
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
    } as any;
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
    enableWeakerNetworkIsolation?: boolean;
    allowBrowserProcess?: boolean;
  };
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    enableWeakerNetworkIsolation?: boolean;
    allowBrowserProcess?: boolean;
  };

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations;
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
  }
  if (extOverrides.enableWeakerNetworkIsolation !== undefined) {
    extResult.enableWeakerNetworkIsolation = extOverrides.enableWeakerNetworkIsolation;
  }
  if (extOverrides.allowBrowserProcess !== undefined) {
    extResult.allowBrowserProcess = extOverrides.allowBrowserProcess;
  }

  return result;
}

export function matchesPattern(filePath: string, patterns: string[]): boolean {
  const expanded = filePath.replace(/^~/, homedir());
  const abs = resolve(expanded);
  return patterns.some((pattern) => {
    const expandedPattern = pattern.replace(/^~/, homedir());
    const absolutePattern = resolve(expandedPattern);
    if (pattern.includes("*")) {
      const escaped = absolutePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(abs);
    }
    return abs === absolutePattern || abs.startsWith(`${absolutePattern}/`);
  });
}
