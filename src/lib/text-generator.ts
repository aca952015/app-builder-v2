import { appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

import { toolStrategy } from "langchain";
import { z } from "zod";

import { type PlanSpec, planSpecSchema } from "./plan-spec.js";
import { createOpenAICompatibleModel } from "./deepseek-openai.js";
import {
  DEFAULT_MODEL_NAME,
  resolveModelRoleConfigs,
  type ModelRole,
  type ModelRoleConfig,
  type ModelRoleConfigMap,
} from "./model-config.js";
import { buildSessionPolicyDocument, composeStageSystemPrompt, type SessionPolicyStage } from "./session-policy.js";
import { resolveTemplateFilePath } from "./template-pack.js";
import {
  appendWorkflowLog,
  createArtifactItemsForStage,
  createDefaultStepItems,
  type TodoBoardState,
  type TodoItem,
  type TodoStatus,
  updateWorkflowBoard,
} from "./terminal-ui.js";
import {
  GeneratedProject,
  NormalizedSpec,
  PlanResult,
  ReferenceMarkdownConversionInput,
  ReferenceMarkdownConversionResult,
  RuntimeStatus,
  RuntimeStatusPhase,
  RuntimeUsageSummary,
  TemplatePhaseEffort,
  TemplatePhaseMap,
  TextGenerator,
  TextGeneratorRuntime,
} from "./types.js";
import {
  appendWorkflowMetricRecord,
  buildWorkflowMetricRecord,
  type WorkflowMetricPhase,
} from "./workflow-metrics.js";

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

const referenceMarkdownConversionSchema = z.object({
  markdown: z.string().min(1),
  notes: z.array(z.string()).default([]),
});

const REFERENCE_MARKDOWN_CONVERSION_SYSTEM_PROMPT = [
  "# API Reference Markdown Conversion",
  "",
  "You convert a downloaded external API or documentation page into directly readable Markdown for later planning and code generation.",
  "",
  "Rules:",
  "- Preserve API endpoints, HTTP methods, authentication requirements, parameters, request formats, response fields, examples, rate limits, and error codes.",
  "- Remove navigation, menus, breadcrumbs, footers, ads, cookie banners, scripts, styles, and unrelated boilerplate.",
  "- Output pure Markdown only in `markdown`; do not return HTML.",
  "- Do not replace the source with a summary. Keep the source-level details that another model needs to implement API calls correctly.",
  "- If the document is sparse or extraction is uncertain, keep the original key fragments as Markdown text instead of inventing missing details.",
  "- Keep code blocks and tables when they clarify requests, responses, or examples.",
  "",
  "Return a structured response with:",
  "- `markdown`: the readable Markdown document.",
  "- `notes`: short notes about removed noise or extraction uncertainty.",
].join("\n");

const SANDBOX_ALPHA_WARNING =
  "langsmith/experimental/sandbox is in alpha. This feature is experimental, and breaking changes are expected.";
const DEEPAGENTS_IDLE_TIMEOUT_MS = 600_000;
const DEEPAGENTS_STREAM_COMPAT_RETRY_LIMIT = 1;
const DEFAULT_DEEPAGENTS_STREAM_MODES = ["updates", "messages", "tools", "values"] as const;
const VALID_DEEPAGENTS_STREAM_MODES = new Set<string>(DEFAULT_DEEPAGENTS_STREAM_MODES);

type DeepAgentRunner = {
  stream: (
    state: unknown,
    options: { streamMode: string[] },
  ) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
};

type StreamProgressSummary = {
  receivedOutputTokens?: number | undefined;
  receivedOutputTokensEstimated?: boolean | undefined;
};

type TodoTimingEntry = {
  status: TodoStatus;
  firstSeenAt: Date;
  firstSeenHr: bigint;
  startedAt?: Date;
  startedHr?: bigint;
  completedReported: boolean;
  openReported: boolean;
};

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
  runtime: Pick<TextGeneratorRuntime, "outputDirectory" | "deepagentsPlanSpecPath" | "deepagentsInteractionContractPath" | "deepagentsReferenceManifestPath">,
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
    interactionContractValidation: {
      artifactKey: "artifacts.interactionContract",
      artifactPath: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsInteractionContractPath),
      blocking: true,
      required: true,
      mustValidateBeforeResponse: true,
      rules: [
        "artifacts.interactionContract 必须是合法 JSON 对象。",
        "必须覆盖关键用户流程的触发控件、fallback 触发、loading/empty/error 状态。",
        "如果包含外部 API 或第三方服务，必须写明 endpoint path、认证来源、参数格式/顺序、响应字段和 reference provenance。",
        "如果没有关键交互或外部操作，也必须写入空数组结构，不能省略该 artifact。",
      ],
    },
    referenceUsageValidation: {
      artifactKey: "artifacts.referenceManifest",
      artifactPath: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsReferenceManifestPath),
      blocking: true,
      required: true,
      mustValidateBeforeResponse: true,
      rules: [
        "如果输入 externalReferences/localReferences/referenceManifest 中存在 retrievalStatus=downloaded 的外部 API、第三方服务或文档资料，必须先读取其 localPath 指向的本地文件，再组装 artifacts.generatedSpec、artifacts.planSpec 和 artifacts.interactionContract。",
        "外部 API endpoint、认证方式、参数格式/顺序、响应字段、错误码和限制信息必须优先来自已下载本地资料，不能凭模型记忆或远程 URL 猜测。",
        "artifacts.generatedSpec 的 References 章节必须在远程 URL 旁写出同一个 localPath，并说明关键 API/认证/参数/响应字段来自该本地文件。",
        "artifacts.planSpec.references[*] 对应已下载资料时必须填写 localPath、retrievedAt、contentType、retrievalStatus；不得只保留远程 URL。",
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
    externalReferences: spec.externalReferences,
    template: {
      id: runtime.templateId,
      name: runtime.templateName,
      version: runtime.templateVersion,
      directory: toVirtualWorkspacePath(runtime.outputDirectory, runtime.templateDirectory),
      runtimeValidation: runtime.templateRuntimeValidation,
      interactiveRuntimeValidation: runtime.templateInteractiveRuntimeValidation,
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
      interactionContract: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsInteractionContractPath),
      planValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanValidationPath),
      referenceManifest: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsReferenceManifestPath),
      generationValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath),
      runtimeInteractionValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsRuntimeInteractionValidationPath),
      errorLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsErrorLogPath),
    },
    localReferences: runtime.localReferences ?? [],
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
      interactiveRuntimeValidation: runtime.templateInteractiveRuntimeValidation,
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
      interactionContract: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsInteractionContractPath),
      planValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanValidationPath),
      referenceManifest: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsReferenceManifestPath),
      errorLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsErrorLogPath),
    },
    localReferences: runtime.localReferences ?? [],
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readStringField(record: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function readNumberField(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const value = record[key];
    if (isFiniteNumber(value)) {
      return value;
    }
  }

  return undefined;
}

