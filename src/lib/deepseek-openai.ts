import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  ChatOpenAI,
  ChatOpenAICompletions,
  type BaseChatOpenAIFields,
  type ChatOpenAICompletionsCallOptions,
  type ChatOpenAIFields,
  convertMessagesToCompletionsMessageParams,
} from "@langchain/openai";

import type { TemplatePhaseEffort } from "./types.js";

type GenerateArgs = Parameters<ChatOpenAICompletions["_generate"]>;
type BaseMessage = GenerateArgs[0][number];
type ChatResult = Awaited<ReturnType<ChatOpenAICompletions["_generate"]>>;
type StreamChunk = ReturnType<ChatOpenAICompletions["_streamResponseChunks"]> extends AsyncGenerator<infer Chunk>
  ? Chunk
  : never;
type CompletionMessageParam = ReturnType<typeof convertMessagesToCompletionsMessageParams>[number];
type CompletionMessageParamWithReasoning = CompletionMessageParam & {
  reasoning_content?: string;
};
type CompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    audio_tokens?: number | null;
    cached_tokens?: number | null;
  };
  completion_tokens_details?: {
    audio_tokens?: number | null;
    reasoning_tokens?: number | null;
  };
};
type ChatCompletionChunkLike = {
  usage?: CompletionUsage;
  choices?: Array<{
    index?: number;
    delta?: Record<string, unknown> & {
      role?: string;
      content?: unknown;
    };
    finish_reason?: unknown;
    logprobs?: unknown;
  }>;
  system_fingerprint?: string;
  model?: string;
  service_tier?: unknown;
};
type ToolChoiceParams = {
  tool_choice?: unknown;
};

type OpenAICompatibleModelFields = BaseChatOpenAIFields & ChatOpenAIFields;
type ReasoningMessage = BaseMessage & {
  additional_kwargs: Record<string, unknown>;
  tool_calls?: unknown[];
  role?: unknown;
  usage_metadata?: unknown;
  _getType?: () => string;
};

type LangChainCoreMessages = {
  AIMessage: new (fields: unknown) => BaseMessage;
  AIMessageChunk: new (fields: unknown) => BaseMessage;
  ToolMessage: {
    isInstance: (value: unknown) => boolean;
  };
  isAIMessage: (value: unknown) => boolean;
};

type LangChainCoreOutputs = {
  ChatGenerationChunk: new (fields: {
    message: BaseMessage;
    text: string;
    generationInfo?: Record<string, unknown>;
  }) => StreamChunk & {
    message: BaseMessage & { response_metadata?: Record<string, unknown> };
    text?: string;
    generationInfo?: Record<string, unknown>;
    concat: (chunk: StreamChunk) => StreamChunk;
  };
};

const require = createRequire(import.meta.url);

function resolvePeerLangChainCoreSubpath(subpath: "messages" | "outputs"): string {
  const openAiPackagePath = require.resolve("@langchain/openai/package.json");
  return require.resolve(`@langchain/core/${subpath}`, {
    paths: [path.dirname(openAiPackagePath)],
  });
}

let messagesModulePromise: Promise<LangChainCoreMessages> | undefined;
let outputsModulePromise: Promise<LangChainCoreOutputs> | undefined;

async function loadLangChainCoreMessages(): Promise<LangChainCoreMessages> {
  messagesModulePromise ??= import(pathToFileURL(resolvePeerLangChainCoreSubpath("messages")).href) as Promise<LangChainCoreMessages>;
  return messagesModulePromise;
}

async function loadLangChainCoreOutputs(): Promise<LangChainCoreOutputs> {
  outputsModulePromise ??= import(pathToFileURL(resolvePeerLangChainCoreSubpath("outputs")).href) as Promise<LangChainCoreOutputs>;
  return outputsModulePromise;
}

function asReasoningMessage(message: BaseMessage): ReasoningMessage {
  return message as ReasoningMessage;
}

function getMessageType(message: BaseMessage): string | undefined {
  const getType = (message as { _getType?: () => string })._getType;
  return typeof getType === "function" ? getType.call(message) : undefined;
}

function isUserLikeMessage(message: BaseMessage): boolean {
  const role = (message as { role?: unknown }).role;
  return getMessageType(message) === "human" || role === "user";
}

function isToolLikeMessage(message: BaseMessage, coreMessages: LangChainCoreMessages): boolean {
  const role = (message as { role?: unknown }).role;
  return coreMessages.ToolMessage.isInstance(message) || getMessageType(message) === "tool" || role === "tool";
}

