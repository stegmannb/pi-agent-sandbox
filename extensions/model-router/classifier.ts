import { streamSimple, type Context } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "./config";
import type { ClassifierModelConfig, TaskClassification } from "./types";

const FALLBACK_CLASSIFICATION: TaskClassification = {
  taskKind: "other",
  complexity: "medium",
  needsReasoning: false,
  needsLargeContext: false,
  needsVision: false,
  latencyPreference: "medium",
  costSensitivity: "medium",
  confidence: 0,
  reason: "Classifier unavailable; using default routing classification.",
};

function clamp01(value: unknown): number {
  return Math.max(0, Math.min(1, typeof value === "number" ? value : Number(value) || 0));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeClassification(raw: unknown): TaskClassification {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    taskKind: pick(
      obj.taskKind,
      ["architecture", "planning", "coding", "debugging", "review", "summary", "lookup", "other"],
      "other",
    ),
    complexity: pick(obj.complexity, ["low", "medium", "high"], "medium"),
    needsReasoning: Boolean(obj.needsReasoning),
    needsLargeContext: Boolean(obj.needsLargeContext),
    needsVision: Boolean(obj.needsVision),
    latencyPreference: pick(obj.latencyPreference, ["low", "medium", "high"], "medium"),
    costSensitivity: pick(obj.costSensitivity, ["low", "medium", "high"], "medium"),
    confidence: clamp01(obj.confidence),
    reason: typeof obj.reason === "string" ? obj.reason : "Classifier returned no reason.",
  };
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Classifier did not return JSON: ${text.slice(0, 200)}`);
  }
  return JSON.parse(body.slice(start, end + 1));
}

export function buildClassifierPrompt(input: {
  prompt: string;
  contextSummary: string;
  hasImages: boolean;
  estimatedTokens: number;
}): string {
  return `You classify one pi-agent user request for model routing.
Return ONLY compact JSON. Do not include markdown.

Schema:
{
  "taskKind": "architecture|planning|coding|debugging|review|summary|lookup|other",
  "complexity": "low|medium|high",
  "needsReasoning": boolean,
  "needsLargeContext": boolean,
  "needsVision": boolean,
  "latencyPreference": "low|medium|high",
  "costSensitivity": "low|medium|high",
  "confidence": number,
  "reason": "one short sentence"
}

Guidance:
- taskKind describes the latest user request, not the whole session.
- needsReasoning is true for architecture, planning, hard debugging, high-risk refactors, or ambiguous tradeoffs.
- needsLargeContext is true if the request likely depends on broad repository/session context.
- latencyPreference high means the user likely wants a fast answer.
- costSensitivity high means a cheaper model is preferred unless quality would suffer.

Estimated current context tokens: ${input.estimatedTokens}
Images attached: ${input.hasImages}

Recent context summary:
${input.contextSummary || "(none)"}

Latest user request:
${input.prompt}`;
}

export async function classifyRequest(
  ctx: ExtensionContext,
  classifier: ClassifierModelConfig,
  input: { prompt: string; contextSummary: string; hasImages: boolean; estimatedTokens: number },
): Promise<TaskClassification> {
  const { provider, modelId } = parseModelRef(classifier.model);
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return {
      ...FALLBACK_CLASSIFICATION,
      reason: `Classifier model not found: ${classifier.model}`,
    };
  }

  const apiKey = await (ctx.modelRegistry as any).getApiKeyForProvider(provider);
  if (!apiKey) {
    return {
      ...FALLBACK_CLASSIFICATION,
      reason: `No API key for classifier model: ${classifier.model}`,
    };
  }

  const classifierContext: Context = {
    messages: [
      {
        role: "user",
        content: buildClassifierPrompt(input),
        timestamp: Date.now(),
      },
    ],
  };

  const options: Record<string, unknown> = { apiKey };
  if (model.reasoning && classifier.thinking && classifier.thinking !== "off") {
    options.reasoning = classifier.thinking;
  }

  let text = "";
  const stream = streamSimple(model, classifierContext, options as any);
  for await (const event of stream) {
    if (event.type === "text_delta" && typeof (event as any).delta === "string") {
      text += (event as any).delta;
    }
  }

  return normalizeClassification(extractJson(text));
}