function readObjectField(record: Record<string, unknown> | null, keys: string[]): Record<string, unknown> | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }

  return null;
}

function hasRuntimeUsageSummary(usage?: RuntimeUsageSummary): usage is RuntimeUsageSummary {
  return Boolean(
    usage &&
      (isFiniteNumber(usage.inputTokens) ||
        isFiniteNumber(usage.outputTokens) ||
        isFiniteNumber(usage.totalTokens) ||
        isFiniteNumber(usage.reasoningTokens) ||
        isFiniteNumber(usage.cachedInputTokens)),
  );
}

function mergeRuntimeUsageSummary(
  current?: RuntimeUsageSummary,
  patch?: RuntimeUsageSummary,
): RuntimeUsageSummary | undefined {
  const mergeValue = (left?: number, right?: number): number | undefined => {
    if (!isFiniteNumber(right)) {
      return left;
    }

    return (left ?? 0) + right;
  };

  const merged: RuntimeUsageSummary = {
    inputTokens: mergeValue(current?.inputTokens, patch?.inputTokens),
    outputTokens: mergeValue(current?.outputTokens, patch?.outputTokens),
    totalTokens: mergeValue(current?.totalTokens, patch?.totalTokens),
    reasoningTokens: mergeValue(current?.reasoningTokens, patch?.reasoningTokens),
    cachedInputTokens: mergeValue(current?.cachedInputTokens, patch?.cachedInputTokens),
  };

  return hasRuntimeUsageSummary(merged) ? merged : undefined;
}

function parseRuntimeUsageSummary(value: unknown): RuntimeUsageSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const inputDetails = readObjectField(record, ["input_token_details", "inputTokenDetails"]);
  const outputDetails = readObjectField(record, ["output_token_details", "outputTokenDetails"]);

  const usage: RuntimeUsageSummary = {
    inputTokens: readNumberField(record, ["input_tokens", "inputTokens"]),
    outputTokens: readNumberField(record, ["output_tokens", "outputTokens"]),
    totalTokens: readNumberField(record, ["total_tokens", "totalTokens"]),
    reasoningTokens:
      readNumberField(record, ["reasoning_tokens", "reasoningTokens"]) ??
      readNumberField(outputDetails, ["reasoning", "reasoning_tokens", "reasoningTokens"]),
    cachedInputTokens:
      readNumberField(record, ["cached_input_tokens", "cachedInputTokens"]) ??
      readNumberField(inputDetails, ["cache_read", "cacheRead", "cached_tokens", "cachedTokens"]),
  };

  return hasRuntimeUsageSummary(usage) ? usage : null;
}

function estimateReceivedTokenCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }

  const cjkAndWideChars = trimmed.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const remaining = trimmed.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, "").trim();
  const compactRemaining = remaining.replace(/\s+/g, " ");
  const remainingTokens = compactRemaining ? Math.ceil(compactRemaining.length / 4) : 0;

  return Math.max(1, cjkAndWideChars + remainingTokens);
}

