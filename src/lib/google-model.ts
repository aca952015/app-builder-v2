import { ChatGoogle } from "@langchain/google/node";

import type { TemplatePhaseEffort } from "./types.js";

type GoogleReasoningEffort = "low" | "medium" | "high";

export function normalizeGoogleModelName(modelName: string): string {
  const trimmed = modelName.trim();
  for (const prefix of ["google:", "gemini:"]) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

export function resolveGoogleReasoningEffort(effort: TemplatePhaseEffort): GoogleReasoningEffort {
  return effort === "max" ? "high" : effort;
}

export function createGoogleModel(options: {
  modelName: string;
  effort?: TemplatePhaseEffort;
  userAgent?: string;
  maxTokens?: number;
  apiKey?: string;
}) {
  return new ChatGoogle({
    model: normalizeGoogleModelName(options.modelName),
    temperature: 0,
    ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.effort ? { reasoningEffort: resolveGoogleReasoningEffort(options.effort) } : {}),
    ...(options.userAgent ? { customHeaders: { "User-Agent": options.userAgent } } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
}
