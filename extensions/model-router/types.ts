export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type TaskKind =
  | "architecture"
  | "planning"
  | "coding"
  | "debugging"
  | "review"
  | "summary"
  | "lookup"
  | "other";

export type Complexity = "low" | "medium" | "high";
export type Preference = "low" | "medium" | "high";

export interface ClassifierModelConfig {
  model: string;
  thinking?: ThinkingLevel;
}

export interface ModelCandidate {
  model: string;
  strengths?: string[];
  quality?: number;
  cost?: number;
  latency?: number;
  thinking?: ThinkingLevel;
  contextWindow?: number;
  supports?: {
    images?: boolean;
    reasoning?: boolean;
    tools?: boolean;
  };
}

export interface RouterProfile {
  models: ModelCandidate[];
  defaultModel?: string;
}

export interface RouterConfig {
  enabled?: boolean;
  debug?: boolean;
  defaultProfile?: string;
  classifierModel: ClassifierModelConfig;
  defaultModel: string;
  profiles: Record<string, RouterProfile>;
}

export interface TaskClassification {
  taskKind: TaskKind;
  complexity: Complexity;
  needsReasoning: boolean;
  needsLargeContext: boolean;
  needsVision: boolean;
  latencyPreference: Preference;
  costSensitivity: Preference;
  confidence: number;
  reason: string;
}

export interface RoutingDecision {
  profile: string;
  selectedModel: string;
  selectedThinking?: ThinkingLevel;
  classification: TaskClassification;
  score: number;
  reason: string;
  candidates: Array<{ model: string; score: number; reason: string }>;
  timestamp: number;
  fallback?: boolean;
  error?: string;
}
