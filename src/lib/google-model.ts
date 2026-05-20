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

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function rewriteGoogleApiRequestUrl(requestUrl: string, baseURL: string): string {
  const source = new URL(requestUrl);
  const target = new URL(baseURL);
  const targetSegments = pathSegments(target.pathname);
  const sourceSegments = pathSegments(source.pathname);
  const targetLastSegment = targetSegments[targetSegments.length - 1];
  const sourceFirstSegment = sourceSegments[0];
  const suffixSegments = targetLastSegment && sourceFirstSegment === targetLastSegment
    ? sourceSegments.slice(1)
    : sourceSegments;

  target.pathname = `/${[...targetSegments, ...suffixSegments].join("/")}`;
  target.search = source.search;
  target.hash = "";
  return target.toString();
}

class GoogleBaseUrlApiClient {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey?: string,
  ) {}

  hasApiKey(): boolean {
    return typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  async getProjectId(): Promise<string> {
    throw new Error("Google baseURL proxy client does not support Vertex project ID lookup.");
  }

  async fetch(request: Request): Promise<Response> {
    const rewrittenRequest = new Request(rewriteGoogleApiRequestUrl(request.url, this.baseURL), request);
    if (this.hasApiKey()) {
      rewrittenRequest.headers.set("x-goog-api-key", this.apiKey!);
    }
    return fetch(rewrittenRequest);
  }
}

export function createGoogleModel(options: {
  modelName: string;
  effort?: TemplatePhaseEffort;
  userAgent?: string;
  maxTokens?: number;
  apiKey?: string;
  baseURL?: string;
}) {
  return new ChatGoogle({
    model: normalizeGoogleModelName(options.modelName),
    temperature: 0,
    ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
    ...(options.effort ? { reasoningEffort: resolveGoogleReasoningEffort(options.effort) } : {}),
    ...(options.userAgent ? { customHeaders: { "User-Agent": options.userAgent } } : {}),
    ...(options.baseURL ? { apiClient: new GoogleBaseUrlApiClient(options.baseURL, options.apiKey) } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
}
