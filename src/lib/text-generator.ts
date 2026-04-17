import { appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

import { toolStrategy } from "langchain";
import { z } from "zod";

import { type PlanSpec, planSpecSchema } from "./plan-spec.js";
import { buildSessionPolicyDocument, composeStageSystemPrompt, type SessionPolicyStage } from "./session-policy.js";
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
  formatElapsedTime,
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

async function loadSystemPrompt(
  runtime: Pick<TextGeneratorRuntime, "deepagentsAgentsPath">,
  systemPromptPath: string,
  stage: SessionPolicyStage,
): Promise<string> {
  const [templatePrompt, sessionPolicy] = await Promise.all([
    fs.readFile(systemPromptPath, "utf8"),
    fs.readFile(runtime.deepagentsAgentsPath, "utf8").catch(() => buildSessionPolicyDocument()),
  ]);
  return composeStageSystemPrompt(stage, templatePrompt, sessionPolicy);
}

export async function materializeSessionPromptSnapshots(
  runtime: Pick<
    TextGeneratorRuntime,
    | "deepagentsAgentsPath"
    | "templatePlanPromptPath"
    | "templatePlanRepairPromptPath"
    | "templateGeneratePromptPath"
    | "templateGenerateRepairPromptPath"
    | "deepagentsPlanPromptSnapshotPath"
    | "deepagentsPlanRepairPromptSnapshotPath"
    | "deepagentsGeneratePromptSnapshotPath"
    | "deepagentsGenerateRepairPromptSnapshotPath"
  >,
): Promise<void> {
  const promptPairs: Array<{
    sourcePath: string;
    snapshotPath: string;
    stage: SessionPolicyStage;
  }> = [
    {
      sourcePath: runtime.templatePlanPromptPath,
      snapshotPath: runtime.deepagentsPlanPromptSnapshotPath,
      stage: "plan",
    },
    {
      sourcePath: runtime.templatePlanRepairPromptPath,
      snapshotPath: runtime.deepagentsPlanRepairPromptSnapshotPath,
      stage: "plan_repair",
    },
    {
      sourcePath: runtime.templateGeneratePromptPath,
      snapshotPath: runtime.deepagentsGeneratePromptSnapshotPath,
      stage: "generate",
    },
    {
      sourcePath: runtime.templateGenerateRepairPromptPath,
      snapshotPath: runtime.deepagentsGenerateRepairPromptSnapshotPath,
      stage: "generate_repair",
    },
  ];

  await Promise.all(
    promptPairs.map(async (promptPair) => {
      const prompt = await loadSystemPrompt(runtime, promptPair.sourcePath, promptPair.stage);
      await fs.writeFile(promptPair.snapshotPath, prompt, "utf8");
    }),
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function toVirtualWorkspacePath(outputDirectory: string, targetPath: string): string {
  const relativePath = path.relative(outputDirectory, targetPath).split(path.sep).join("/");
  if (!relativePath || relativePath === ".") {
    return "/";
  }
  return relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
}

export function buildPlanSpecHardConstraints(
  runtime: Pick<TextGeneratorRuntime, "outputDirectory" | "deepagentsPlanSpecPath">,
): Record<string, unknown> {
  return {
    planSpecSchemaValidation: {
      artifactKey: "artifacts.planSpec",
      artifactPath: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanSpecPath),
      blocking: true,
      required: true,
      mustValidateBeforeResponse: true,
      schema: z.toJSONSchema(planSpecSchema),
      rules: [
        "artifacts.planSpec 必须是合法 JSON。",
        "artifacts.planSpec 必须通过这里提供的 schema 校验后，才允许结束当前阶段并返回结构化响应。",
        "可选字符串字段如果没有值，必须省略，不能写成空字符串。",
        "必填字符串字段必须提供非空字符串。",
      ],
    },
  };
}

export function buildPlanProjectPayload(
  spec: NormalizedSpec,
  runtime: TextGeneratorRuntime,
): Record<string, unknown> {
  return {
    stage: "璁″垝闃舵",
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
      directory: toVirtualWorkspacePath(runtime.outputDirectory, runtime.templateDirectory),
      runtimeValidation: runtime.templateRuntimeValidation,
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
      sourcePrd: toVirtualWorkspacePath(runtime.outputDirectory, runtime.sourcePrdSnapshotPath),
      analysis: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsAnalysisPath),
      generatedSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath),
      planSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanSpecPath),
      planValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanValidationPath),
      generationValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath),
      errorLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsErrorLogPath),
    },
    planSpecSchema: z.toJSONSchema(planSpecSchema),
    hardConstraints: buildPlanSpecHardConstraints(runtime),
  };
}

