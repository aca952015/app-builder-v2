import { appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { inspect } from "node:util";

import { toolStrategy } from "langchain";
import { z } from "zod";

import { resolveTemplateFilePath } from "./template-pack.js";
import { GeneratedProject, NormalizedSpec, TextGenerator, TextGeneratorRuntime } from "./types.js";

const generatedProjectSchema = z.object({
  summary: z.string(),
  filesWritten: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

const SANDBOX_ALPHA_WARNING =
  "langsmith/experimental/sandbox is in alpha. This feature is experimental, and breaking changes are expected.";
const DEEPAGENTS_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_DEEPAGENTS_STREAM_MODES = ["updates", "messages", "tools", "values"] as const;
const VALID_DEEPAGENTS_STREAM_MODES = new Set<string>(DEFAULT_DEEPAGENTS_STREAM_MODES);

async function loadDeepagentsModule() {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === SANDBOX_ALPHA_WARNING) {
      return;
    }
    originalWarn(...args);
  };

  try {
    return await import("deepagents");
  } finally {
    console.warn = originalWarn;
  }
}

async function loadSystemPrompt(systemPromptPath: string): Promise<string> {
  return await fs.readFile(systemPromptPath, "utf8");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveDeepagentsStreamModes(
  value: string | undefined = process.env.APP_BUILDER_STREAM_MODES,
): string[] {
  if (!value || value.trim() === "") {
    return [...DEFAULT_DEEPAGENTS_STREAM_MODES];
  }

  const modes = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (modes.length === 0) {
    return [...DEFAULT_DEEPAGENTS_STREAM_MODES];
  }

  const invalidModes = modes.filter((mode) => !VALID_DEEPAGENTS_STREAM_MODES.has(mode));
  if (invalidModes.length > 0) {
    throw new Error(
      `Invalid APP_BUILDER_STREAM_MODES value: ${invalidModes.join(", ")}. Valid values are ${[...VALID_DEEPAGENTS_STREAM_MODES].join(", ")}.`,
    );
  }

  return Array.from(new Set(modes));
}

function extractMessageText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const content = record.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }

  return null;
}

type DeepAgentsTraceState = {
  announcedModelOutput: boolean;
  announcedToolPhase: boolean;
  announcedUpdates: boolean;
  seenToolCalls: Set<string>;
  todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
  lastNarrative: string;
  renderedRows: number;
  lastNonTtyTodoSignature: string;
  lastNonTtyNarrative: string;
  logFilePath?: string;
};

type ToolCallDetail = {
  id: string | undefined;
  name: string | undefined;
  args: unknown;
  status: unknown;
  result: unknown;
};

function getObjectKeys(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value as Record<string, unknown>) : [];
}

function isTodoList(
  value: unknown,
): value is Array<{ content: string; status: "pending" | "in_progress" | "completed" }> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof (item as { content?: unknown }).content === "string" &&
        ((item as { status?: unknown }).status === "pending" ||
          (item as { status?: unknown }).status === "in_progress" ||
          (item as { status?: unknown }).status === "completed"),
    )
  );
}

function extractTodosFromPayload(value: unknown): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (isTodoList(record.todos)) {
    return record.todos;
  }

  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") {
      const extracted = extractTodosFromPayload(nested);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

export function renderTodoStatus(
  status: "pending" | "in_progress" | "completed",
): string {
  switch (status) {
    case "completed":
      return "✅";
    case "in_progress":
      return "✳️";
    default:
      return "✴️";
  }
}

function buildActionLine(trace: DeepAgentsTraceState): string {
  return `当前动作：${trace.lastNarrative}`;
}

export function formatTodoHeader(completedCount: number, totalCount: number): string {
  return `当前计划（${completedCount}/${totalCount}）：`;
}

function buildTodoHeader(trace: DeepAgentsTraceState): string {
  const completedCount = trace.todos.filter((todo) => todo.status === "completed").length;
  return formatTodoHeader(completedCount, trace.todos.length);
}

