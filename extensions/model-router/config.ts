import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelCandidate, RouterConfig } from "./types";

const DEFAULT_MODELS: ModelCandidate[] = [
  {
    model: "anthropic/claude-sonnet-4-5",
    strengths: ["architecture", "planning", "coding", "debugging", "review", "tool-use"],
    quality: 0.92,
    cost: 0.45,
    latency: 0.55,
    supports: { images: true, reasoning: true, tools: true },
    thinking: "medium",
  },
  {
    model: "google/gemini-flash-latest",
    strengths: ["summary", "lookup", "coding", "fast"],
    quality: 0.68,
    cost: 0.95,
    latency: 0.9,
    supports: { images: true, reasoning: true, tools: true },
    thinking: "low",
  },
];

export const DEFAULT_CONFIG: RouterConfig = {
  enabled: true,
  debug: false,
  defaultProfile: "auto",
  classifierModel: { model: "google/gemini-flash-latest", thinking: "off" },
  defaultModel: "anthropic/claude-sonnet-4-5",
  profiles: {
    auto: {
      defaultModel: "anthropic/claude-sonnet-4-5",
      models: DEFAULT_MODELS,
    },
  },
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(raw: unknown, filePath: string): Partial<RouterConfig> {
  if (!isObject(raw)) {
    throw new Error(`Invalid model-router config in ${filePath}: expected an object.`);
  }
  if ("enabled" in raw && typeof raw.enabled !== "boolean") {
    throw new Error(`Invalid model-router config in ${filePath}: enabled must be boolean.`);
  }
  if ("classifierModel" in raw) {
    if (!isObject(raw.classifierModel) || typeof raw.classifierModel.model !== "string") {
      throw new Error(
        `Invalid model-router config in ${filePath}: classifierModel.model must be a string.`,
      );
    }
  }
  if ("defaultModel" in raw && typeof raw.defaultModel !== "string") {
    throw new Error(`Invalid model-router config in ${filePath}: defaultModel must be string.`);
  }
  if ("profiles" in raw) {
    if (!isObject(raw.profiles)) {
      throw new Error(`Invalid model-router config in ${filePath}: profiles must be an object.`);
    }
    for (const [name, profile] of Object.entries(raw.profiles)) {
      if (!isObject(profile) || !Array.isArray(profile.models)) {
        throw new Error(
          `Invalid model-router config in ${filePath}: profiles.${name}.models must be an array.`,
        );
      }
      for (const candidate of profile.models) {
        if (!isObject(candidate) || typeof candidate.model !== "string") {
          throw new Error(
            `Invalid model-router config in ${filePath}: every candidate needs a model string.`,
          );
        }
      }
    }
  }
  return raw as Partial<RouterConfig>;
}

function mergeConfig(base: RouterConfig, override: Partial<RouterConfig>): RouterConfig {
  return {
    ...base,
    ...override,
    classifierModel: {
      ...base.classifierModel,
      ...override.classifierModel,
    },
    profiles: {
      ...base.profiles,
      ...override.profiles,
    },
  };
}

export function getConfigPaths(cwd: string): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return [join(agentDir, "model-router.json"), join(cwd, ".pi", "model-router.json")];
}

export function loadRouterConfig(cwd: string): RouterConfig {
  let config = DEFAULT_CONFIG;
  for (const path of getConfigPaths(cwd)) {
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    config = mergeConfig(config, validateConfig(raw, path));
  }
  return config;
}

export function parseModelRef(ref: string): { provider: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`Model reference must be provider/model, got: ${ref}`);
  }
  return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
