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
const DEEPAGENTS_TIMEOUT_MS = 600_000;
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
  if (!process.stdout.isTTY || renderedRows === 0) {
    return;
  }

  readline.moveCursor(process.stdout, 0, -renderedRows);
  readline.clearScreenDown(process.stdout);
  readline.cursorTo(process.stdout, 0);
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

function writeTraceLog(logFilePath: string | undefined, lines: string[]): void {
  if (!logFilePath) {
    return;
  }

  appendFileSync(logFilePath, `[${new Date().toISOString()}]\n${lines.join("\n")}\n\n`, "utf8");
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
  writeTraceLog(trace.logFilePath, buildTodoBoardLines(trace));
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
        updateTodoBoard(trace, payload, `模型正在生成内容，最近一段输出约 ${text.trim().length} 个字符。`);
      }
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
      updateTodoBoard(trace, payload, `正在调用工具：${toolNames.join("、")}。`);
    } else {
      updateTodoBoard(trace, payload, "正在执行一次工具调用。");
    }
    return;
  }

  if (mode === "updates") {
    if (!trace.announcedUpdates) {
      trace.announcedUpdates = true;
    }

    const keys = getObjectKeys(payload);
    if (keys.length > 0) {
      updateTodoBoard(trace, payload, `Agent 状态已更新，节点包括：${keys.join("、")}。`);
    } else {
      updateTodoBoard(trace, payload, "Agent 状态已更新。");
    }
    return;
  }

  if (mode === "values") {
    const summary = summarizeValuePayload(payload);
    if (summary) {
      updateTodoBoard(trace, payload, summary);
    } else {
      updateTodoBoard(trace, payload, "已收到一份结果快照。");
    }
    return;
  }

  updateTodoBoard(trace, payload, `收到 ${mode} 事件。`);
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

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms.`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function streamDeepAgentWithLogs(
  agent: { stream: (...args: any[]) => Promise<AsyncIterable<unknown>> },
  state: { messages: Array<{ role: string; content: string }> },
  runtime?: TextGeneratorRuntime,
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

  writeTraceLog(trace.logFilePath, buildTodoBoardLines(trace));
  renderTodoBoard(trace);

  for await (const chunk of stream) {
    if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
      const [mode, payload] = chunk as [string, unknown];
      logDeepAgentsChunk(mode, payload, trace);
      if (mode === "values") {
        lastValuesChunk = payload;
      }
      continue;
    }

    updateTodoBoard(trace, chunk, "收到一条未分类事件。");
    lastValuesChunk = chunk;
  }

  trace.lastNarrative = "生成流程结束。";
  writeTraceLog(trace.logFilePath, buildTodoBoardLines(trace));
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
              artifacts: {
                sourcePrd: path.relative(runtime.outputDirectory, runtime.sourcePrdSnapshotPath).split(path.sep).join("/"),
                normalizedSpec: path.relative(runtime.outputDirectory, runtime.normalizedSpecSnapshotPath).split(path.sep).join("/"),
                analysis: path.relative(runtime.outputDirectory, runtime.deepagentsAnalysisPath).split(path.sep).join("/"),
                generatedSpec: path.relative(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath).split(path.sep).join("/"),
                errorLog: path.relative(runtime.outputDirectory, runtime.deepagentsErrorLogPath).split(path.sep).join("/"),
              },
            }),
          },
        ],
      };

      const result = await withTimeout(
        streamDeepAgentWithLogs(agent as any, state, runtime),
        DEEPAGENTS_TIMEOUT_MS,
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