function buildTodoBoardLines(trace: DeepAgentsTraceState): string[] {
  if (trace.todos.length === 0) {
    return [buildActionLine(trace)];
  }

  const lines = [buildTodoHeader(trace)];
  for (const todo of trace.todos) {
    lines.push(`  ${renderTodoStatus(todo.status)} ${todo.content}`);
  }
  lines.push(buildActionLine(trace));
  return lines;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function visibleTextWidth(input: string): number {
  let width = 0;

  for (const char of stripAnsi(input)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }

  return width;
}

export function estimateRenderedRows(lines: string[], columns: number): number {
  const safeColumns = Math.max(columns, 1);

  return lines.reduce((total, line) => {
    const width = visibleTextWidth(line);
    return total + Math.max(1, Math.ceil(width / safeColumns));
  }, 0);
}

function clearPreviousBoard(renderedRows: number): void {
  if (!process.stdout.isTTY) {
    return;
  }

  void renderedRows;
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
}

function renderTodoBoard(trace: DeepAgentsTraceState): void {
  const lines = buildTodoBoardLines(trace);
  const todoSignature = JSON.stringify(trace.todos);

  if (process.stdout.isTTY) {
    clearPreviousBoard(trace.renderedRows);
    process.stdout.write(`${lines.join("\n")}\n`);
    trace.renderedRows = estimateRenderedRows(lines, process.stdout.columns ?? 80);
  } else {
    if (trace.lastNonTtyTodoSignature !== todoSignature) {
      const boardOnlyLines = lines.slice(0, -1);
      if (boardOnlyLines.length > 0) {
        process.stdout.write(`${boardOnlyLines.join("\n")}\n`);
      }
      trace.lastNonTtyTodoSignature = todoSignature;
    }
    if (trace.lastNonTtyNarrative !== trace.lastNarrative) {
      process.stdout.write(`${lines.at(-1) ?? buildActionLine(trace)}\n`);
      trace.lastNonTtyNarrative = trace.lastNarrative;
    }
    trace.renderedRows = 0;
  }
}

function formatUnknownError(error: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);

  if (error instanceof Error) {
    const sections = [`${indent}${error.name}: ${error.message}`];

    if (error.stack) {
      sections.push(`${indent}stack:\n${error.stack}`);
    }

    const withCause = error as Error & { cause?: unknown; errors?: unknown };
    if (withCause.cause !== undefined) {
      sections.push(`${indent}cause:\n${formatUnknownError(withCause.cause, depth + 1)}`);
    }

    if (Array.isArray(withCause.errors) && withCause.errors.length > 0) {
      sections.push(
        `${indent}errors:\n${withCause.errors
          .map((item, index) => `${indent}- [${index}]\n${formatUnknownError(item, depth + 1)}`)
          .join("\n")}`,
      );
    }

    return sections.join("\n");
  }

  return `${indent}${inspect(error, { depth: 6, breakLength: 120 })}`;
}

async function writeErrorLog(logFilePath: string | undefined, error: unknown): Promise<void> {
  if (!logFilePath) {
    return;
  }

  const content = `[${new Date().toISOString()}]\n${formatUnknownError(error)}\n\n`;
  await fs.appendFile(logFilePath, content, "utf8");
}

function formatTracePayload(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return inspect(value, {
    depth: 10,
    breakLength: 100,
    compact: false,
    sorted: true,
  });
}