function collectRuntimeUsageSummaries(value: unknown, seen = new Set<object>()): RuntimeUsageSummary[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (seen.has(value as object)) {
    return [];
  }
  seen.add(value as object);

  const parsed = parseRuntimeUsageSummary(value);
  const nestedValues = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);

  return [
    ...(parsed ? [parsed] : []),
    ...nestedValues.flatMap((nested) => collectRuntimeUsageSummaries(nested, seen)),
  ];
}

function parseRuntimeModelName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const responseMetadata = readObjectField(record, ["response_metadata", "responseMetadata"]);

  return (
    readStringField(responseMetadata, ["model_name", "modelName"]) ??
    readStringField(record, ["model_name", "modelName", "model"])
  );
}

function collectRuntimeModelNames(value: unknown, seen = new Set<object>()): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if (seen.has(value as object)) {
    return [];
  }
  seen.add(value as object);

  const modelName = parseRuntimeModelName(value);
  const nestedValues = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);

  return [
    ...(modelName ? [modelName] : []),
    ...nestedValues.flatMap((nested) => collectRuntimeModelNames(nested, seen)),
  ];
}

function resolveRuntimeModelFallback(fallbackModelName?: string): string {
  return fallbackModelName?.trim() || process.env.APP_BUILDER_MODEL?.trim() || DEFAULT_MODEL_NAME;
}

export function modelRoleForRuntimePhase(phase?: RuntimeStatusPhase): ModelRole | undefined {
  switch (phase) {
    case "plan":
      return "plan";
    case "generate":
      return "generate";
    case "planRepair":
    case "plan_repair":
    case "generateRepair":
    case "generate_repair":
      return "repair";
    default:
      return undefined;
  }
}

function runtimePhaseToWorkflowStage(phase: RuntimeStatusPhase): "计划阶段" | "生成阶段" {
  return phase === "plan" || phase === "planRepair" || phase === "plan_repair" ? "计划阶段" : "生成阶段";
}

export function resolveRuntimeStatusPhase(
  runtime: Pick<TextGeneratorRuntime, "planAttempt" | "generateAttempt">,
): RuntimeStatusPhase {
  if (runtime.generateAttempt !== undefined) {
    return runtime.generateAttempt > 1 ? "generateRepair" : "generate";
  }

  return (runtime.planAttempt ?? 1) > 1 ? "planRepair" : "plan";
}

export function resolveRuntimeStatusEffort(
  templatePhases: TemplatePhaseMap,
  phase?: RuntimeStatusPhase,
): TemplatePhaseEffort | undefined {
  switch (phase) {
    case "plan":
      return templatePhases.plan?.effort;
    case "planRepair":
    case "plan_repair":
      return templatePhases.planRepair?.effort;
    case "generate":
      return templatePhases.generate?.effort;
    case "generateRepair":
    case "generate_repair":
      return templatePhases.generateRepair?.effort;
    default:
      return undefined;
  }
}

export function buildRuntimeStatus(options: {
  runtime: Pick<TextGeneratorRuntime, "sessionId" | "templatePhases"> & Partial<Pick<TextGeneratorRuntime, "modelRoles">>;
  phase: RuntimeStatusPhase;
  modelName?: string | undefined;
  usage?: RuntimeUsageSummary | undefined;
  fallbackModelName?: string | undefined;
}): RuntimeStatus {
  const usage = hasRuntimeUsageSummary(options.usage) ? options.usage : undefined;
  const modelRole = modelRoleForRuntimePhase(options.phase);
  const roleModelName = modelRole ? options.runtime.modelRoles?.[modelRole]?.modelName : undefined;

  return {
    modelName: options.modelName ?? roleModelName ?? resolveRuntimeModelFallback(options.fallbackModelName),
    effort: resolveRuntimeStatusEffort(options.runtime.templatePhases, options.phase),
    sessionId: options.runtime.sessionId,
    phase: options.phase,
    ...(usage ? { usage } : {}),
  };
}

export function mergeRuntimeStatus(current: RuntimeStatus, patch: Partial<RuntimeStatus>): RuntimeStatus {
  const usage = mergeRuntimeUsageSummary(current.usage, patch.usage);

  return {
    ...current,
    ...(patch.modelName ? { modelName: patch.modelName } : {}),
    ...(patch.effort ? { effort: patch.effort } : {}),
    ...(isFiniteNumber(patch.contextWindowUsedTokens) ? { contextWindowUsedTokens: patch.contextWindowUsedTokens } : {}),
    ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
    ...(patch.phase ? { phase: patch.phase } : {}),
    ...(usage ? { usage } : current.usage ? { usage: current.usage } : {}),
  };
}

export function extractRuntimeStatusPatch(payload: unknown): Partial<RuntimeStatus> {
  const usageSummaries = collectRuntimeUsageSummaries(payload);
  const usage = usageSummaries.reduce<RuntimeUsageSummary | undefined>(
    (current, item) => mergeRuntimeUsageSummary(current, item),
    undefined,
  );
  const latestUsage = usageSummaries.at(-1);
  const modelNames = collectRuntimeModelNames(payload);
  const modelName = modelNames.at(-1);

  return {
    ...(modelName ? { modelName } : {}),
    ...(isFiniteNumber(latestUsage?.inputTokens) ? { contextWindowUsedTokens: latestUsage.inputTokens } : {}),
    ...(usage ? { usage } : {}),
  };
}

