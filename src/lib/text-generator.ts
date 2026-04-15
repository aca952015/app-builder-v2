import { appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

import { toolStrategy } from "langchain";
import { z } from "zod";

import { type PlanSpec, planSpecSchema } from "./plan-spec.js";
import { resolveTemplateFilePath } from "./template-pack.js";
import {
  appendWorkflowLog,
  createArtifactItemsForStage,
  createDefaultStepItems,
  type TodoItem,
  type TodoStatus,
  updateWorkflowBoard,
} from "./terminal-ui.js";
import { GeneratedProject, NormalizedSpec, PlanResult, TextGenerator, TextGeneratorRuntime } from "./types.js";

export {
  buildTodoBoardLines,
  createArtifactItemsForStage,
  createStepItemsForLifecycle,
  estimateRenderedRows,
  formatWorkflowStageLine,
  formatTodoHeader,
  renderArtifactStatus,
  renderTodoBoardToString,
  renderTodoStatus,
  stripAnsi,
} from "./terminal-ui.js";

const planResultSchema = z.object({
  summary: z.string(),
  artifactsWritten: z.array(z.string()).default([]),
  planSpecVersion: z.number().int().default(1),
  notes: z.array(z.string()).default([]),
});

const generatedProjectSchema = z.object({
  summary: z.string(),
  filesWritten: z.array(z.string()).default([]),
  implementedResources: z.array(z.string()).default([]),
  implementedPages: z.array(z.string()).default([]),
  implementedApis: z.array(z.string()).default([]),
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
  stage: "计划阶段" | "生成阶段";
  todos: TodoItem[];
  lastNarrative: string;
  logFilePath?: string;
};

type ToolCallDetail = {
  id: string | undefined;
  name: string | undefined;
  args: unknown;
  status: unknown;
  result: unknown;
};

function defaultTodosForStage(stage: "计划阶段" | "生成阶段"): TodoItem[] {
  return createDefaultStepItems(stage);
}

function isTodoList(
  value: unknown,
): value is TodoItem[] {
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

function extractTodosFromPayload(value: unknown): TodoItem[] | null {
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

function summarizeToolCall(toolCall: ToolCallDetail): string {
  const name = toolCall.name ?? "未知工具";
  const status = typeof toolCall.status === "string" ? toolCall.status : "执行中";
  return `工具 ${name} ${status}`;
}

function extractToolCalls(payload: unknown): ToolCallDetail[] {
  if (Array.isArray(payload)) {
    const direct = payload.filter(
      (item): item is ToolCallDetail =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as { name?: unknown }).name === "string",
    );
    const nested = payload.flatMap((item) => extractToolCalls(item));
    return [...direct, ...nested];
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.tool_calls)) {
    return record.tool_calls.filter((item): item is ToolCallDetail => item !== null && typeof item === "object");
  }

  return [];
}

function parseToolInput(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function describeToolTarget(toolName: string, payload: unknown): string | null {
  if (toolName === "write_todos") {
    return null;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const parsedInput = parseToolInput(record.input);
  const target =
    parsedInput?.file_path ??
    parsedInput?.path ??
    parsedInput?.target_file ??
    parsedInput?.targetPath;

  if (typeof target === "string" && target.trim()) {
    return `${toolName} ${target}`;
  }

  return toolName;
}

function humanizeToolName(toolName: string): string {
  switch (toolName) {
    case "read_file":
      return "读取文件";
    case "write_file":
      return "写入文件";
    case "edit_file":
      return "编辑文件";
    case "write_todos":
      return "更新 todo";
    case "list_dir":
      return "列出目录";
    case "glob_search":
      return "搜索文件";
    default:
      return `调用工具 ${toolName}`;
  }
}

function summarizeToolEvent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const toolName = typeof record.name === "string" ? record.name : null;
  const event = typeof record.event === "string" ? record.event : null;

  if (!toolName) {
    return null;
  }

  const target = describeToolTarget(toolName, payload);
  const action = humanizeToolName(toolName);

  if (event === "on_tool_start") {
    return target && target !== toolName ? `${action}：${target.replace(`${toolName} `, "")}` : `${action}。`;
  }

  if (event === "on_tool_end") {
    return target && target !== toolName ? `${action}完成：${target.replace(`${toolName} `, "")}` : `${action} 完成。`;
  }

  return target && target !== toolName ? `${action}：${target.replace(`${toolName} `, "")}` : `${action}。`;
}

function summarizeMessageToolCall(payload: unknown): string | null {
  const toolCalls = extractToolCalls(payload);
  const first = toolCalls.find((toolCall) => typeof toolCall.name === "string");
  if (!first?.name) {
    return null;
  }

  const action = humanizeToolName(first.name);
  const args = first.args && typeof first.args === "object" ? first.args as Record<string, unknown> : null;
  const target = args?.file_path ?? args?.path;

  if (typeof target === "string" && target.trim()) {
    return `准备${action}：${target}`;
  }

  return `准备${action}。`;
}

export function summarizeDeepAgentsAction(mode: string, payload: unknown): string {
  if (mode === "updates") {
    const messageText = extractMessageText(payload)?.trim();
    return messageText && messageText.length > 0 ? messageText : "收到一条进度更新。";
  }

  if (mode === "messages") {
    const toolSummary = summarizeMessageToolCall(payload);
    if (toolSummary) {
      return toolSummary;
    }

    const messageText = extractMessageText(payload)?.trim();
    return messageText && messageText.length > 0 ? messageText : "模型正在思考。";
  }

  if (mode === "tools") {
    const toolSummary = summarizeToolEvent(payload);
    if (toolSummary) {
      return toolSummary;
    }

    if (Array.isArray(payload) && payload.length > 0 && payload.every((item) => item && typeof item === "object")) {
      const first = payload[0] as ToolCallDetail;
      return summarizeToolCall(first);
    }

    return "收到工具调用事件。";
  }

  if (mode === "values") {
    return "正在生成结构化结果。";
  }

  return `收到 ${mode} 事件。`;
}

function shouldAppendDetailedLog(mode: string, summary: string): boolean {
  if (
    summary === "模型正在思考。" ||
    summary === "收到一条进度更新。" ||
    summary === "收到工具调用事件。" ||
    summary === "正在生成结构化结果。"
  ) {
    return false;
  }

  if (/^收到 .+ 事件。$/.test(summary) || summary === "收到一条未分类事件。") {
    return false;
  }

  if (/^准备/.test(summary)) {
    return false;
  }

  if ((mode === "messages" || mode === "updates") && !/[：:/.\[\]0-9A-Za-z\u4e00-\u9fff-]{4,}/.test(summary)) {
    return false;
  }

  return true;
}

function inferTodoStatusesFromNarrative(
  stage: "计划阶段" | "生成阶段",
  narrative: string,
): TodoStatus[] {
  const lower = narrative.toLowerCase();

  if (stage === "计划阶段") {
    if (/结构化输出|生成流程结束|plan-spec|校验/.test(narrative)) {
      return ["completed", "completed", "completed", "in_progress"];
    }
    if (/write_file|edit_file|generated-spec|analysis|分析稿|spec/.test(lower + narrative)) {
      return ["completed", "in_progress", "pending", "pending"];
    }
    return ["in_progress", "pending", "pending", "pending"];
  }

  if (/结构化输出|生成流程结束|report|校验/.test(narrative)) {
    return ["completed", "completed", "completed", "in_progress"];
  }
  if (/write_file|edit_file|api|route|prisma|resource/.test(lower + narrative)) {
    return ["completed", "in_progress", "pending", "pending"];
  }
  if (/page|页面|report|sidebar|layout/.test(lower + narrative)) {
    return ["completed", "completed", "in_progress", "pending"];
  }
  return ["in_progress", "pending", "pending", "pending"];
}

function applyFallbackTodos(trace: DeepAgentsTraceState): void {
  const defaults = defaultTodosForStage(trace.stage);
  const inferredStatuses = inferTodoStatusesFromNarrative(trace.stage, trace.lastNarrative);
  trace.todos = defaults.map((todo, index) => ({
    content: todo.content,
    status: inferredStatuses[index] ?? todo.status,
  }));
}

function ensureTraceState(trace: DeepAgentsTraceState, todoSummary: string): void {
  if (trace.todos.length === 0) {
    applyFallbackTodos(trace);
  }

  if (trace.todos.length === 0) {
    trace.lastNarrative = todoSummary;
  }
}

async function updateTodoBoard(
  trace: DeepAgentsTraceState,
  payload: unknown,
  fallbackSummary: string,
): Promise<void> {
  const extractedTodos = extractTodosFromPayload(payload);
  if (extractedTodos && extractedTodos.length > 0) {
    trace.todos = extractedTodos;
  }

  if (typeof payload === "string" && payload.trim()) {
    trace.lastNarrative = payload.trim();
  } else {
    const extractedMessage = extractMessageText(payload);
    trace.lastNarrative = extractedMessage?.trim() || fallbackSummary;
  }

  ensureTraceState(trace, fallbackSummary);
  await updateWorkflowBoard({
    stage: trace.stage,
    todos: trace.todos,
    artifacts: createArtifactItemsForStage(trace.stage, "generating"),
    narrative: trace.lastNarrative,
  });
}

function safeInspect(value: unknown): string {
  return inspect(value, {
    depth: 6,
    colors: false,
    compact: false,
    breakLength: 120,
    maxArrayLength: 50,
    maxStringLength: 2_000,
  });
}

export function formatDeepAgentsTraceEntry(mode: string, payload: unknown, summary: string): string {
  const lines = [`| ${mode.toUpperCase()} ===`, "Summary", summary];
  const toolCalls = extractToolCalls(payload);

  if (toolCalls.length > 0) {
    lines.push("Tool Calls");
    toolCalls.forEach((toolCall, index) => {
      lines.push(`${index + 1}. ${toolCall.name ?? "unknown"}`);
      if (toolCall.id) {
        lines.push(`id: ${toolCall.id}`);
      }
      if (toolCall.status) {
        lines.push(`status: ${String(toolCall.status)}`);
      }
      lines.push(safeInspect(toolCall.args));
      lines.push(safeInspect(toolCall.result));
    });
  }

  lines.push("Payload");
  lines.push(safeInspect(payload));
  return lines.join("\n");
}

async function writeErrorLog(logPath: string, error: unknown): Promise<void> {
  const content = [
    `[${new Date().toISOString()}]`,
    safeInspect(error),
    "",
  ].join("\n");

  await fs.appendFile(logPath, content, "utf8");
}

function writeSystemTraceEvent(logFilePath: string | undefined, mode: string, payload: unknown, summary: string): void {
  if (!logFilePath) {
    return;
  }

  const content = [
    `[${new Date().toISOString()}] ${mode}`,
    summary,
    safeInspect(payload),
    "",
  ].join("\n");
  appendFileSync(logFilePath, content, "utf8");
}

async function logDeepAgentsChunk(
  mode: string,
  payload: unknown,
  trace: DeepAgentsTraceState,
): Promise<void> {
  const summary = summarizeDeepAgentsAction(mode, payload);
  if (shouldAppendDetailedLog(mode, summary)) {
    await appendWorkflowLog(`[${mode}] ${summary}`);
  }
  await updateTodoBoard(trace, payload, summary);
  writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
}

export async function withActivityTimeout<T>(
  callback: (signalActivity: () => void) => Promise<T>,
  timeoutMs: number,
  timeoutLabel: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const resetTimer = () => {
      if (settled) {
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        settled = true;
        reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms without activity.`));
      }, timeoutMs);
    };

    resetTimer();

    callback(resetTimer).then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        reject(error);
      },
    );
  });
}

async function streamDeepAgentWithLogs(
  agent: {
    stream: (
      state: unknown,
      options: { streamMode: string[] },
    ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  },
  state: unknown,
  runtime: TextGeneratorRuntime,
  signalActivity?: () => void,
): Promise<unknown> {
  const trace: DeepAgentsTraceState = {
    stage: runtime.generateAttempt ? "生成阶段" : "计划阶段",
    todos: defaultTodosForStage(runtime.generateAttempt ? "生成阶段" : "计划阶段"),
    lastNarrative: "等待模型开始处理。",
    logFilePath: runtime.deepagentsLogPath,
  };
  await appendWorkflowLog(`[lifecycle] 进入${trace.stage}，开始流式生成。`);
  await updateWorkflowBoard({
    stage: trace.stage,
    todos: trace.todos,
    artifacts: createArtifactItemsForStage(trace.stage, "generating"),
    narrative: trace.lastNarrative,
  });

  const stream = await agent.stream(state, {
    streamMode: resolveDeepagentsStreamModes(),
  });

  let lastValuesChunk: unknown = null;

  for await (const chunk of stream) {
    signalActivity?.();

    if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
      const [mode, payload] = chunk as [string, unknown];
      await logDeepAgentsChunk(mode, payload, trace);
      if (mode === "values") {
        lastValuesChunk = payload;
      }
      continue;
    }

    const summary = "收到一条未分类事件。";
    await updateTodoBoard(trace, chunk, summary);
    writeSystemTraceEvent(trace.logFilePath, "unclassified", chunk, summary);
    lastValuesChunk = chunk;
  }

  trace.lastNarrative = "生成流程结束。";
  await appendWorkflowLog("[lifecycle] 本轮流式生成结束，等待宿主后续处理。");
  writeSystemTraceEvent(trace.logFilePath, "lifecycle", { result: lastValuesChunk }, "生成流程结束。");
  await updateWorkflowBoard({
    stage: trace.stage,
    todos: trace.todos,
    artifacts: createArtifactItemsForStage(trace.stage, "generating"),
    narrative: trace.lastNarrative,
  });

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

async function resolveModel(modelName: string) {
  const { initChatModel } = await import("langchain/chat_models/universal");
  return initChatModel(modelName, {
    modelProvider: "openai",
    temperature: 0,
    configuration: process.env.OPENAI_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL }
      : undefined,
  });
}

export class DeepAgentsTextGenerator implements TextGenerator {
  constructor(
    private readonly model: string = process.env.APP_BUILDER_MODEL || "openai:gpt-4.1-mini",
  ) {}

  private async runPhase<T>(
    runtime: TextGeneratorRuntime,
    options: {
      promptPath: string;
      promptSnapshotPath: string;
      responseSchema: z.ZodType<T>;
      payload: Record<string, unknown>;
      timeoutLabel: string;
    },
  ): Promise<T> {
    const deepagents = await loadDeepagentsModule();
    const createDeepAgent = deepagents.createDeepAgent;
    const resolvedModel = await resolveModel(this.model);
    const systemPrompt = await loadSystemPrompt(options.promptPath);
    const skillsDirectory = path.join(runtime.templateDirectory, "skills");

    await fs.writeFile(options.promptSnapshotPath, systemPrompt, "utf8");

    const agentOptions: any = {
      model: resolvedModel,
      responseFormat: toolStrategy(options.responseSchema),
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
          content: JSON.stringify(options.payload),
        },
      ],
    };

    const result = await withActivityTimeout(
      (signalActivity) => streamDeepAgentWithLogs(agent as any, state, runtime, signalActivity),
      DEEPAGENTS_IDLE_TIMEOUT_MS,
      options.timeoutLabel,
    );

    const structured = extractStructuredResponse(result, options.responseSchema);
    if (!structured) {
      throw new Error(`${options.timeoutLabel} did not return a valid structured response.`);
    }

    return structured;
  }

  async planProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    try {
      const planPromptPath =
        runtime.templatePlanPromptPath ??
        await resolveTemplateFilePath("full-stack", "prompts/plan-system-prompt.md");

      return await this.runPhase(runtime, {
        promptPath: planPromptPath,
        promptSnapshotPath: runtime.deepagentsPlanPromptSnapshotPath,
        responseSchema: planResultSchema,
        timeoutLabel: "deepagents planning",
        payload: {
          stage: "计划阶段",
          appName: spec.appName,
          summary: spec.summary,
          roles: spec.roles,
          entities: spec.entities,
          screens: spec.screens,
          flows: spec.flows,
          businessRules: spec.businessRules,
          sourcePrdMarkdown: spec.sourceMarkdown,
          template: {
            id: runtime.templateId,
            name: runtime.templateName,
            version: runtime.templateVersion,
            directory: path.relative(runtime.outputDirectory, runtime.templateDirectory).split(path.sep).join("/"),
          },
          planPolicy: {
            planSpecVersion: 1,
            requireStructuredModelDefinitions: true,
            attempt: runtime.planAttempt ?? 1,
            maxRetries: runtime.maxPlanRetries ?? 0,
            repairMode: false,
            retryReasons: runtime.retryReasons ?? [],
          },
          artifacts: {
            sourcePrd: path.relative(runtime.outputDirectory, runtime.sourcePrdSnapshotPath).split(path.sep).join("/"),
            analysis: path.relative(runtime.outputDirectory, runtime.deepagentsAnalysisPath).split(path.sep).join("/"),
            generatedSpec: path.relative(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath).split(path.sep).join("/"),
            planSpec: path.relative(runtime.outputDirectory, runtime.deepagentsPlanSpecPath).split(path.sep).join("/"),
            planValidation: path.relative(runtime.outputDirectory, runtime.deepagentsPlanValidationPath).split(path.sep).join("/"),
            generationValidation: path.relative(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath).split(path.sep).join("/"),
            errorLog: path.relative(runtime.outputDirectory, runtime.deepagentsErrorLogPath).split(path.sep).join("/"),
          },
          planSpecSchema: z.toJSONSchema(planSpecSchema),
        },
      });
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
  }

  async planRepairProject(runtime: TextGeneratorRuntime): Promise<PlanResult> {
    try {
      const planRepairPromptPath =
        runtime.templatePlanRepairPromptPath ??
        await resolveTemplateFilePath("full-stack", "prompts/plan-repair-system-prompt.md");

      return await this.runPhase(runtime, {
        promptPath: planRepairPromptPath,
        promptSnapshotPath: runtime.deepagentsPlanRepairPromptSnapshotPath,
        responseSchema: planResultSchema,
        timeoutLabel: "deepagents plan repair",
        payload: {
          stage: "计划修复阶段",
          template: {
            id: runtime.templateId,
            name: runtime.templateName,
            version: runtime.templateVersion,
            directory: path.relative(runtime.outputDirectory, runtime.templateDirectory).split(path.sep).join("/"),
          },
          planRepairPolicy: {
            planSpecVersion: 1,
            requireStructuredModelDefinitions: true,
            attempt: runtime.planAttempt ?? 1,
            maxRepairs: runtime.maxPlanRetries ?? 0,
            validationFailures: runtime.retryReasons ?? [],
          },
          artifacts: {
            sourcePrd: path.relative(runtime.outputDirectory, runtime.sourcePrdSnapshotPath).split(path.sep).join("/"),
            analysis: path.relative(runtime.outputDirectory, runtime.deepagentsAnalysisPath).split(path.sep).join("/"),
            generatedSpec: path.relative(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath).split(path.sep).join("/"),
            planSpec: path.relative(runtime.outputDirectory, runtime.deepagentsPlanSpecPath).split(path.sep).join("/"),
            planValidation: path.relative(runtime.outputDirectory, runtime.deepagentsPlanValidationPath).split(path.sep).join("/"),
            errorLog: path.relative(runtime.outputDirectory, runtime.deepagentsErrorLogPath).split(path.sep).join("/"),
          },
          planSpecSchema: z.toJSONSchema(planSpecSchema),
        },
      });
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    try {
      const generatePromptPath =
        runtime.templateGeneratePromptPath ??
        await resolveTemplateFilePath("full-stack", "prompts/generate-system-prompt.md");

      return await this.runPhase(runtime, {
        promptPath: generatePromptPath,
        promptSnapshotPath: runtime.deepagentsGeneratePromptSnapshotPath,
        responseSchema: generatedProjectSchema,
        timeoutLabel: "deepagents generation",
        payload: {
          stage: "生成阶段",
          planSpec,
          template: {
            id: runtime.templateId,
            name: runtime.templateName,
            version: runtime.templateVersion,
            directory: path.relative(runtime.outputDirectory, runtime.templateDirectory).split(path.sep).join("/"),
          },
          generationPolicy: {
            dataMode: "rest_api",
            requirePlanSpecAsOnlySourceOfTruth: true,
            attempt: runtime.generateAttempt ?? 1,
            maxRetries: runtime.maxGenerateRetries ?? 0,
            repairMode: false,
            retryReasons: runtime.retryReasons ?? [],
          },
          artifacts: {
            analysis: path.relative(runtime.outputDirectory, runtime.deepagentsAnalysisPath).split(path.sep).join("/"),
            generatedSpec: path.relative(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath).split(path.sep).join("/"),
            planSpec: path.relative(runtime.outputDirectory, runtime.deepagentsPlanSpecPath).split(path.sep).join("/"),
            generationValidation: path.relative(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath).split(path.sep).join("/"),
            planValidation: path.relative(runtime.outputDirectory, runtime.deepagentsPlanValidationPath).split(path.sep).join("/"),
            report: "app-builder-report.md",
            errorLog: path.relative(runtime.outputDirectory, runtime.deepagentsErrorLogPath).split(path.sep).join("/"),
          },
        },
      });
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
  }

  async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    try {
      const generateRepairPromptPath =
        runtime.templateGenerateRepairPromptPath ??
        await resolveTemplateFilePath("full-stack", "prompts/generate-repair-system-prompt.md");

      return await this.runPhase(runtime, {
        promptPath: generateRepairPromptPath,
        promptSnapshotPath: runtime.deepagentsGenerateRepairPromptSnapshotPath,
        responseSchema: generatedProjectSchema,
        timeoutLabel: "deepagents generation repair",
        payload: {
          stage: "生成修复阶段",
          planSpec,
          template: {
            id: runtime.templateId,
            name: runtime.templateName,
            version: runtime.templateVersion,
            directory: path.relative(runtime.outputDirectory, runtime.templateDirectory).split(path.sep).join("/"),
          },
          generationRepairPolicy: {
            dataMode: "rest_api",
            attempt: runtime.generateAttempt ?? 1,
            maxRepairs: runtime.maxGenerateRetries ?? 0,
            validationFailures: runtime.retryReasons ?? [],
          },
          artifacts: {
            analysis: path.relative(runtime.outputDirectory, runtime.deepagentsAnalysisPath).split(path.sep).join("/"),
            generatedSpec: path.relative(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath).split(path.sep).join("/"),
            planSpec: path.relative(runtime.outputDirectory, runtime.deepagentsPlanSpecPath).split(path.sep).join("/"),
            generationValidation: path.relative(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath).split(path.sep).join("/"),
            planValidation: path.relative(runtime.outputDirectory, runtime.deepagentsPlanValidationPath).split(path.sep).join("/"),
            report: "app-builder-report.md",
            errorLog: path.relative(runtime.outputDirectory, runtime.deepagentsErrorLogPath).split(path.sep).join("/"),
          },
        },
      });
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
  }
}