function indentMultiline(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function formatTraceSection(title: string, content: string): string {
  return `${title}\n${indentMultiline(content)}`;
}

function extractToolCallDetails(value: unknown): ToolCallDetail[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const candidates = ["tool_calls", "toolCalls", "calls"]
    .map((key) => record[key])
    .find((candidate) => Array.isArray(candidate));

  if (!Array.isArray(candidates)) {
    return [];
  }

  return candidates
    .filter((candidate) => candidate && typeof candidate === "object")
    .map((candidate) => {
      const detail = candidate as Record<string, unknown>;
      return {
        id: typeof detail.id === "string" ? detail.id : undefined,
        name:
          typeof detail.name === "string"
            ? detail.name
            : typeof detail.tool === "string"
              ? detail.tool
              : typeof detail.tool_name === "string"
                ? detail.tool_name
                : typeof detail.toolName === "string"
                  ? detail.toolName
                  : undefined,
        args:
          detail.args ??
          detail.arguments ??
          detail.input ??
          detail.payload,
        status: typeof detail.status === "string" ? detail.status : undefined,
        result: detail.result ?? detail.output,
      };
    });
}

export function formatDeepAgentsTraceEntry(mode: string, payload: unknown, summary: string): string {
  const timestamp = new Date().toISOString();
  const sections = [`=== ${timestamp} | ${mode.toUpperCase()} ===`, formatTraceSection("Summary", summary)];

  if (mode === "messages") {
    const messageText =
      Array.isArray(payload) && payload.length > 0 ? extractMessageText(payload[0]) : extractMessageText(payload);
    if (messageText && messageText.trim()) {
      sections.push(formatTraceSection("Message", messageText.trim()));
    }
  }

  if (mode === "tools") {
    const toolCalls = extractToolCallDetails(payload);
    if (toolCalls.length > 0) {
      sections.push(
        formatTraceSection(
          "Tool Calls",
          toolCalls
            .map((call, index) => {
              const lines = [`${index + 1}. ${call.name ?? "unknown"}`];
              if (call.id) {
                lines.push(`id: ${call.id}`);
              }
              if (call.status) {
                lines.push(`status: ${call.status}`);
              }
              if (call.args !== undefined) {
                lines.push("args:");
                lines.push(indentMultiline(formatTracePayload(call.args), "  "));
              }
              if (call.result !== undefined) {
                lines.push("result:");
                lines.push(indentMultiline(formatTracePayload(call.result), "  "));
              }
              return lines.join("\n");
            })
            .join("\n\n"),
        ),
      );
    }
  }

  if (mode === "updates") {
    const keys = getObjectKeys(payload);
    if (keys.length > 0) {
      sections.push(formatTraceSection("Updated Keys", keys.join(", ")));
    }
  }

  if (mode === "values") {
    const valueSummary = summarizeValuePayload(payload);
    if (valueSummary) {
      sections.push(formatTraceSection("Value Summary", valueSummary));
    }
  }

  sections.push(formatTraceSection("Payload", formatTracePayload(payload)));
  return `${sections.join("\n\n")}\n\n`;
}

function writeSystemTraceEvent(
  logFilePath: string | undefined,
  mode: string,
  payload: unknown,
  summary: string,
): void {
  if (!logFilePath) {
    return;
  }

  appendFileSync(logFilePath, formatDeepAgentsTraceEntry(mode, payload, summary), "utf8");
}

function updateTodoBoard(
  trace: DeepAgentsTraceState,
  payload: unknown,
  narrative: string,
): void {
  const todos = extractTodosFromPayload(payload);
  if (todos) {
    trace.todos = todos;
  }
  trace.lastNarrative = narrative;
  renderTodoBoard(trace);
}

function extractToolNames(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const names = new Set<string>();

  for (const key of ["name", "tool", "tool_name", "toolName"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate) {
      names.add(candidate);
    }
  }

  for (const key of ["tool_calls", "toolCalls", "calls"]) {
    const candidate = record[key];
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const call of candidate) {
      if (!call || typeof call !== "object") {
        continue;
      }
      const callRecord = call as Record<string, unknown>;
      for (const nameKey of ["name", "tool", "tool_name", "toolName"]) {
        const callName = callRecord[nameKey];
        if (typeof callName === "string" && callName) {
          names.add(callName);
        }
      }
    }
  }

  return Array.from(names);
}

function summarizeValuePayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const structured = record.structuredResponse;
  if (structured && typeof structured === "object") {
    const structuredRecord = structured as Record<string, unknown>;
    const entityCount = Array.isArray(structuredRecord.entities) ? structuredRecord.entities.length : 0;
    return entityCount > 0
      ? `已收到最终结构化结果，包含 ${entityCount} 个实体文案结果。`
      : "已收到最终结构化结果。";
  }

  const messageCount = Array.isArray(record.messages) ? record.messages.length : 0;
  if (messageCount > 0) {
    return `状态已更新，当前累计 ${messageCount} 条消息。`;
  }

  const keys = getObjectKeys(payload);
  return keys.length > 0 ? `状态已更新，包含字段：${keys.join("、")}。` : null;
}