function hasAssistantToolCalls(message: BaseMessage, coreMessages: LangChainCoreMessages): boolean {
  const reasoningMessage = asReasoningMessage(message);
  if (coreMessages.isAIMessage(message) && (reasoningMessage.tool_calls?.length ?? 0) > 0) {
    return true;
  }

  const additionalToolCalls = reasoningMessage.additional_kwargs.tool_calls;
  return Array.isArray(additionalToolCalls) && additionalToolCalls.length > 0;
}

function getReasoningContent(message: BaseMessage): string | undefined {
  const reasoningContent = asReasoningMessage(message).additional_kwargs.reasoning_content;
  return typeof reasoningContent === "string" && reasoningContent.length > 0 ? reasoningContent : undefined;
}

function computeReasoningContentPassthrough(
  messages: BaseMessage[],
  coreMessages: LangChainCoreMessages,
): boolean[] {
  const passthrough = messages.map(() => false);
  let segmentStart = 0;
  let segmentHasToolInteraction = false;

  const flushSegment = (exclusiveEnd: number) => {
    if (!segmentHasToolInteraction) {
      return;
    }

    for (let index = segmentStart; index < exclusiveEnd; index += 1) {
      if (getReasoningContent(messages[index]!)) {
        passthrough[index] = true;
      }
    }
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (index > segmentStart && isUserLikeMessage(message)) {
      flushSegment(index);
      segmentStart = index;
      segmentHasToolInteraction = false;
    }

    if (hasAssistantToolCalls(message, coreMessages) || isToolLikeMessage(message, coreMessages)) {
      segmentHasToolInteraction = true;
    }
  }

  flushSegment(messages.length);
  return passthrough;
}

export async function convertMessagesToDeepSeekCompletionsMessageParams(
  params: {
    messages: BaseMessage[];
    model?: string;
  },
): Promise<CompletionMessageParam[]> {
  const coreMessages = await loadLangChainCoreMessages();
  const passthrough = computeReasoningContentPassthrough(params.messages, coreMessages);

  return params.messages.flatMap((message, index) => {
    const converted = convertMessagesToCompletionsMessageParams({
      messages: [message],
      ...(params.model ? { model: params.model } : {}),
    }) as CompletionMessageParamWithReasoning[];
    const reasoningContent = passthrough[index] ? getReasoningContent(message) : undefined;

    if (!reasoningContent) {
      return converted;
    }

    for (const item of converted) {
      if (item.role === "assistant") {
        item.reasoning_content = reasoningContent;
      }
    }

    return converted;
  });
}

export function sanitizeDeepSeekCompletionsParams<T extends ToolChoiceParams>(params: T): T {
  if (params.tool_choice !== "required" && params.tool_choice !== "any") {
    return params;
  }

  const sanitized = { ...params };
  delete sanitized.tool_choice;
  return sanitized;
}

class DeepSeekReasoningContentChatOpenAICompletions<
  CallOptions extends ChatOpenAICompletionsCallOptions = ChatOpenAICompletionsCallOptions,