function extractMessageKind(record: Record<string, unknown>): string | null {
  const directKind = readStringField(record, ["role", "type"]);
  if (directKind) {
    return directKind.toLowerCase();
  }

  if (Array.isArray(record.id)) {
    const serializedKind = [...record.id]
      .reverse()
      .map((item) => (typeof item === "string" ? item : ""))
      .find((item) => /message/i.test(item));
    if (serializedKind) {
      return serializedKind.toLowerCase();
    }
  }

  const kwargs = readObjectField(record, ["kwargs"]);
  const kwargsKind = readStringField(kwargs, ["role", "type"]);
  return kwargsKind ? kwargsKind.toLowerCase() : null;
}

function isInputOrToolMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const kind = extractMessageKind(value as Record<string, unknown>);
  return Boolean(
    kind &&
      (kind === "user" ||
        kind === "human" ||
        kind === "system" ||
        kind === "developer" ||
        kind === "tool" ||
        kind === "function" ||
        kind.includes("humanmessage") ||
        kind.includes("systemmessage") ||
        kind.includes("toolmessage") ||
        kind.includes("functionmessage")),
  );
}

function extractMessageText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => (isInputOrToolMessage(item) ? null : extractMessageText(item)))
      .filter((item): item is string => Boolean(item))
      .join("");
    return text || null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (isInputOrToolMessage(record)) {
    return null;
  }

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
  todoTimings: Map<string, TodoTimingEntry>;
  lastNarrative: string;
  logFilePath?: string;
  runtimeStatus: RuntimeStatus;
  modelOutputStarted: boolean;
  receivedOutputTokens: number;
  receivedOutputTokensEstimated: boolean;
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

function extractTodosFromToolEventPayload(value: unknown): TodoItem[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const parsedInput = parseToolInput(record.input);
  return extractTodosFromPayload(parsedInput) ?? extractTodosFromToolOutput(record.output);
}

function extractTodosForBoard(value: unknown): TodoItem[] | null {
  return extractTodosFromPayload(value) ?? extractTodosFromToolEventPayload(value);
}

function workflowMetricPhaseForRuntimeStatus(
  phase: RuntimeStatusPhase | undefined,
  stage: DeepAgentsTraceState["stage"],
): WorkflowMetricPhase {
  switch (phase) {
    case "plan":
      return "plan";
    case "planRepair":
    case "plan_repair":
      return "plan_repair";
    case "generate":
      return "generate";
    case "generateRepair":
    case "generate_repair":
      return "generate_repair";
    case "validation":
      return "validation";
    case "complete":
      return "complete";
    default:
      return stage === "计划阶段" ? "plan" : "generate";
  }
}

function metricAttemptForPhase(runtime: TextGeneratorRuntime, phase: WorkflowMetricPhase): number | undefined {
  switch (phase) {
    case "plan":
    case "plan_repair":
      return runtime.planAttempt;
    case "generate":
    case "generate_repair":
      return runtime.generateAttempt;
    default:
      return undefined;
  }
}

function createTodoTimingPoint(): { at: Date; hr: bigint } {
  return {
    at: new Date(),
    hr: process.hrtime.bigint(),
  };
}