function logDeepAgentsChunk(mode: string, payload: unknown, trace: DeepAgentsTraceState): void {
  if (mode === "messages") {
    if (!trace.announcedModelOutput) {
      trace.announcedModelOutput = true;
    }

    if (Array.isArray(payload)) {
      const [message] = payload;
      const text = extractMessageText(message);
      if (text && text.trim()) {
        const summary = `模型正在生成内容，最近一段输出约 ${text.trim().length} 个字符。`;
        updateTodoBoard(trace, payload, summary);
        writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
      }
    } else {
      writeSystemTraceEvent(trace.logFilePath, mode, payload, "收到一条消息事件。");
    }
    return;
  }

  if (mode === "tools") {
    if (!trace.announcedToolPhase) {
      trace.announcedToolPhase = true;
    }

    const toolNames = extractToolNames(payload);
    if (toolNames.length > 0) {
      for (const toolName of toolNames) {
        if (!trace.seenToolCalls.has(toolName)) {
          trace.seenToolCalls.add(toolName);
        }
      }
      const summary = `正在调用工具：${toolNames.join("、")}。`;
      updateTodoBoard(trace, payload, summary);
      writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
    } else {
      const summary = "正在执行一次工具调用。";
      updateTodoBoard(trace, payload, summary);
      writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
    }
    return;
  }

  if (mode === "updates") {
    if (!trace.announcedUpdates) {
      trace.announcedUpdates = true;
    }

    const keys = getObjectKeys(payload);
    if (keys.length > 0) {
      const summary = `Agent 状态已更新，节点包括：${keys.join("、")}。`;
      updateTodoBoard(trace, payload, summary);
      writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
    } else {
      const summary = "Agent 状态已更新。";
      updateTodoBoard(trace, payload, summary);
      writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
    }
    return;
  }

  if (mode === "values") {
    const summary = summarizeValuePayload(payload);
    if (summary) {
      updateTodoBoard(trace, payload, summary);
      writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
    } else {
      const fallbackSummary = "已收到一份结果快照。";
      updateTodoBoard(trace, payload, fallbackSummary);
      writeSystemTraceEvent(trace.logFilePath, mode, payload, fallbackSummary);
    }
    return;
  }

  const summary = `收到 ${mode} 事件。`;
  updateTodoBoard(trace, payload, summary);
  writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
}

async function resolveModel(model: string) {
  if (model.includes(":")) {
    return model;
  }

  const { ChatOpenAI } = await import("@langchain/openai");
  const options: ConstructorParameters<typeof ChatOpenAI>[0] = {
    model,
  };

  if (process.env.OPENAI_API_KEY) {
    options.apiKey = process.env.OPENAI_API_KEY;
  }

  if (process.env.OPENAI_BASE_URL) {
    options.configuration = {
      baseURL: process.env.OPENAI_BASE_URL,
    };
  }

  return new ChatOpenAI(options);
}

export async function withActivityTimeout<T>(
  operation: (signalActivity: () => void) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      callback();
    };

    const scheduleTimeout = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        finish(() => reject(new Error(`${label} timed out after ${ms}ms without activity.`)));
      }, ms);
    };

    scheduleTimeout();

    operation(() => {
      if (!settled) {
        scheduleTimeout();
      }
    }).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function streamDeepAgentWithLogs(
  agent: { stream: (...args: any[]) => Promise<AsyncIterable<unknown>> },
  state: { messages: Array<{ role: string; content: string }> },
  runtime?: TextGeneratorRuntime,
  signalActivity?: () => void,
): Promise<unknown> {
  const stream = await agent.stream(state, {
    streamMode: resolveDeepagentsStreamModes(),
  } as any);

  let lastValuesChunk: unknown = null;
  const trace: DeepAgentsTraceState = {
    announcedModelOutput: false,
    announcedToolPhase: false,
    announcedUpdates: false,
    seenToolCalls: new Set<string>(),
    todos: [],
    lastNarrative: "准备启动生成流程。",
    renderedRows: 0,
    lastNonTtyTodoSignature: "",
    lastNonTtyNarrative: "",
  };

  if (runtime?.deepagentsLogPath) {
    trace.logFilePath = runtime.deepagentsLogPath;
  }

  writeSystemTraceEvent(trace.logFilePath, "lifecycle", { state }, "准备启动生成流程。");
  renderTodoBoard(trace);

  for await (const chunk of stream) {
    signalActivity?.();

    if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
      const [mode, payload] = chunk as [string, unknown];
      logDeepAgentsChunk(mode, payload, trace);
      if (mode === "values") {
        lastValuesChunk = payload;
      }
      continue;
    }

    const summary = "收到一条未分类事件。";
    updateTodoBoard(trace, chunk, summary);
    writeSystemTraceEvent(trace.logFilePath, "unclassified", chunk, summary);
    lastValuesChunk = chunk;
  }

  trace.lastNarrative = "生成流程结束。";
  writeSystemTraceEvent(trace.logFilePath, "lifecycle", { result: lastValuesChunk }, "生成流程结束。");
  renderTodoBoard(trace);
  return lastValuesChunk;
}