> extends ChatOpenAICompletions<CallOptions> {
  override async _generate(
    messages: GenerateArgs[0],
    options: this["ParsedCallOptions"],
    runManager?: GenerateArgs[2],
  ): Promise<ChatResult> {
    const [{ AIMessage, isAIMessage }, { ChatGenerationChunk }] = await Promise.all([
      loadLangChainCoreMessages(),
      loadLangChainCoreOutputs(),
    ]);
    options.signal?.throwIfAborted();
    const usageMetadata: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_token_details?: Record<string, number>;
      output_token_details?: Record<string, number>;
    } = {};
    const params = sanitizeDeepSeekCompletionsParams(this.invocationParams(options));
    const messagesMapped = await convertMessagesToDeepSeekCompletionsMessageParams({
      messages,
      model: this.model,
    });

    if (params.stream) {
      const stream = this._streamResponseChunks(messages, options, runManager);
      const finalChunks: Record<number, InstanceType<typeof ChatGenerationChunk>> = {};
      for await (const chunk of stream) {
        chunk.message.response_metadata = {
          ...chunk.generationInfo,
          ...chunk.message.response_metadata,
        };
        const index = (chunk.generationInfo as { completion?: number } | undefined)?.completion ?? 0;
        if (finalChunks[index] === undefined) {
          finalChunks[index] = chunk;
        } else {
          finalChunks[index] = finalChunks[index].concat(chunk) as InstanceType<typeof ChatGenerationChunk>;
        }
      }
      const generations = Object.entries(finalChunks)
        .sort(([leftKey], [rightKey]) => parseInt(leftKey, 10) - parseInt(rightKey, 10))
        .map(([, value]) => value);

      const { functions, function_call } = this.invocationParams(options);
      const promptTokenUsage = await this._getEstimatedTokenCountFromPrompt(messages, functions, function_call);
      const completionTokenUsage = await this._getNumTokensFromGenerations(generations);

      usageMetadata.input_tokens = promptTokenUsage;
      usageMetadata.output_tokens = completionTokenUsage;
      usageMetadata.total_tokens = promptTokenUsage + completionTokenUsage;
      return {
        generations,
        llmOutput: {
          estimatedTokenUsage: {
            promptTokens: usageMetadata.input_tokens,
            completionTokens: usageMetadata.output_tokens,
            totalTokens: usageMetadata.total_tokens,
          },
        },
      };
    }

    const data = await this.completionWithRetry(
      {
        ...params,
        stream: false,
        messages: messagesMapped,
      },
      {
        signal: options?.signal,
        ...options?.options,
      },
    );

    const {
      completion_tokens: completionTokens,
      prompt_tokens: promptTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: promptTokensDetails,
      completion_tokens_details: completionTokensDetails,
    } = data.usage ?? {};

    if (completionTokens) {
      usageMetadata.output_tokens = (usageMetadata.output_tokens ?? 0) + completionTokens;
    }

    if (promptTokens) {
      usageMetadata.input_tokens = (usageMetadata.input_tokens ?? 0) + promptTokens;
    }

    if (totalTokens) {
      usageMetadata.total_tokens = (usageMetadata.total_tokens ?? 0) + totalTokens;
    }

    if (promptTokensDetails?.audio_tokens != null || promptTokensDetails?.cached_tokens != null) {
      usageMetadata.input_token_details = {
        ...(promptTokensDetails.audio_tokens != null && {
          audio: promptTokensDetails.audio_tokens,
        }),
        ...(promptTokensDetails.cached_tokens != null && {
          cache_read: promptTokensDetails.cached_tokens,
        }),
      };
    }

    if (completionTokensDetails?.audio_tokens != null || completionTokensDetails?.reasoning_tokens != null) {
      usageMetadata.output_token_details = {
        ...(completionTokensDetails.audio_tokens != null && {
          audio: completionTokensDetails.audio_tokens,
        }),
        ...(completionTokensDetails.reasoning_tokens != null && {
          reasoning: completionTokensDetails.reasoning_tokens,
        }),
      };
    }

    const generations: ChatResult["generations"] = [];
    for (const part of data.choices ?? []) {
      const text = part.message?.content ?? "";
      const generation: {
        text: string;
        message: BaseMessage;
        generationInfo?: Record<string, unknown>;
      } = {
        text,
        message: this._convertCompletionsMessageToBaseMessage(
          part.message ?? { role: "assistant" },
          data,
        ),
      };
      generation.generationInfo = {
        ...(part.finish_reason ? { finish_reason: part.finish_reason } : {}),
        ...(part.logprobs ? { logprobs: part.logprobs } : {}),
      };
      if (isAIMessage(generation.message)) {
        asReasoningMessage(generation.message).usage_metadata = usageMetadata;
      }
      generation.message = new AIMessage(
        Object.fromEntries(
          Object.entries(generation.message).filter(([key]) => !key.startsWith("lc_")),
        ),
      );
      generations.push(generation);
    }

    return {
      generations,
      llmOutput: {
        tokenUsage: {
          promptTokens: usageMetadata.input_tokens,
          completionTokens: usageMetadata.output_tokens,
          totalTokens: usageMetadata.total_tokens,
        },
      },
    };
  }

  override async *_streamResponseChunks(
    messages: GenerateArgs[0],
    options: this["ParsedCallOptions"],
    runManager?: GenerateArgs[2],
  ): AsyncGenerator<StreamChunk> {
    const [{ AIMessageChunk }, { ChatGenerationChunk }] = await Promise.all([
      loadLangChainCoreMessages(),
      loadLangChainCoreOutputs(),
    ]);
    const messagesMapped = await convertMessagesToDeepSeekCompletionsMessageParams({
      messages,
      model: this.model,
    });

    const params = sanitizeDeepSeekCompletionsParams({
      ...this.invocationParams(options, {
        streaming: true,
      }),
      messages: messagesMapped,
      stream: true as const,
    });
    let defaultRole: string | undefined;

    const streamIterable = await (
      this.completionWithRetry as unknown as (
        request: unknown,
        requestOptions?: unknown,
      ) => Promise<AsyncIterable<ChatCompletionChunkLike>>
    )(params, options);
    let usage: CompletionUsage | undefined;
    for await (const data of streamIterable) {
      if (options.signal?.aborted) {
        return;
      }
      const choice = data?.choices?.[0];
      if (data.usage) {
        usage = data.usage;
      }
      if (!choice) {
        continue;
      }

      const { delta } = choice;
      if (!delta) {
        continue;
      }
      const chunk = this._convertCompletionsDeltaToBaseMessageChunk(delta, data as never, defaultRole as never);
      defaultRole = delta.role ?? defaultRole;
      const newTokenIndices = {
        prompt: options.promptIndex ?? 0,
        completion: choice.index ?? 0,
      };
      if (typeof chunk.content !== "string") {
        console.log("[WARNING]: Received non-string content from OpenAI. This is currently not supported.");
        continue;
      }

      const generationInfo: Record<string, unknown> = { ...newTokenIndices };
      if (choice.finish_reason != null) {
        generationInfo.finish_reason = choice.finish_reason;
        generationInfo.system_fingerprint = data.system_fingerprint;
        generationInfo.model_name = data.model;
        generationInfo.service_tier = data.service_tier;
      }
      if (this.logprobs) {
        generationInfo.logprobs = choice.logprobs;
      }
      const generationChunk = new ChatGenerationChunk({
        message: chunk,
        text: chunk.content,
        generationInfo,
      });
      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? "",
        newTokenIndices,
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk },
      );
    }

    if (usage) {
      const inputTokenDetails = {
        ...(usage.prompt_tokens_details?.audio_tokens != null && {
          audio: usage.prompt_tokens_details.audio_tokens,
        }),
        ...(usage.prompt_tokens_details?.cached_tokens != null && {
          cache_read: usage.prompt_tokens_details.cached_tokens,
        }),
      };
      const outputTokenDetails = {
        ...(usage.completion_tokens_details?.audio_tokens != null && {
          audio: usage.completion_tokens_details.audio_tokens,
        }),
        ...(usage.completion_tokens_details?.reasoning_tokens != null && {
          reasoning: usage.completion_tokens_details.reasoning_tokens,
        }),
      };
      const generationChunk = new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: "",
          response_metadata: {
            usage: { ...usage },
          },
          usage_metadata: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            ...(Object.keys(inputTokenDetails).length > 0 && {
              input_token_details: inputTokenDetails,
            }),
            ...(Object.keys(outputTokenDetails).length > 0 && {
              output_token_details: outputTokenDetails,
            }),
          },
        }),
        text: "",
      });
      yield generationChunk;
      await runManager?.handleLLMNewToken(
        generationChunk.text ?? "",
        { prompt: 0, completion: 0 },
        undefined,
        undefined,
        undefined,
        { chunk: generationChunk },
      );
    }

    if (options.signal?.aborted) {
      throw new Error("AbortError");
    }
  }
}

