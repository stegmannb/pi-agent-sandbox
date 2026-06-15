import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadRouterConfig, parseModelRef } from "./config";
import { classifyRequest } from "./classifier";
import { selectModel } from "./selector";
import type { RouterConfig, RoutingDecision } from "./types";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part)
        return String((part as any).text ?? "");
      if (part && typeof part === "object" && "thinking" in part) {
        return String((part as any).thinking ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function getRecentContextSummary(ctx: ExtensionContext, limit = 6): string {
  const entries = ((ctx.sessionManager as any)?.getBranch?.() ?? []) as Array<any>;
  return entries
    .filter((entry) => entry?.type === "message" && entry.message)
    .slice(-limit)
    .map((entry) => {
      const message = entry.message;
      const text = textFromContent(message.content).trim().replace(/\s+/g, " ");
      return text ? `${message.role}: ${text.slice(0, 500)}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function formatDecision(decision: RoutingDecision | undefined): string {
  if (!decision) return "No routing decision yet.";
  const top = decision.candidates
    .slice(0, 5)
    .map(
      (candidate, idx) =>
        `  ${idx + 1}. ${candidate.model} — ${candidate.score.toFixed(3)} (${candidate.reason})`,
    )
    .join("\n");
  return [
    `Selected: ${decision.selectedModel}`,
    decision.selectedThinking ? `Thinking: ${decision.selectedThinking}` : undefined,
    `Profile: ${decision.profile}`,
    `Score: ${decision.score.toFixed(3)}`,
    `Task: ${decision.classification.taskKind}/${decision.classification.complexity}`,
    `Reasoning needed: ${decision.classification.needsReasoning}`,
    `Large context: ${decision.classification.needsLargeContext}`,
    `Vision: ${decision.classification.needsVision}`,
    `Classifier confidence: ${decision.classification.confidence.toFixed(2)}`,
    `Classifier reason: ${decision.classification.reason}`,
    decision.error ? `Error: ${decision.error}` : undefined,
    "",
    "Candidates:",
    top || "  (none)",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

async function applyDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  decision: RoutingDecision,
): Promise<boolean> {
  const { provider, modelId } = parseModelRef(decision.selectedModel);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    decision.error = `Selected model not found: ${decision.selectedModel}`;
    return false;
  }

  const success = await (pi as any).setModel(model);
  if (!success) {
    decision.error = `No API key or auth failed for selected model: ${decision.selectedModel}`;
    return false;
  }

  if (decision.selectedThinking && typeof (pi as any).setThinkingLevel === "function") {
    (pi as any).setThinkingLevel(decision.selectedThinking);
  }
  return true;
}

export default function modelRouterExtension(pi: ExtensionAPI) {
  let config: RouterConfig = loadRouterConfig(process.cwd());
  let activeProfile = config.defaultProfile ?? "auto";
  let enabled = config.enabled ?? true;
  let debug = config.debug ?? false;
  let lastDecision: RoutingDecision | undefined;

  const reload = (ctx?: ExtensionContext) => {
    config = loadRouterConfig(ctx?.cwd ?? process.cwd());
    activeProfile = config.defaultProfile ?? activeProfile ?? "auto";
    enabled = config.enabled ?? true;
    debug = config.debug ?? false;
  };

  const setStatus = (ctx: ExtensionContext) => {
    if (!enabled) {
      ctx.ui.setStatus("router", "router: off");
      return;
    }
    const selected = lastDecision?.selectedModel ?? "pending";
    ctx.ui.setStatus("router", `router:${activeProfile} → ${selected}`);
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      reload(ctx);
      setStatus(ctx);
    } catch (error) {
      enabled = false;
      ctx.ui.setStatus("router", "router: config error");
      ctx.ui.notify(
        `Model router config error: ${error instanceof Error ? error.message : error}`,
        "error",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;

    const profile = config.profiles[activeProfile];
    if (!profile) {
      ctx.ui.notify(`Model router profile not found: ${activeProfile}`, "error");
      return;
    }

    const contextSummary = getRecentContextSummary(ctx);
    const prompt = event.prompt;
    const hasImages = (event.images?.length ?? 0) > 0;
    const estimatedTokens = estimateTokens(`${event.systemPrompt}\n${contextSummary}\n${prompt}`);

    try {
      ctx.ui.setStatus("router", `router:${activeProfile} classifying...`);
      const classification = await classifyRequest(ctx, config.classifierModel, {
        prompt,
        contextSummary,
        hasImages,
        estimatedTokens,
      });
      if (hasImages) classification.needsVision = true;

      const decision = selectModel({
        ctx,
        profileName: activeProfile,
        profile,
        defaultModel: profile.defaultModel ?? config.defaultModel,
        classification,
      });

      const applied = await applyDecision(pi, ctx, decision);
      lastDecision = decision;
      pi.appendEntry("model-router-decision", decision);
      setStatus(ctx);

      if (!applied) {
        ctx.ui.notify(`Model router could not switch model: ${decision.error}`, "warning");
      } else if (debug) {
        ctx.ui.notify(formatDecision(decision), "info");
      }
    } catch (error) {
      const fallbackClassification = {
        taskKind: "other" as const,
        complexity: "medium" as const,
        needsReasoning: false,
        needsLargeContext: false,
        needsVision: hasImages,
        latencyPreference: "medium" as const,
        costSensitivity: "medium" as const,
        confidence: 0,
        reason: `Classifier failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      const decision = selectModel({
        ctx,
        profileName: activeProfile,
        profile,
        defaultModel: profile.defaultModel ?? config.defaultModel,
        classification: fallbackClassification,
      });
      decision.error = fallbackClassification.reason;
      await applyDecision(pi, ctx, decision);
      lastDecision = decision;
      pi.appendEntry("model-router-decision", decision);
      setStatus(ctx);
      ctx.ui.notify(
        `Model router classifier failed; used fallback selection. ${decision.error}`,
        "warning",
      );
    }
  });

  pi.registerCommand("router", {
    description: "Show or control classifier-based model routing",
    handler: async (args, ctx) => {
      const [subcommand, value] = args.trim().split(/\s+/, 2);
      if (!subcommand || subcommand === "status") {
        const profileNames = Object.keys(config.profiles).join(", ");
        ctx.ui.notify(
          [
            "Model Router",
            `  Enabled: ${enabled}`,
            `  Active profile: ${activeProfile}`,
            `  Profiles: ${profileNames || "(none)"}`,
            `  Classifier: ${config.classifierModel.model}`,
            `  Default: ${config.defaultModel}`,
            lastDecision ? "" : undefined,
            lastDecision ? formatDecision(lastDecision) : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          "info",
        );
        return;
      }

      if (subcommand === "why") {
        ctx.ui.notify(formatDecision(lastDecision), "info");
        return;
      }

      if (subcommand === "reload") {
        try {
          reload(ctx);
          setStatus(ctx);
          ctx.ui.notify("Model router config reloaded.", "info");
        } catch (error) {
          ctx.ui.notify(
            `Model router reload failed: ${error instanceof Error ? error.message : error}`,
            "error",
          );
        }
        return;
      }

      if (subcommand === "profile") {
        if (!value) {
          ctx.ui.notify(`Profiles: ${Object.keys(config.profiles).join(", ")}`, "info");
          return;
        }
        if (!config.profiles[value]) {
          ctx.ui.notify(`Unknown router profile: ${value}`, "error");
          return;
        }
        activeProfile = value;
        enabled = true;
        setStatus(ctx);
        ctx.ui.notify(`Model router profile set to ${value}.`, "info");
        return;
      }

      if (subcommand === "on" || subcommand === "off") {
        enabled = subcommand === "on";
        setStatus(ctx);
        ctx.ui.notify(`Model router ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }

      if (subcommand === "debug") {
        debug = value === "on" ? true : value === "off" ? false : !debug;
        ctx.ui.notify(`Model router debug ${debug ? "enabled" : "disabled"}.`, "info");
        return;
      }

      ctx.ui.notify(
        "Usage: /router [status|why|reload|profile <name>|on|off|debug on|off]",
        "info",
      );
    },
  });
}