export function buildPlanRepairPayload(runtime: TextGeneratorRuntime): Record<string, unknown> {
  return {
    stage: "璁″垝淇闃舵",
    template: {
      id: runtime.templateId,
      name: runtime.templateName,
      version: runtime.templateVersion,
      directory: toVirtualWorkspacePath(runtime.outputDirectory, runtime.templateDirectory),
      runtimeValidation: runtime.templateRuntimeValidation,
    },
    planRepairPolicy: {
      planSpecVersion: 1,
      requireStructuredModelDefinitions: true,
      attempt: runtime.planAttempt ?? 1,
      maxRepairs: runtime.maxPlanRetries ?? 0,
      validationFailures: runtime.retryReasons ?? [],
    },
    artifacts: {
      sourcePrd: toVirtualWorkspacePath(runtime.outputDirectory, runtime.sourcePrdSnapshotPath),
      analysis: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsAnalysisPath),
      generatedSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath),
      planSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanSpecPath),
      planValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanValidationPath),
      errorLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsErrorLogPath),
    },
    planSpecSchema: z.toJSONSchema(planSpecSchema),
    hardConstraints: buildPlanSpecHardConstraints(runtime),
  };
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

let lastTodoStatuses = new Map<string, TodoStatus>();

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

function extractTodosFromText(value: string): TodoItem[] | null {
  const match = value.match(/Updated todo list to (\[[\s\S]*\])$/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]!);
    return isTodoList(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractTodosFromToolOutput(value: unknown): TodoItem[] | null {
  const extracted = extractTodosFromPayload(value);
  if (extracted) {
    return extracted;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const content = record.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      return typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
    })
    .filter(Boolean)
    .join("\n");

  return text ? extractTodosFromText(text) : null;
}

