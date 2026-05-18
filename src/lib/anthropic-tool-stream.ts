import { ChatAnthropic, type ChatAnthropicInput } from "@langchain/anthropic";

type ToolCallChunkLike = {
  id?: string;
  name?: string;
  args?: string;
  index?: number;
};

type MessageChunkLike = {
  id?: string;
  content?: unknown;
  response_metadata?: Record<string, unknown>;
  tool_call_chunks?: ToolCallChunkLike[];
  constructor: new (fields: Record<string, unknown>) => MessageChunkLike;
};

export type ChatGenerationChunkLike = {
  text: string;
  message: MessageChunkLike;
  generationInfo?: Record<string, unknown>;
  constructor: new (fields: {
    text: string;
    message: MessageChunkLike;
    generationInfo?: Record<string, unknown>;
  }) => ChatGenerationChunkLike;
};

type AnthropicStreamResponseChunksParameters = Parameters<ChatAnthropic["_streamResponseChunks"]>;
type AnthropicStreamChunk =
  ReturnType<ChatAnthropic["_streamResponseChunks"]> extends AsyncGenerator<infer Chunk>
    ? Chunk
    : ChatGenerationChunkLike;

type BufferedToolCall = {
  key: string;
  args: string;
  index?: number;
  id?: string;
  name?: string;
  messageId?: string;
  responseMetadata?: Record<string, unknown>;
};

export type AnthropicToolCallStreamState = {
  buffers: Map<string, BufferedToolCall>;
  generationChunkConstructor?: ChatGenerationChunkLike["constructor"];
  messageChunkConstructor?: MessageChunkLike["constructor"];
};

export function createAnthropicToolCallStreamState(): AnthropicToolCallStreamState {
  return { buffers: new Map() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function getToolCallChunks(message: unknown): ToolCallChunkLike[] {
  if (!isRecord(message) || !Array.isArray(message.tool_call_chunks)) {
    return [];
  }

  return message.tool_call_chunks.filter((chunk): chunk is ToolCallChunkLike => isRecord(chunk));
}

function getResponseMetadata(message: unknown): Record<string, unknown> | undefined {
  if (!isRecord(message) || !isRecord(message.response_metadata)) {
    return undefined;
  }
  return message.response_metadata;
}

function isAnthropicChunk(message: unknown): boolean {
  return getResponseMetadata(message)?.model_provider === "anthropic";
}

function toolCallBufferKey(chunk: ToolCallChunkLike): string {
  if (typeof chunk.index === "number") {
    return `index:${chunk.index}`;
  }
  if (isNonEmptyString(chunk.id)) {
    return `id:${chunk.id}`;
  }
  return "index:0";
}

function parseCompleteToolArgs(args: string): Record<string, unknown> | null {
  const trimmed = args.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function updateBufferedToolCall(
  state: AnthropicToolCallStreamState,
  chunk: ToolCallChunkLike,
  message: unknown,
): void {
  const key = toolCallBufferKey(chunk);
  const existing = state.buffers.get(key);
  const next: BufferedToolCall = existing ?? { key, args: "" };

  if (typeof chunk.index === "number") {
    next.index = chunk.index;
  }
  if (isNonEmptyString(chunk.id)) {
    next.id = chunk.id;
  }
  if (isNonEmptyString(chunk.name)) {
    next.name = chunk.name;
  }
  if (typeof chunk.args === "string") {
    next.args += chunk.args;
  }
  if (isRecord(message) && isNonEmptyString(message.id)) {
    next.messageId = message.id;
  }
  const responseMetadata = getResponseMetadata(message);
  if (responseMetadata) {
    next.responseMetadata = responseMetadata;
  }

  state.buffers.set(key, next);
}

function buildBufferedToolCallChunk(state: AnthropicToolCallStreamState, buffers: BufferedToolCall[]): ChatGenerationChunkLike | null {
  if (!state.generationChunkConstructor || !state.messageChunkConstructor) {
    return null;
  }

  const toolCallChunks = buffers.flatMap((buffer) => {
    const parsedArgs = parseCompleteToolArgs(buffer.args);
    if (!buffer.id || !buffer.name || !parsedArgs) {
      return [];
    }

    return [{
      id: buffer.id,
      name: buffer.name,
      args: JSON.stringify(parsedArgs),
      ...(typeof buffer.index === "number" ? { index: buffer.index } : {}),
    } satisfies ToolCallChunkLike];
  });

  if (toolCallChunks.length === 0) {
    return null;
  }

  const firstBuffer = buffers.find((buffer) => buffer.messageId || buffer.responseMetadata);
  return new state.generationChunkConstructor({
    text: "",
    message: new state.messageChunkConstructor({
      content: [],
      tool_call_chunks: toolCallChunks,
      ...(firstBuffer?.messageId ? { id: firstBuffer.messageId } : {}),
      response_metadata: firstBuffer?.responseMetadata ?? { model_provider: "anthropic" },
    }),
  });
}

export function stabilizeAnthropicToolCallGenerationChunk(
  chunk: ChatGenerationChunkLike,
  state: AnthropicToolCallStreamState,
): ChatGenerationChunkLike[] {
  const message = chunk.message;
  const toolCallChunks = getToolCallChunks(message);
  if (toolCallChunks.length === 0 || !isAnthropicChunk(message)) {
    return [chunk];
  }

  state.generationChunkConstructor = chunk.constructor;
  state.messageChunkConstructor = message.constructor;
  for (const toolCallChunk of toolCallChunks) {
    updateBufferedToolCall(state, toolCallChunk, message);
  }

  return [];
}

export function flushAnthropicToolCallStreamState(
  state: AnthropicToolCallStreamState,
): ChatGenerationChunkLike[] {
  if (state.buffers.size === 0) {
    return [];
  }

  const buffered = [...state.buffers.values()];
  state.buffers.clear();
  const chunk = buildBufferedToolCallChunk(state, buffered);
  return chunk ? [chunk] : [];
}

export class StableAnthropicToolCallChatModel extends ChatAnthropic {
  constructor(fields: ChatAnthropicInput) {
    super(fields);
  }

  async *_streamResponseChunks(
    messages: AnthropicStreamResponseChunksParameters[0],
    options: AnthropicStreamResponseChunksParameters[1],
    runManager?: AnthropicStreamResponseChunksParameters[2],
  ): AsyncGenerator<AnthropicStreamChunk> {
    const toolCallStreamState = createAnthropicToolCallStreamState();

    for await (const chunk of super._streamResponseChunks(messages, options, undefined)) {
      const stableChunks = stabilizeAnthropicToolCallGenerationChunk(
        chunk as unknown as ChatGenerationChunkLike,
        toolCallStreamState,
      );
      for (const stableChunk of stableChunks) {
        yield stableChunk as unknown as AnthropicStreamChunk;
        await runManager?.handleLLMNewToken(
          stableChunk.text,
          undefined,
          undefined,
          undefined,
          undefined,
          { chunk: stableChunk as unknown as AnthropicStreamChunk },
        );
      }
    }

    for (const stableChunk of flushAnthropicToolCallStreamState(toolCallStreamState)) {
      yield stableChunk as unknown as AnthropicStreamChunk;
      await runManager?.handleLLMNewToken(
        stableChunk.text,
        undefined,
        undefined,
        undefined,
        undefined,
        { chunk: stableChunk as unknown as AnthropicStreamChunk },
      );
    }
  }
}
