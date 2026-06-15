import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "./config";
import type { ModelCandidate, RouterProfile, RoutingDecision, TaskClassification } from "./types";

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" ? Math.max(0, Math.min(1, value)) : fallback;
}

function preferenceWeight(value: "low" | "medium" | "high"): number {
  if (value === "high") return 1;
  if (value === "medium") return 0.55;
  return 0.2;
}

function strengthScore(candidate: ModelCandidate, classification: TaskClassification): number {
  const strengths = new Set((candidate.strengths ?? []).map((s) => s.toLowerCase()));
  let score = strengths.has(classification.taskKind) ? 1 : 0;
  if (classification.needsReasoning && strengths.has("reasoning")) score += 0.25;
  if (
    (classification.taskKind === "coding" || classification.taskKind === "debugging") &&
    strengths.has("tool-use")
  ) {
    score += 0.2;
  }
  if (classification.latencyPreference === "high" && strengths.has("fast")) score += 0.2;
  return Math.min(1, score);
}

function hardConstraintFailure(
  candidate: ModelCandidate,
  classification: TaskClassification,
  registryModel: any,
): string | undefined {
  const supportsImages =
    candidate.supports?.images ?? registryModel?.input?.includes("image") ?? false;
  if (classification.needsVision && !supportsImages)
    return "needs vision but model does not support images";

  const supportsReasoning = candidate.supports?.reasoning ?? Boolean(registryModel?.reasoning);
  if (
    classification.needsReasoning &&
    classification.complexity === "high" &&
    candidate.quality !== undefined &&
    candidate.quality < 0.55
  ) {
    return "high-complexity reasoning request and candidate quality is too low";
  }
  if (
    classification.needsReasoning &&
    !supportsReasoning &&
    candidate.quality !== undefined &&
    candidate.quality < 0.75
  ) {
    return "needs reasoning but candidate is neither reasoning-capable nor high-quality";
  }

  return undefined;
}

export function selectModel(input: {
  ctx: ExtensionContext;
  profileName: string;
  profile: RouterProfile;
  defaultModel: string;
  classification: TaskClassification;
}): RoutingDecision {
  const scored: RoutingDecision["candidates"] = [];
  let best: { candidate: ModelCandidate; score: number; reason: string } | undefined;

  for (const candidate of input.profile.models) {
    let registryModel: any;
    try {
      const { provider, modelId } = parseModelRef(candidate.model);
      registryModel = input.ctx.modelRegistry.find(provider, modelId);
    } catch {
      // Invalid refs are treated as unavailable and scored out below.
    }

    if (!registryModel) {
      scored.push({ model: candidate.model, score: 0, reason: "model unavailable in registry" });
      continue;
    }

    const failure = hardConstraintFailure(candidate, input.classification, registryModel);
    if (failure) {
      scored.push({ model: candidate.model, score: 0, reason: failure });
      continue;
    }

    const quality = num(candidate.quality, 0.65);
    const cost = num(candidate.cost, 0.5);
    const latency = num(candidate.latency, 0.5);
    const strengths = strengthScore(candidate, input.classification);
    const reasoningFit = input.classification.needsReasoning
      ? candidate.supports?.reasoning || registryModel.reasoning || quality >= 0.85
        ? 1
        : 0.35
      : 0.6;
    const contextFit = input.classification.needsLargeContext
      ? (candidate.contextWindow ?? registryModel.contextWindow ?? 0) >= 100_000
        ? 1
        : 0.35
      : 0.7;

    const complexityQualityWeight =
      input.classification.complexity === "high"
        ? 0.35
        : input.classification.complexity === "medium"
          ? 0.25
          : 0.15;
    const costWeight = 0.1 + preferenceWeight(input.classification.costSensitivity) * 0.2;
    const latencyWeight = 0.08 + preferenceWeight(input.classification.latencyPreference) * 0.17;

    const score =
      strengths * 0.22 +
      quality * complexityQualityWeight +
      cost * costWeight +
      latency * latencyWeight +
      reasoningFit * 0.16 +
      contextFit * 0.1;

    const reason = [
      `strength=${strengths.toFixed(2)}`,
      `quality=${quality.toFixed(2)}`,
      `cost=${cost.toFixed(2)}`,
      `latency=${latency.toFixed(2)}`,
      `reasoning=${reasoningFit.toFixed(2)}`,
      `context=${contextFit.toFixed(2)}`,
    ].join(", ");

    scored.push({ model: candidate.model, score, reason });
    if (!best || score > best.score) best = { candidate, score, reason };
  }

  const selected = best?.candidate.model ?? input.profile.defaultModel ?? input.defaultModel;
  const selectedCandidate = input.profile.models.find((candidate) => candidate.model === selected);

  return {
    profile: input.profileName,
    selectedModel: selected,
    selectedThinking: selectedCandidate?.thinking,
    classification: input.classification,
    score: best?.score ?? 0,
    reason: best
      ? `Selected best-scoring candidate for ${input.classification.taskKind}/${input.classification.complexity}.`
      : "No configured candidate was available; falling back to default model.",
    candidates: scored.sort((a, b) => b.score - a.score),
    timestamp: Date.now(),
    fallback: !best,
  };
}