function summarizeWriteTodosEvent(record: Record<string, unknown>, event: string | null): string | null {
  const parsedInput = parseToolInput(record.input);
  const todos =
    extractTodosFromPayload(parsedInput) ??
    extractTodosFromToolOutput(record.output);

  if (!todos) {
    return null;
  }

  if (event === "on_tool_start") {
    return null;
  }

  if (event === "on_tool_end") {
    const newlyCompleted = todos.filter((todo) => {
      const previousStatus = lastTodoStatuses.get(todo.content);
      return todo.status === "completed" && previousStatus !== "completed";
    });
    const newlyStarted = todos.filter((todo) => {
      const previousStatus = lastTodoStatuses.get(todo.content);
      return todo.status === "in_progress" && previousStatus !== "in_progress" && previousStatus !== "completed";
    });

    lastTodoStatuses = new Map(todos.map((todo) => [todo.content, todo.status]));

    if (newlyCompleted.length > 0) {
      return `${newlyCompleted[newlyCompleted.length - 1]!.content}工作完成。`;
    }

    if (newlyStarted.length > 0) {
      return `${newlyStarted[newlyStarted.length - 1]!.content}工作开始。`;
    }

    return null;
  }

  lastTodoStatuses = new Map(todos.map((todo) => [todo.content, todo.status]));
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

function formatReadFileRange(input: Record<string, unknown> | null): string | null {
  if (!input) {
    return null;
  }

  const offset = typeof input.offset === "number" && Number.isFinite(input.offset) ? input.offset : null;
  const limit = typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : null;

  if (offset === null && limit === null) {
    return "全量";
  }

  if (offset !== null && limit !== null && limit > 0) {
    const start = Math.max(1, Math.floor(offset) + 1);
    const end = Math.max(start, Math.floor(offset + limit));
    return `${start}-${end}行`;
  }

  if (offset !== null && limit === null) {
    return `第${Math.max(1, Math.floor(offset) + 1)}行起`;
  }

  if (offset === null && limit !== null && limit > 0) {
    return `1-${Math.floor(limit)}行`;
  }

  return null;
}

function describeToolLocation(toolName: string, input: Record<string, unknown> | null): string | null {
  if (toolName === "read_file") {
    return formatReadFileRange(input);
  }

  return null;
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

  if (toolName === "write_todos") {
    return summarizeWriteTodosEvent(record, event);
  }

  const parsedInput = parseToolInput(record.input);
  const target = describeToolTarget(toolName, payload);
  const location = describeToolLocation(toolName, parsedInput);
  const action = humanizeToolName(toolName);
  const detailedTarget =
    target && target !== toolName
      ? `${target.replace(`${toolName} `, "")}${location ? `（${location}）` : ""}`
      : null;

  if (event === "on_tool_start") {
    return detailedTarget ? `${action}：${detailedTarget}` : `${action}。`;
  }

  if (event === "on_tool_end") {
    return detailedTarget ? `${action}完成：${detailedTarget}` : `${action} 完成。`;
  }

  return detailedTarget ? `${action}：${detailedTarget}` : `${action}。`;
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
  const location = describeToolLocation(first.name, args);

  if (typeof target === "string" && target.trim()) {
    return `准备${action}：${target}${location ? `（${location}）` : ""}`;
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
  runtime?: TextGeneratorRuntime,
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
    ...(runtime ? { sessionId: runtime.sessionId } : {}),
    ...(runtime ? { outputDirectory: runtime.outputDirectory } : {}),
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
  runtime?: TextGeneratorRuntime,
): Promise<void> {
  const summary = summarizeDeepAgentsAction(mode, payload);
  if (shouldAppendDetailedLog(mode, summary)) {
    await appendWorkflowLog(`[${mode}] ${summary}`);
  }
  await updateTodoBoard(trace, payload, summary, runtime);
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
    sessionId: runtime.sessionId,
    outputDirectory: runtime.outputDirectory,
  });

  const stream = await agent.stream(state, {
    streamMode: resolveDeepagentsStreamModes(),
  });

  let lastValuesChunk: unknown = null;

  for await (const chunk of stream) {
    signalActivity?.();

    if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
      const [mode, payload] = chunk as [string, unknown];
      await logDeepAgentsChunk(mode, payload, trace, runtime);
      if (mode === "values") {
        lastValuesChunk = payload;
      }
      continue;
    }

    const summary = "收到一条未分类事件。";
    await updateTodoBoard(trace, chunk, summary, runtime);
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
    sessionId: runtime.sessionId,
    outputDirectory: runtime.outputDirectory,
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
      stage: SessionPolicyStage;
      timeoutLabel: string;
    },
  ): Promise<T> {
    const deepagents = await loadDeepagentsModule();
    const createDeepAgent = deepagents.createDeepAgent;
    const resolvedModel = await resolveModel(this.model);
    const systemPrompt = await loadSystemPrompt(runtime, options.promptPath, options.stage);
    const skillsDirectory = path.join(runtime.templateDirectory, "skills");

    await fs.writeFile(options.promptSnapshotPath, systemPrompt, "utf8");

    const agentOptions: any = {
      model: resolvedModel,
      responseFormat: toolStrategy(options.responseSchema),
      systemPrompt,
    };

    if (await pathExists(skillsDirectory)) {
      agentOptions.skills = ["/.deepagents/skills"];
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
        stage: "plan",
        timeoutLabel: "deepagents planning",
        payload: buildPlanProjectPayload(spec, runtime),
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
        stage: "plan_repair",
        timeoutLabel: "deepagents plan repair",
        payload: buildPlanRepairPayload(runtime),
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
        stage: "generate",
        timeoutLabel: "deepagents generation",
        payload: {
          stage: "生成阶段",
          planSpec,
          template: {
            id: runtime.templateId,
            name: runtime.templateName,
            version: runtime.templateVersion,
            directory: toVirtualWorkspacePath(runtime.outputDirectory, runtime.templateDirectory),
            runtimeValidation: runtime.templateRuntimeValidation,
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
            analysis: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsAnalysisPath),
            generatedSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath),
            planSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanSpecPath),
            generationValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath),
            runtimeValidationLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsRuntimeValidationLogPath),
            planValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanValidationPath),
            report: "/app-builder-report.md",
            errorLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsErrorLogPath),
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
        stage: "generate_repair",
        timeoutLabel: "deepagents generation repair",
        payload: {
          stage: "生成修复阶段",
          planSpec,
          template: {
            id: runtime.templateId,
            name: runtime.templateName,
            version: runtime.templateVersion,
            directory: toVirtualWorkspacePath(runtime.outputDirectory, runtime.templateDirectory),
            runtimeValidation: runtime.templateRuntimeValidation,
          },
          generationRepairPolicy: {
            dataMode: "rest_api",
            attempt: runtime.generateAttempt ?? 1,
            maxRepairs: runtime.maxGenerateRetries ?? 0,
            validationFailures: runtime.retryReasons ?? [],
          },
          artifacts: {
            analysis: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsAnalysisPath),
            generatedSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsDetailedSpecPath),
            planSpec: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanSpecPath),
            generationValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath),
            runtimeValidationLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsRuntimeValidationLogPath),
            planValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanValidationPath),
            report: "/app-builder-report.md",
            errorLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsErrorLogPath),
          },
        },
      });
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
  }
}