async function appendModelTodoMetric(
  trace: DeepAgentsTraceState,
  runtime: TextGeneratorRuntime,
  options: {
    name: string;
    content: string;
    startedAt: Date;
    startedHr: bigint;
    completedAt: Date;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const phase = workflowMetricPhaseForRuntimeStatus(trace.runtimeStatus.phase, trace.stage);
  const attempt = metricAttemptForPhase(runtime, phase);
  await appendWorkflowMetricRecord(
    runtime.deepagentsMetricsLogPath,
    buildWorkflowMetricRecord({
      sessionId: runtime.sessionId,
      metric: {
        name: options.name,
        phase,
        ...(attempt !== undefined ? { attempt } : {}),
        metadata: {
          content: options.content,
          ...options.metadata,
        },
      },
      status: "success",
      startedAt: options.startedAt,
      completedAt: options.completedAt,
      startedHr: options.startedHr,
    }),
  );
}

async function recordModelTodoTimingMetrics(
  trace: DeepAgentsTraceState,
  todos: TodoItem[],
  runtime: TextGeneratorRuntime,
  source: string,
): Promise<void> {
  for (const todo of todos) {
    const content = todo.content.trim();
    if (!content) {
      continue;
    }

    let entry = trace.todoTimings.get(content);
    const previousStatus = entry?.status;
    if (!entry) {
      const firstSeen = createTodoTimingPoint();
      entry = {
        status: todo.status,
        firstSeenAt: firstSeen.at,
        firstSeenHr: firstSeen.hr,
        completedReported: false,
        openReported: false,
      };
      trace.todoTimings.set(content, entry);
    }

    if (
      todo.status === "in_progress" &&
      previousStatus !== "in_progress" &&
      previousStatus !== "completed"
    ) {
      const started = createTodoTimingPoint();
      entry.startedAt = started.at;
      entry.startedHr = started.hr;
      entry.openReported = false;
      await appendModelTodoMetric(trace, runtime, {
        name: "model_todo.start",
        content,
        startedAt: started.at,
        completedAt: started.at,
        startedHr: started.hr,
        metadata: {
          source,
          todoStatus: todo.status,
          previousStatus: previousStatus ?? "unseen",
        },
      });
    }

    if (todo.status === "completed" && !entry.completedReported) {
      const completed = createTodoTimingPoint();
      const startedAt = entry.startedAt ?? entry.firstSeenAt;
      const startedHr = entry.startedHr ?? entry.firstSeenHr;
      await appendModelTodoMetric(trace, runtime, {
        name: "model_todo.completed",
        content,
        startedAt,
        completedAt: completed.at,
        startedHr,
        metadata: {
          source,
          todoStatus: todo.status,
          previousStatus: previousStatus ?? "unseen",
          durationBasis: entry.startedAt !== undefined && entry.startedHr !== undefined ? "started" : "first_seen",
        },
      });
      entry.completedReported = true;
      entry.openReported = true;
    }

    if (todo.status === "pending" && previousStatus === "in_progress") {
      delete entry.startedAt;
      delete entry.startedHr;
      entry.openReported = false;
    }

    entry.status = todo.status;
  }
}

async function recordOpenModelTodoMetrics(
  trace: DeepAgentsTraceState,
  runtime: TextGeneratorRuntime,
  source: string,
): Promise<void> {
  for (const [content, entry] of trace.todoTimings) {
    if (entry.status !== "in_progress" || entry.completedReported || entry.openReported) {
      continue;
    }

    const completed = createTodoTimingPoint();
    await appendModelTodoMetric(trace, runtime, {
      name: "model_todo.incomplete",
      content,
      startedAt: entry.startedAt ?? entry.firstSeenAt,
      completedAt: completed.at,
      startedHr: entry.startedHr ?? entry.firstSeenHr,
      metadata: {
        source,
        todoStatus: entry.status,
        durationBasis: "open_at_stream_end",
      },
    });
    entry.openReported = true;
  }
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

function formatModelThinkingSummary(_progress?: StreamProgressSummary): string {
  return "模型正在工作中";
}

function getStreamProgressSummary(trace: DeepAgentsTraceState): StreamProgressSummary {
  return {
    receivedOutputTokens: trace.receivedOutputTokens,
    receivedOutputTokensEstimated: trace.receivedOutputTokensEstimated,
  };
}

function getTodoBoardStreamProgress(trace: DeepAgentsTraceState): TodoBoardState["streamProgress"] {
  const progress: NonNullable<TodoBoardState["streamProgress"]> = {};
  const inputTokens = trace.runtimeStatus.usage?.inputTokens ?? trace.runtimeStatus.contextWindowUsedTokens;

  if (isFiniteNumber(inputTokens)) {
    progress.inputTokens = inputTokens;
  }
  if (isFiniteNumber(trace.receivedOutputTokens)) {
    progress.outputTokens = trace.receivedOutputTokens;
  }
  progress.outputTokensEstimated = trace.receivedOutputTokensEstimated;

  return progress;
}

export function summarizeDeepAgentsAction(
  mode: string,
  payload: unknown,
  progress?: StreamProgressSummary,
): string {
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
    return messageText && messageText.length > 0 ? messageText : formatModelThinkingSummary(progress);
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
    summary === "模型正在工作中" ||
    summary === "模型正在思考。" ||
    summary === "收到一条进度更新。" ||
    summary === "收到工具调用事件。" ||
    summary === "正在生成结构化结果。"
  ) {
    return false;
  }

  if (/^模型正在思考（已接收.* tokens）。$/.test(summary)) {
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

function applyStreamProgress(trace: DeepAgentsTraceState, mode: string, payload: unknown): void {
  trace.runtimeStatus = mergeRuntimeStatus(trace.runtimeStatus, extractRuntimeStatusPatch(payload));

  const messageText = mode === "messages" ? extractMessageText(payload)?.trim() : undefined;
  if (messageText) {
    const estimatedTokens = estimateReceivedTokenCount(messageText);
    if (estimatedTokens > 0) {
      trace.modelOutputStarted = true;
      trace.receivedOutputTokens += estimatedTokens;
      trace.receivedOutputTokensEstimated = true;
    }
  }

  const exactOutputTokens = trace.runtimeStatus.usage?.outputTokens;
  if (isFiniteNumber(exactOutputTokens) && exactOutputTokens > trace.receivedOutputTokens) {
    trace.modelOutputStarted = true;
    trace.receivedOutputTokens = exactOutputTokens;
    trace.receivedOutputTokensEstimated = false;
  }
}

function shouldShowThinkingProgress(mode: string | undefined, fallbackSummary: string, trace: DeepAgentsTraceState): boolean {
  return (
    mode === "messages" &&
    trace.modelOutputStarted &&
    trace.receivedOutputTokens > 0 &&
    !/^准备/.test(fallbackSummary)
  );
}

async function updateTodoBoard(
  trace: DeepAgentsTraceState,
  payload: unknown,
  fallbackSummary: string,
  runtime?: TextGeneratorRuntime,
  mode?: string,
  progressAlreadyApplied = false,
): Promise<void> {
  if (!progressAlreadyApplied) {
    applyStreamProgress(trace, mode ?? "unclassified", payload);
  }

  const extractedTodos = extractTodosForBoard(payload);
  if (extractedTodos && extractedTodos.length > 0) {
    if (runtime) {
      await recordModelTodoTimingMetrics(trace, extractedTodos, runtime, mode ?? "unclassified");
    }
    trace.todos = extractedTodos;
  }

  if (typeof payload === "string" && payload.trim()) {
    trace.lastNarrative = shouldShowThinkingProgress(mode, fallbackSummary, trace)
      ? formatModelThinkingSummary(getStreamProgressSummary(trace))
      : payload.trim();
  } else {
    const extractedMessage = extractMessageText(payload);
    const narrative = extractedMessage?.trim() || fallbackSummary;
    trace.lastNarrative = shouldShowThinkingProgress(mode, fallbackSummary, trace)
      ? formatModelThinkingSummary(getStreamProgressSummary(trace))
      : narrative;
  }

  ensureTraceState(trace, fallbackSummary);
  await updateWorkflowBoard({
    stage: trace.stage,
    todos: trace.todos,
    artifacts: createArtifactItemsForStage(trace.stage, "generating"),
    narrative: trace.lastNarrative,
    ...(runtime ? { sessionId: runtime.sessionId } : {}),
    ...(runtime ? { outputDirectory: runtime.outputDirectory } : {}),
    runtimeStatus: trace.runtimeStatus,
    streamProgress: getTodoBoardStreamProgress(trace),
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
  applyStreamProgress(trace, mode, payload);
  const summary = summarizeDeepAgentsAction(mode, payload, getStreamProgressSummary(trace));
  if (shouldAppendDetailedLog(mode, summary)) {
    await appendWorkflowLog(`[${mode}] ${summary}`);
  }
  await updateTodoBoard(trace, payload, summary, runtime, mode, true);
  writeSystemTraceEvent(trace.logFilePath, mode, payload, summary);
}

function collectErrorMessages(error: unknown, limit = 8): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current) && messages.length < limit) {
    seen.add(current);

    if (current instanceof Error) {
      if (current.message) {
        messages.push(current.message);
      }

      const errorRecord = current as { code?: unknown };
      if (typeof errorRecord.code === "string" && errorRecord.code.trim()) {
        messages.push(errorRecord.code);
      }

      current = current.cause;
      continue;
    }

    if (typeof current === "object") {
      const record = current as {
        message?: unknown;
        code?: unknown;
        error?: unknown;
        cause?: unknown;
      };

      if (typeof record.message === "string" && record.message.trim()) {
        messages.push(record.message);
      }

      if (typeof record.code === "string" && record.code.trim()) {
        messages.push(record.code);
      }

      current = record.cause ?? record.error;
      continue;
    }

    break;
  }

  return messages;
}

export function extractCompatibleStreamErrorReason(error: unknown): string | null {
  const pattern = /\boutput\s+[a-z0-9_]+\s+\(\d+\)/i;
  const transientPatterns: Array<{ pattern: RegExp; reason: string }> = [
    {
      pattern: /socket connection was closed unexpectedly/i,
      reason: "socket connection closed unexpectedly",
    },
    {
      pattern: /^connection error\.?$/i,
      reason: "connection error",
    },
    {
      pattern: /\bECONNRESET\b/i,
      reason: "ECONNRESET",
    },
    {
      pattern: /\b(?:ETIMEDOUT|ECONNABORTED|EPIPE|UND_ERR_SOCKET)\b/i,
      reason: "transient transport error",
    },
  ];

  for (const message of collectErrorMessages(error)) {
    const match = message.match(pattern);
    if (match) {
      return match[0];
    }

    const transientMatch = transientPatterns.find((candidate) => candidate.pattern.test(message));
    if (transientMatch) {
      return transientMatch.reason;
    }
  }

  return null;
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

export async function runDeepAgentWithLogs(
  agent: DeepAgentRunner,
  state: unknown,
  runtime: TextGeneratorRuntime,
  runtimePhase: RuntimeStatusPhase,
  timeoutLabel: string,
  fallbackModelName?: string,
): Promise<unknown> {
  const workflowStage = runtimePhaseToWorkflowStage(runtimePhase);
  const trace: DeepAgentsTraceState = {
    stage: workflowStage,
    todos: defaultTodosForStage(workflowStage),
    todoTimings: new Map(),
    lastNarrative: "等待模型开始处理。",
    logFilePath: runtime.deepagentsLogPath,
    runtimeStatus: buildRuntimeStatus({
      runtime,
      phase: runtimePhase,
      fallbackModelName,
    }),
    modelOutputStarted: false,
    receivedOutputTokens: 0,
    receivedOutputTokensEstimated: false,
  };
  await appendWorkflowLog(`[lifecycle] 进入${trace.stage}，开始流式生成。`);
  await updateWorkflowBoard({
    stage: trace.stage,
    todos: trace.todos,
    artifacts: createArtifactItemsForStage(trace.stage, "generating"),
    narrative: trace.lastNarrative,
    sessionId: runtime.sessionId,
    outputDirectory: runtime.outputDirectory,
    runtimeStatus: trace.runtimeStatus,
  });

  for (let retryCount = 0; ; retryCount += 1) {
    try {
      trace.modelOutputStarted = false;
      trace.receivedOutputTokens = 0;
      trace.receivedOutputTokensEstimated = false;

      const lastValuesChunk = await withActivityTimeout(
        async (signalActivity) => {
          const stream = await agent.stream(state, {
            streamMode: resolveDeepagentsStreamModes(),
          });

          let lastChunk: unknown = null;

          for await (const chunk of stream) {
            signalActivity();

            if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
              const [mode, payload] = chunk as [string, unknown];
              await logDeepAgentsChunk(mode, payload, trace, runtime);
              if (mode === "values") {
                lastChunk = payload;
              }
              continue;
            }

            const summary = "收到一条未分类事件。";
            await updateTodoBoard(trace, chunk, summary, runtime, "unclassified");
            writeSystemTraceEvent(trace.logFilePath, "unclassified", chunk, summary);
            lastChunk = chunk;
          }

          return lastChunk;
        },
        DEEPAGENTS_IDLE_TIMEOUT_MS,
        timeoutLabel,
      );

      trace.lastNarrative = "生成流程结束。";
      await recordOpenModelTodoMetrics(trace, runtime, "stream_end");
      await appendWorkflowLog("[lifecycle] 本轮流式生成结束，等待宿主后续处理。");
      writeSystemTraceEvent(trace.logFilePath, "lifecycle", { result: lastValuesChunk }, "生成流程结束。");
      await updateWorkflowBoard({
        stage: trace.stage,
        todos: trace.todos,
        artifacts: createArtifactItemsForStage(trace.stage, "generating"),
        narrative: trace.lastNarrative,
        sessionId: runtime.sessionId,
        outputDirectory: runtime.outputDirectory,
        runtimeStatus: trace.runtimeStatus,
      });

      return lastValuesChunk;
    } catch (error) {
      const retryReason = extractCompatibleStreamErrorReason(error);
      if (!retryReason || retryCount >= DEEPAGENTS_STREAM_COMPAT_RETRY_LIMIT) {
        await recordOpenModelTodoMetrics(trace, runtime, "stream_error");
        throw error;
      }

      const currentRetry = retryCount + 1;
      trace.lastNarrative = `检测到可重试的流式响应错误，准备重试第 ${currentRetry} 次。`;
      await appendWorkflowLog(
        `[host] 检测到可重试流式响应错误（${retryReason}），准备重试第 ${currentRetry}/${DEEPAGENTS_STREAM_COMPAT_RETRY_LIMIT} 次。`,
      );
      writeSystemTraceEvent(
        trace.logFilePath,
        "stream-retry",
        { reason: retryReason, retry: currentRetry, retryLimit: DEEPAGENTS_STREAM_COMPAT_RETRY_LIMIT },
        "流式响应失败，准备重试。",
      );
      await updateWorkflowBoard({
        stage: trace.stage,
        todos: trace.todos,
        artifacts: createArtifactItemsForStage(trace.stage, "generating"),
        narrative: trace.lastNarrative,
        sessionId: runtime.sessionId,
        outputDirectory: runtime.outputDirectory,
        runtimeStatus: trace.runtimeStatus,
      });
    }
  }
}

async function runDeepAgentForStructuredResponse(
  agent: DeepAgentRunner,
  state: unknown,
  timeoutLabel: string,
): Promise<unknown> {
  for (let retryCount = 0; ; retryCount += 1) {
    try {
      return await withActivityTimeout(
        async (signalActivity) => {
          const stream = await agent.stream(state, {
            streamMode: resolveDeepagentsStreamModes(),
          });
          let lastChunk: unknown = null;

          for await (const chunk of stream) {
            signalActivity();
            if (Array.isArray(chunk) && chunk.length === 2 && typeof chunk[0] === "string") {
              const [mode, payload] = chunk as [string, unknown];
              if (mode === "values") {
                lastChunk = payload;
              }
              continue;
            }

            lastChunk = chunk;
          }

          return lastChunk;
        },
        DEEPAGENTS_IDLE_TIMEOUT_MS,
        timeoutLabel,
      );
    } catch (error) {
      const retryReason = extractCompatibleStreamErrorReason(error);
      if (!retryReason || retryCount >= DEEPAGENTS_STREAM_COMPAT_RETRY_LIMIT) {
        throw error;
      }

      const currentRetry = retryCount + 1;
      await appendWorkflowLog(
        `[host] 参考资料 Markdown 转换遇到可重试流式响应错误（${retryReason}），准备重试第 ${currentRetry}/${DEEPAGENTS_STREAM_COMPAT_RETRY_LIMIT} 次。`,
      );
    }
  }
}

function extractStructuredResponse<T>(result: unknown, schema: z.ZodType<T>): T | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const structured = (result as Record<string, unknown>).structuredResponse;
  const parsed = schema.safeParse(structured);
  return parsed.success ? parsed.data : null;
}

async function resolveModel(config: ModelRoleConfig, effort?: TemplatePhaseEffort) {
  return createOpenAICompatibleModel({
    modelName: config.modelName,
    ...(effort ? { effort } : {}),
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });
}

type DeepAgentsTextGeneratorOptions =
  | string
  | ModelRoleConfigMap
  | {
      modelRoles: ModelRoleConfigMap;
    };

function isModelRoleConfigMap(value: unknown): value is ModelRoleConfigMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Partial<Record<ModelRole, Partial<ModelRoleConfig>>>;
  return Boolean(
    record.plan?.modelName &&
      record.generate?.modelName &&
      record.repair?.modelName,
  );
}