function extractStructuredResponse<T>(result: unknown, schema: z.ZodType<T>): T | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const structured = (result as Record<string, unknown>).structuredResponse;
  const parsed = schema.safeParse(structured);
  return parsed.success ? parsed.data : null;
}

export class DeepAgentsTextGenerator implements TextGenerator {
  constructor(
    private readonly model: string = process.env.APP_BUILDER_MODEL || "openai:gpt-4.1-mini",
  ) {}

  async generateProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    try {
      const deepagents = await loadDeepagentsModule();
      const createDeepAgent = deepagents.createDeepAgent;
      const resolvedModel = await resolveModel(this.model);
      const systemPromptPath =
        runtime.templateSystemPromptPath ??
        await resolveTemplateFilePath("full-stack", "prompts/system-prompt.md");
      const systemPrompt = await loadSystemPrompt(systemPromptPath);
      const skillsDirectory = path.join(runtime.templateDirectory, "skills");

      if (runtime.deepagentsPromptSnapshotPath) {
        await fs.writeFile(runtime.deepagentsPromptSnapshotPath, systemPrompt, "utf8");
      }

      const agentOptions: any = {
        model: resolvedModel,
        responseFormat: toolStrategy(generatedProjectSchema),
        systemPrompt,
      };

      if (await pathExists(skillsDirectory)) {
        agentOptions.skills = [".deepagents/skills"];
      }

      agentOptions.backend = new deepagents.FilesystemBackend({
        rootDir: runtime.outputDirectory,
        virtualMode: true,
      });

      const agent = createDeepAgent(agentOptions);

      const state = {
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              appName: spec.appName,
              summary: spec.summary,
              entities: spec.entities,
              roles: spec.roles,
              flows: spec.flows,
              businessRules: spec.businessRules,
              template: {
                id: runtime.templateId,
                name: runtime.templateName,
                version: runtime.templateVersion,
                directory: path.relative(runtime.outputDirectory, runtime.templateDirectory).split(path.sep).join("/"),
              },
              generationPolicy: {
                dataMode: "rest_api",
                requireExplicitDataModelBeforeCodegen: true,
                maxAnalysisRetries: runtime.maxAnalysisRetries ?? 0,
                analysisAttempt: runtime.analysisAttempt ?? 1,
                retryStage: runtime.retryStage ?? "计划阶段",
                retryReasons: runtime.retryReasons ?? [],
              },
              artifacts: {
                sourcePrd: path.relative(runtime.outputDirectory, runtime.sourcePrdSnapshotPath).split(path.sep).join("/"),
                analysis: path.relative(runtime.outputDirectory, runtime.deepagentsAnalysisPath).split(path.sep).join("/"),
                generatedSpec: path.relative(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath).split(path.sep).join("/"),
                errorLog: path.relative(runtime.outputDirectory, runtime.deepagentsErrorLogPath).split(path.sep).join("/"),
              },
            }),
          },
        ],
      };

      const result = await withActivityTimeout(
        (signalActivity) => streamDeepAgentWithLogs(agent as any, state, runtime, signalActivity),
        DEEPAGENTS_IDLE_TIMEOUT_MS,
        "deepagents generation",
      );

      const structured = extractStructuredResponse(result, generatedProjectSchema);
      if (!structured) {
        throw new Error("deepagents did not return a valid structured response.");
      }

      return structured;
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
  }
}