export function normalizeOpenAICompatibleModelName(modelName: string): string {
  const trimmed = modelName.trim();
  const [provider, ...modelParts] = trimmed.split(":");
  if (provider === "openai" && modelParts.length > 0) {
    return modelParts.join(":");
  }
  return trimmed;
}

export function shouldUseDeepSeekReasoningContentCompat(modelName: string, baseURL?: string): boolean {
  return (
    /deepseek/i.test(normalizeOpenAICompatibleModelName(modelName)) ||
    (typeof baseURL === "string" && /deepseek/i.test(baseURL))
  );
}

export function createOpenAICompatibleModel(options: {
  modelName: string;
  effort?: TemplatePhaseEffort;
  baseURL?: string;
}) {
  const model = normalizeOpenAICompatibleModelName(options.modelName);
  const fields: OpenAICompatibleModelFields = {
    model,
    temperature: 0,
    ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
    ...(options.baseURL ? { configuration: { baseURL: options.baseURL } } : {}),
  };

  if (!shouldUseDeepSeekReasoningContentCompat(options.modelName, options.baseURL)) {
    return new ChatOpenAI(fields);
  }

  return new ChatOpenAI({
    ...fields,
    completions: new DeepSeekReasoningContentChatOpenAICompletions(fields),
    useResponsesApi: false,
  });
}