function resolveConstructorModelRoles(options?: DeepAgentsTextGeneratorOptions): ModelRoleConfigMap {
  if (typeof options === "string") {
    return resolveModelRoleConfigs({
      ...process.env,
      APP_BUILDER_MODEL: options,
    });
  }

  if (isModelRoleConfigMap(options)) {
    return options;
  }

  if (options?.modelRoles) {
    return options.modelRoles;
  }

  return resolveModelRoleConfigs();
}

export class DeepAgentsTextGenerator implements TextGenerator {
  private readonly modelRoles: ModelRoleConfigMap;

  constructor(options?: DeepAgentsTextGeneratorOptions) {
    this.modelRoles = resolveConstructorModelRoles(options);
  }

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
    const phaseName =
      options.stage === "plan"
        ? "plan"
        : options.stage === "plan_repair"
          ? "planRepair"
          : options.stage === "generate"
            ? "generate"
            : "generateRepair";
    const modelRole = modelRoleForRuntimePhase(phaseName);
    const modelConfig = modelRole ? (runtime.modelRoles?.[modelRole] ?? this.modelRoles[modelRole]) : this.modelRoles.plan;
    const resolvedModel = await resolveModel(modelConfig, runtime.templatePhases[phaseName]?.effort);
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

    const result = await runDeepAgentWithLogs(
      agent as any,
      state,
      runtime,
      phaseName,
      options.timeoutLabel,
      modelConfig.modelName,
    );

    const structured = extractStructuredResponse(result, options.responseSchema);
    if (!structured) {
      throw new Error(`${options.timeoutLabel} did not return a valid structured response.`);
    }

    return structured;
  }

  async convertReferenceToMarkdown(
    input: ReferenceMarkdownConversionInput,
    runtime: TextGeneratorRuntime,
  ): Promise<ReferenceMarkdownConversionResult> {
    try {
      const deepagents = await loadDeepagentsModule();
      const createDeepAgent = deepagents.createDeepAgent;
      const modelConfig = runtime.modelRoles?.plan ?? this.modelRoles.plan;
      const resolvedModel = await resolveModel(modelConfig, runtime.templatePhases.plan?.effort);
      const agentOptions: any = {
        model: resolvedModel,
        responseFormat: toolStrategy(referenceMarkdownConversionSchema),
        systemPrompt: REFERENCE_MARKDOWN_CONVERSION_SYSTEM_PROMPT,
        backend: new deepagents.FilesystemBackend({
          rootDir: runtime.outputDirectory,
          virtualMode: true,
        }),
      };
      const agent = createDeepAgent(agentOptions);
      const state = {
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              stage: "reference_markdown_conversion",
              source: {
                url: input.url,
                name: input.name,
                type: input.type,
                contentType: input.contentType,
              },
              rawDocument: input.body,
            }),
          },
        ],
      };

      await appendWorkflowLog(`[host] 开始将参考资料转换为 Markdown：${input.url}`);
      const result = await runDeepAgentForStructuredResponse(
        agent as any,
        state,
        "deepagents reference markdown conversion",
      );
      const structured = extractStructuredResponse(result, referenceMarkdownConversionSchema);
      if (!structured) {
        throw new Error("deepagents reference markdown conversion did not return a valid structured response.");
      }
      await appendWorkflowLog(`[host] 参考资料 Markdown 转换完成：${input.url}`);
      return structured;
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
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
            interactiveRuntimeValidation: runtime.templateInteractiveRuntimeValidation,
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
            interactionContract: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsInteractionContractPath),
            referenceManifest: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsReferenceManifestPath),
            generationValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath),
            runtimeValidationLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsRuntimeValidationLogPath),
            runtimeInteractionValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsRuntimeInteractionValidationPath),
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
            interactiveRuntimeValidation: runtime.templateInteractiveRuntimeValidation,
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
            interactionContract: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsInteractionContractPath),
            referenceManifest: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsReferenceManifestPath),
            generationValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsGenerationValidationPath),
            runtimeValidationLog: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsRuntimeValidationLogPath),
            runtimeInteractionValidation: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsRuntimeInteractionValidationPath),
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
