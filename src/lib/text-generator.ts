import { appendFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

import { ChatAnthropic } from "@langchain/anthropic";
import { createMiddleware, ToolMessage, toolStrategy } from "langchain";
import { z } from "zod";

import { type PlanSpec, planSpecSchema } from "./plan-spec.js";
import { interactionContractSchema } from "./interaction-contract.js";
import { createOpenAICompatibleModel } from "./deepseek-openai.js";
import {
  DEFAULT_MODEL_NAME,
  resolveModelRoleConfigs,
  type ModelProtocol,
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
  type AgentWorkStatus,
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

const planDeliveryResultSchema = planResultSchema.extend({
  planSpec: planSpecSchema,
  interactionContract: interactionContractSchema,
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

export const HOST_MANAGED_WRITE_PROTECTED_ARTIFACT_PATHS = [
  "/.deepagents/AGENTS.md",
  "/.deepagents/source-prd.md",
  "/.deepagents/plan-spec.json",
  "/.deepagents/interaction-contract.json",
  "/.deepagents/plan-validation.json",
  "/.deepagents/generation-validation.json",
  "/.deepagents/runtime-validation.log",
  "/.deepagents/runtime-interaction-validation.json",
  "/.deepagents/error.log",
  "/.deepagents/config.json",
  "/.deepagents/plan-system-prompt.md",
  "/.deepagents/plan-repair-system-prompt.md",
  "/.deepagents/generate-system-prompt.md",
  "/.deepagents/generate-repair-system-prompt.md",
  "/.deepagents/references/reference-manifest.json",
] as const;

type DeepagentsFilesystemPermission = {
  operations: readonly ("read" | "write")[];
  paths: string[];
  mode: "deny";
};

export function buildHostManagedArtifactPermissions(): DeepagentsFilesystemPermission[] {
  return [{
    operations: ["write"],
    paths: [...HOST_MANAGED_WRITE_PROTECTED_ARTIFACT_PATHS],
    mode: "deny",
  }];
}

const HOST_MANAGED_WRITE_PROTECTED_ARTIFACT_PATH_SET = new Set<string>(
  HOST_MANAGED_WRITE_PROTECTED_ARTIFACT_PATHS,
);

function normalizeDeepagentsVirtualPath(filePath: string): string {
  const slashPath = filePath.trim().replace(/\\/g, "/");
  if (!slashPath.startsWith("/")) {
    return slashPath;
  }
  const normalized = path.posix.normalize(slashPath);
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

export function isHostManagedWriteProtectedArtifactPath(filePath: string): boolean {
  return HOST_MANAGED_WRITE_PROTECTED_ARTIFACT_PATH_SET.has(normalizeDeepagentsVirtualPath(filePath));
}

function extractToolCallFilePath(toolCall: unknown): string | null {
  if (!toolCall || typeof toolCall !== "object") {
    return null;
  }

  const record = toolCall as Record<string, unknown>;
  const args = parseToolInput(record.args) ?? parseToolInput(record.input);
  const filePath = args?.file_path ?? args?.path;
  return typeof filePath === "string" && filePath.trim()
    ? normalizeDeepagentsVirtualPath(filePath)
    : null;
}

function extractHostManagedPermissionDeniedPath(error: unknown): string | null {
  for (const message of collectErrorMessages(error)) {
    const match = message.match(/permission denied for write on (\S+)/i);
    if (!match?.[1]) {
      continue;
    }
    const deniedPath = normalizeDeepagentsVirtualPath(match[1]);
    if (isHostManagedWriteProtectedArtifactPath(deniedPath)) {
      return deniedPath;
    }
  }
  return null;
}

function buildBlockedHostManagedArtifactToolMessage(
  toolName: string,
  toolCallId: string | undefined,
  targetPath: string,
): ToolMessage {
  return new ToolMessage({
    name: toolName,
    tool_call_id: toolCallId ?? "host-managed-artifact-write-guard",
    status: "error",
    content: [
      `Error: host-managed artifact write blocked for ${targetPath}.`,
      "Do not write or edit this file with filesystem tools.",
      "Return the corresponding structured response fields instead; app-builder will materialize the artifact.",
    ].join(" "),
  });
}

export function createHostManagedArtifactWriteGuardMiddleware(): unknown {
  return createMiddleware({
    name: "hostManagedArtifactWriteGuardMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolCall = request.toolCall as { id?: string; name?: string };
      const toolName = typeof toolCall.name === "string" ? toolCall.name : "filesystem";
      const targetPath = extractToolCallFilePath(toolCall);

      if (
        (toolName === "write_file" || toolName === "edit_file") &&
        targetPath &&
        isHostManagedWriteProtectedArtifactPath(targetPath)
      ) {
        return buildBlockedHostManagedArtifactToolMessage(toolName, toolCall.id, targetPath);
      }

      try {
        return await handler(request);
      } catch (error) {
        const deniedPath = extractHostManagedPermissionDeniedPath(error);
        if (deniedPath) {
          return buildBlockedHostManagedArtifactToolMessage(toolName, toolCall.id, deniedPath);
        }
        throw error;
      }
    },
  });
}

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

const PRD_ANALYSIS_SYSTEM_PROMPT = [
  "# PRD Analysis Stage",
  "",
  "你是计划流水线中的 `protocol-analysis` 阶段代理。",
  "",
  "## Boundary",
  "",
  "- 只分析输入 PRD，并只写入 `artifacts.analysis` 指向的 `/.deepagents/prd-analysis.md`。",
  "- 不要写入、读取或修补 `artifacts.generatedSpec`、`artifacts.planSpec`、`artifacts.interactionContract`。",
  "- 不要等待外部参考资料转换完成；宿主会与本阶段并行下载/转换 references。",
  "- 你可以把 `externalReferences` 中的 URL 和上下文作为依赖线索写入分析稿，但不要凭 URL 猜测 API 细节。",
  "- 不要修改应用源码目录。",
  "",
  "## Analysis Contents",
  "",
  "- 产品目标、业务背景、用户角色和系统边界。",
  "- 主要资源对象、页面/流程、状态和权限约束。",
  "- 明确需求、缺口、默认假设、风险和待确认项。",
  "- 外部 API/文档依赖只记录为待在 `prd-assembly` 阶段结合本地 Markdown 参考资料确认的事项。",
  "",
  "## Completion",
  "",
  "- 写入有效中文 Markdown 分析稿到 `artifacts.analysis`。",
  "- 返回结构化结果：`summary`、`artifactsWritten`、`planSpecVersion: 1`、`notes`。",
  "- `artifactsWritten` 应只列出 `.deepagents/prd-analysis.md`，除非你实际写入了其他允许的计划分析产物。",
].join("\n");

const PRD_ASSEMBLY_SYSTEM_PROMPT = [
  "# PRD Assembly Stage",
  "",
  "你是计划流水线中的 `prd-assembly` 阶段代理。",
  "",
  "## Inputs",
  "",
  "- `prdAnalysisMarkdown`：上一阶段已经产出的 PRD 分析稿内容。",
  "- `artifacts.analysis`：同一份分析稿的本地路径，必要时可读取确认。",
  "- `externalReferences` / `localReferences` / `artifacts.referenceManifest`：宿主并行下载并转换后的参考资料结果。",
  "",
  "## Boundary",
  "",
  "- 必须基于 PRD 分析稿和已转换本地参考资料共同组装最终计划产物。",
  "- 不要重做完整 PRD 分析；除非发现明显缺口，否则不要覆盖 `artifacts.analysis`。",
  "- 如果存在 `retrievalStatus=downloaded` 的外部 API、第三方服务或文档 reference，必须先读取其 `localPath` 文件，再组装 `artifacts.generatedSpec`、结构化响应 `planSpec`、结构化响应 `interactionContract`。",
  "- 不要凭模型记忆或远程 URL 猜测 API endpoint、认证、参数、响应字段、错误码或限制信息。",
  "- 不要修改应用源码目录。",
  "",
  "## Required Artifacts",
  "",
  "1. `artifacts.generatedSpec`：面向人类审阅的详细中文实施 spec，包含 References 章节。",
  "2. 结构化响应字段 `planSpec`：合法对象，必须满足输入的 `planSpecSchema`；host 会将它写入 `artifacts.planSpec`。",
  "3. 结构化响应字段 `interactionContract`：关键交互、内部操作和外部操作契约；host 会将它写入 `artifacts.interactionContract`。",
  "",
  "## Completion",
  "",
  "- 自检结构化响应中的 `planSpec` 和 `interactionContract` 满足 schema，且 reference localPath 已同步到 generatedSpec 与 planSpec.references。",
  "- 返回结构化结果：`summary`、`artifactsWritten`、`planSpecVersion: 1`、`planSpec`、`interactionContract`、`notes`。",
  "- `artifactsWritten` 按实际落盘顺序列出本阶段写入的计划产物，并包含 `.deepagents/plan-spec.json` 与 `.deepagents/interaction-contract.json` 表示 host 将从结构化响应落盘这两个文件。",
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

async function composeInlineSystemPrompt(
  runtime: Pick<TextGeneratorRuntime, "deepagentsAgentsPath">,
  templatePrompt: string,
  stage: SessionPolicyStage,
): Promise<string> {
  const sessionPolicy = await fs.readFile(runtime.deepagentsAgentsPath, "utf8").catch(() => buildSessionPolicyDocument());
  return composeStageSystemPrompt(stage, templatePrompt, sessionPolicy);
}

function normalizeWorkspaceRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function buildProjectConfigGuardPrompt(
  runtime: Pick<TextGeneratorRuntime, "templateProjectConfigPolicy">,
  planSpec?: PlanSpec,
): string {
  const guardedFiles = Array.from(
    new Set(
      runtime.templateProjectConfigPolicy.guardedFiles
        .map((filePath) => normalizeWorkspaceRelativePath(filePath))
        .filter(Boolean),
    ),
  );
  if (guardedFiles.length === 0 || !planSpec) {
    return "";
  }

  const declaredFiles = new Set(
    (planSpec.projectConfigChanges ?? [])
      .map((change) => normalizeWorkspaceRelativePath(change.filePath))
      .filter(Boolean),
  );
  const undeclaredGuardedFiles = guardedFiles.filter((filePath) => !declaredFiles.has(filePath));
  if (undeclaredGuardedFiles.length === 0) {
    return "";
  }

  if ((planSpec.projectConfigChanges ?? []).length === 0) {
    return [
      "## Host-Enforced Project Config Guard",
      "",
      "`artifacts.planSpec.projectConfigChanges` is absent or empty for this phase.",
      `Therefore this phase and every subagent are explicitly forbidden to create, modify, delete, rewrite, or list in \`filesWritten\` these protected project configuration files: ${undeclaredGuardedFiles.map((filePath) => `\`${filePath}\``).join(", ")}.`,
      "If a configuration edit appears necessary, stop and report that the PRD/planSpec must first declare a project config change with `reason` and `prdEvidence`; do not add that declaration during generation.",
    ].join("\n");
  }

  return [
    "## Host-Enforced Project Config Guard",
    "",
    `Only project configuration files declared in \`artifacts.planSpec.projectConfigChanges\` may be edited. Do not create, modify, delete, rewrite, or list in \`filesWritten\` these undeclared protected files: ${undeclaredGuardedFiles.map((filePath) => `\`${filePath}\``).join(", ")}.`,
  ].join("\n");
}

function appendProjectConfigGuard(systemPrompt: string, guardPrompt: string): string {
  if (guardPrompt.trim() === "") {
    return systemPrompt;
  }
  return `${systemPrompt.trimEnd()}\n\n${guardPrompt}\n`;
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

export async function materializeGenerationPromptSnapshot(
  runtime: Pick<
    TextGeneratorRuntime,
    | "deepagentsAgentsPath"
    | "templateGeneratePromptPath"
    | "templateGenerateRepairPromptPath"
    | "deepagentsGeneratePromptSnapshotPath"
    | "deepagentsGenerateRepairPromptSnapshotPath"
    | "templateProjectConfigPolicy"
  >,
  planSpec: PlanSpec,
  stage: Extract<SessionPolicyStage, "generate" | "generate_repair">,
): Promise<void> {
  const promptPath = stage === "generate"
    ? runtime.templateGeneratePromptPath
    : runtime.templateGenerateRepairPromptPath;
  const snapshotPath = stage === "generate"
    ? runtime.deepagentsGeneratePromptSnapshotPath
    : runtime.deepagentsGenerateRepairPromptSnapshotPath;
  const baseSystemPrompt = await loadSystemPrompt(runtime, promptPath, stage);
  const projectConfigGuardPrompt = buildProjectConfigGuardPrompt(runtime, planSpec);

  await fs.writeFile(
    snapshotPath,
    appendProjectConfigGuard(baseSystemPrompt, projectConfigGuardPrompt),
    "utf8",
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

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
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
  runtime: Pick<TextGeneratorRuntime, "outputDirectory" | "deepagentsPlanSpecPath" | "deepagentsInteractionContractPath" | "deepagentsReferenceManifestPath" | "templateEnvironmentPolicy">,
): Record<string, unknown> {
  const lockedKeys = Array.from(new Set(runtime.templateEnvironmentPolicy.lockedKeys));
  return {
    planSpecSchemaValidation: {
      artifactKey: "artifacts.planSpec",
      artifactPath: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanSpecPath),
      blocking: true,
      required: true,
      mustValidateBeforeResponse: true,
      schema: z.toJSONSchema(planSpecSchema),
      rules: [
        "最终结构化响应中的 planSpec 必须是合法 JSON 对象。",
        "最终结构化响应中的 planSpec 必须通过这里提供的 schema 校验后，才允许结束当前阶段并返回结构化响应。",
        "可选字符串字段如果没有值，必须省略，不能写成空字符串。",
        "必填字符串字段必须提供非空字符串。",
        "只有当 PRD 分析明确要求项目配置变更时，才允许在 planSpec.projectConfigChanges 中声明对应配置文件、原因和 PRD 证据。",
      ],
    },
    environmentVariablePolicyValidation: {
      artifactKey: "artifacts.planSpec",
      artifactPath: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsPlanSpecPath),
      blockedPlanSpecPath: "environmentVariables[*].name",
      blocking: true,
      required: true,
      mustValidateBeforeResponse: true,
      lockedKeys,
      rules: lockedKeys.length > 0
        ? [
            `当前模板锁定的 .env.example 变量为：${lockedKeys.join(", ")}。`,
            "planSpec.environmentVariables[*].name 不得包含上述 lockedKeys 中的任何 key。",
            "如果 PRD 要求覆盖 locked key，计划阶段必须省略该变量，并在 planSpec.assumptions 或 artifacts.generatedSpec 中说明使用 starter 默认值；不得尝试覆盖。",
            "template.environmentPolicy.lockedKeys 的优先级高于 PRD 中的环境变量覆盖请求。",
          ]
        : [
            "当前模板没有锁定的 .env.example 变量，但新增环境变量仍必须来自 PRD 明确要求。",
          ],
    },
    interactionContractValidation: {
      artifactKey: "artifacts.interactionContract",
      artifactPath: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsInteractionContractPath),
      blocking: true,
      required: true,
      mustValidateBeforeResponse: true,
      schema: z.toJSONSchema(interactionContractSchema),
      rules: [
        "最终结构化响应中的 interactionContract 必须是合法 JSON 对象；host 会将它写入 artifacts.interactionContract。",
        "interactionContract 必须包含 flows、internalOperations、externalOperations 三个数组；没有对应操作时写空数组。",
        "必须覆盖关键用户流程的触发控件、fallback 触发、loading/empty/error 状态。",
        "如果包含外部 API 或第三方服务，必须写明 endpoint path、认证来源、参数格式/顺序、响应字段和 reference provenance。",
      ],
    },
    referenceUsageValidation: {
      artifactKey: "artifacts.referenceManifest",
      artifactPath: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsReferenceManifestPath),
      blocking: true,
      required: true,
      mustValidateBeforeResponse: true,
      rules: [
        "如果输入 externalReferences/localReferences/referenceManifest 中存在 retrievalStatus=downloaded 的外部 API、第三方服务或文档资料，必须先读取其 localPath 指向的本地文件，再组装 artifacts.generatedSpec、结构化响应 planSpec 和 interactionContract。",
        "外部 API endpoint、认证方式、参数格式/顺序、响应字段、错误码和限制信息必须优先来自已下载本地资料，不能凭模型记忆或远程 URL 猜测。",
        "artifacts.generatedSpec 的 References 章节必须在远程 URL 旁写出同一个 localPath，并说明关键 API/认证/参数/响应字段来自该本地文件。",
        "planSpec.references[*] 对应已下载资料时必须填写 localPath、retrievedAt、contentType、retrievalStatus；不得只保留远程 URL。",
      ],
    },
  };
}

function buildOptionalDesignArtifact(runtime: TextGeneratorRuntime): { design?: string } {
  return runtime.designPath
    ? { design: toVirtualWorkspacePath(runtime.outputDirectory, runtime.designPath) }
    : {};
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
      environmentPolicy: runtime.templateEnvironmentPolicy,
      projectConfigPolicy: runtime.templateProjectConfigPolicy,
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
      ...buildOptionalDesignArtifact(runtime),
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
      environmentPolicy: runtime.templateEnvironmentPolicy,
      projectConfigPolicy: runtime.templateProjectConfigPolicy,
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
      ...buildOptionalDesignArtifact(runtime),
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
  const inputDetails = readObjectField(record, [
    "input_token_details",
    "inputTokenDetails",
    "prompt_tokens_details",
    "promptTokensDetails",
  ]);
  const outputDetails = readObjectField(record, [
    "output_token_details",
    "outputTokenDetails",
    "completion_tokens_details",
    "completionTokenDetails",
  ]);

  const inputTokens = readNumberField(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens = readNumberField(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const totalTokens = readNumberField(record, ["total_tokens", "totalTokens"]);

  if (!isFiniteNumber(inputTokens) && !isFiniteNumber(outputTokens) && !isFiniteNumber(totalTokens)) {
    return null;
  }

  const usage: RuntimeUsageSummary = {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens:
      readNumberField(record, ["reasoning_tokens", "reasoningTokens"]) ??
      readNumberField(outputDetails, ["reasoning", "reasoning_tokens", "reasoningTokens"]),
    cachedInputTokens:
      readNumberField(record, ["cached_input_tokens", "cachedInputTokens"]) ??
      readNumberField(inputDetails, ["cache_read", "cacheRead", "cached_tokens", "cachedTokens"]) ??
      readNumberField(record, ["prompt_cache_hit_tokens", "promptCacheHitTokens"]),
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

function resolveRuntimeStatusAttempt(
  runtime: Partial<Pick<TextGeneratorRuntime, "planAttempt" | "generateAttempt">>,
  phase: RuntimeStatusPhase,
): number | undefined {
  const attempt =
    phase === "generate" || phase === "generateRepair" || phase === "generate_repair"
      ? runtime.generateAttempt
      : phase === "plan" || phase === "planRepair" || phase === "plan_repair"
        ? runtime.planAttempt
        : undefined;

  if (attempt !== undefined) {
    return isFiniteNumber(attempt) && attempt > 0 ? attempt : undefined;
  }

  return phase === "plan" || phase === "planRepair" || phase === "plan_repair" ||
    phase === "generate" || phase === "generateRepair" || phase === "generate_repair"
    ? 1
    : undefined;
}

function resolveRuntimeSubagentCount(phase: RuntimeStatusPhase): number | undefined {
  const count = buildGenerationSubagents(phase, false).length;
  return count > 0 ? count : undefined;
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
  runtime: Pick<TextGeneratorRuntime, "sessionId" | "templatePhases"> &
    Partial<Pick<TextGeneratorRuntime, "modelRoles" | "planAttempt" | "generateAttempt">>;
  phase: RuntimeStatusPhase;
  modelName?: string | undefined;
  usage?: RuntimeUsageSummary | undefined;
  fallbackModelName?: string | undefined;
}): RuntimeStatus {
  const usage = hasRuntimeUsageSummary(options.usage) ? options.usage : undefined;
  const modelRole = modelRoleForRuntimePhase(options.phase);
  const roleModelName = modelRole ? options.runtime.modelRoles?.[modelRole]?.modelName : undefined;
  const attempt = resolveRuntimeStatusAttempt(options.runtime, options.phase);
  const subagentCount = resolveRuntimeSubagentCount(options.phase);

  return {
    modelName: options.modelName ?? roleModelName ?? resolveRuntimeModelFallback(options.fallbackModelName),
    effort: resolveRuntimeStatusEffort(options.runtime.templatePhases, options.phase),
    sessionId: options.runtime.sessionId,
    phase: options.phase,
    ...(attempt ? { attempt } : {}),
    ...(subagentCount ? { subagentCount } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function mergeRuntimeStatus(current: RuntimeStatus, patch: Partial<RuntimeStatus>): RuntimeStatus {
  const usage = mergeRuntimeUsageSummary(current.usage, patch.usage);

  return {
    ...current,
    ...(patch.modelName ? { modelName: patch.modelName } : {}),
    ...(patch.effort ? { effort: patch.effort } : {}),
    ...(isFiniteNumber(patch.contextWindowUsedTokens)
      ? {
          contextWindowUsedTokens: isFiniteNumber(current.contextWindowUsedTokens)
            ? Math.max(current.contextWindowUsedTokens, patch.contextWindowUsedTokens)
            : patch.contextWindowUsedTokens,
        }
      : {}),
    ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
    ...(patch.phase ? { phase: patch.phase } : {}),
    ...(isFiniteNumber(patch.subagentCount) && patch.subagentCount >= 0
      ? { subagentCount: patch.subagentCount }
      : {}),
    ...(usage ? { usage } : current.usage ? { usage: current.usage } : {}),
  };
}

function runtimeUsageSignature(usage: RuntimeUsageSummary): string {
  return [
    usage.inputTokens ?? "",
    usage.outputTokens ?? "",
    usage.totalTokens ?? "",
  ].join(":");
}

function mergeEquivalentRuntimeUsageSummary(
  current: RuntimeUsageSummary | undefined,
  patch: RuntimeUsageSummary,
): RuntimeUsageSummary {
  if (!current) {
    return patch;
  }

  const mergeValue = (left?: number, right?: number): number | undefined => {
    if (!isFiniteNumber(left)) {
      return right;
    }
    if (!isFiniteNumber(right)) {
      return left;
    }
    return Math.max(left, right);
  };

  return {
    inputTokens: mergeValue(current.inputTokens, patch.inputTokens),
    outputTokens: mergeValue(current.outputTokens, patch.outputTokens),
    totalTokens: mergeValue(current.totalTokens, patch.totalTokens),
    reasoningTokens: mergeValue(current.reasoningTokens, patch.reasoningTokens),
    cachedInputTokens: mergeValue(current.cachedInputTokens, patch.cachedInputTokens),
  };
}

export function extractRuntimeStatusPatch(
  payload: unknown,
  options: { seenUsageSignatures?: Set<string> } = {},
): Partial<RuntimeStatus> {
  const usageSummaries = collectRuntimeUsageSummaries(payload);
  const payloadUsageSummariesBySignature = usageSummaries.reduce<Map<string, RuntimeUsageSummary>>((current, usage) => {
    const signature = runtimeUsageSignature(usage);
    current.set(signature, mergeEquivalentRuntimeUsageSummary(current.get(signature), usage));
    return current;
  }, new Map());
  const usageSummariesToMerge = Array.from(payloadUsageSummariesBySignature.entries()).flatMap(([signature, usage]) => {
    if (options.seenUsageSignatures?.has(signature)) {
      return [];
    }
    options.seenUsageSignatures?.add(signature);
    return [usage];
  });
  const usage = usageSummariesToMerge.reduce<RuntimeUsageSummary | undefined>(
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
  agentStatuses: AgentWorkStatus[];
  seenRuntimeUsageSignatures: Set<string>;
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

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function normalizeTodoItemCandidate(value: unknown): TodoItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  return typeof record.content === "string"
    ? { content: record.content, status: isTodoStatus(record.status) ? record.status : "pending" }
    : null;
}

function decodeJsonStringFragment(value: string): string {
  try {
    const parsed = JSON.parse(`"${value}"`);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function extractLooseTodoList(value: string): TodoItem[] | null {
  const todos: TodoItem[] = [];
  const objectPattern = /\{[^{}]*\}/g;
  for (const match of value.matchAll(objectPattern)) {
    const itemText = match[0];
    const contentMatch = itemText.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
    const statusMatch = itemText.match(/"status"\s*:\s*"(pending|in_progress|completed)"/);
    if (!contentMatch?.[1]) {
      continue;
    }

    todos.push({
      content: decodeJsonStringFragment(contentMatch[1]),
      status: (statusMatch?.[1] as TodoStatus | undefined) ?? "pending",
    });
  }

  return todos.length > 0 ? todos : null;
}

function normalizeTodoListCandidate(value: unknown, depth = 0): TodoItem[] | null {
  if (isTodoList(value)) {
    return value.map((todo) => ({ content: todo.content, status: todo.status }));
  }

  if (Array.isArray(value)) {
    const todos = value.map(normalizeTodoItemCandidate);
    return todos.every(Boolean) ? todos as TodoItem[] : null;
  }

  if (typeof value !== "string" || depth > 2) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string" && parsed !== value) {
      return normalizeTodoListCandidate(parsed, depth + 1);
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return normalizeTodoListCandidate((parsed as Record<string, unknown>).todos, depth + 1);
    }
    return normalizeTodoListCandidate(parsed, depth + 1);
  } catch {
    return extractLooseTodoList(trimmed);
  }
}

export function normalizeWriteTodosToolCallArgs(args: unknown): Record<string, unknown> | null {
  let record: Record<string, unknown> | null = null;

  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      record = null;
    }
  } else if (args && typeof args === "object" && !Array.isArray(args)) {
    record = args as Record<string, unknown>;
  }

  if (!record) {
    return null;
  }

  const todos = normalizeTodoListCandidate(record.todos);
  return todos ? { ...record, todos } : null;
}

function normalizeWriteTodosToolCall(toolCall: unknown): unknown {
  if (!toolCall || typeof toolCall !== "object") {
    return toolCall;
  }

  const record = toolCall as Record<string, unknown>;
  if (record.name !== "write_todos") {
    return toolCall;
  }

  const normalizedArgs = normalizeWriteTodosToolCallArgs(record.args);
  return normalizedArgs ? { ...record, args: normalizedArgs } : toolCall;
}

function createWriteTodosCompatibilityMiddleware() {
  return createMiddleware({
    name: "writeTodosCompatibilityMiddleware",
    wrapToolCall: async (request, handler) => {
      const normalizedToolCall = normalizeWriteTodosToolCall(request.toolCall);
      return handler(
        normalizedToolCall === request.toolCall
          ? request
          : { ...request, toolCall: normalizedToolCall as typeof request.toolCall },
      );
    },
  });
}

function extractTodosFromPayload(value: unknown): TodoItem[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const normalizedTodos = normalizeTodoListCandidate(record.todos);
  if (normalizedTodos) {
    return normalizedTodos;
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

  return normalizeTodoListCandidate(match[1]!);
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
  const args = toolCall.args && typeof toolCall.args === "object" ? toolCall.args as Record<string, unknown> : null;
  const target = describeToolTargetFromInput(name, args);
  const action = humanizeToolName(name);
  if (target) {
    return /completed|success|done/i.test(status)
      ? `${action}完成：${target}`
      : `${action}：${target}`;
  }
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

function compactToolDetail(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function describeToolTargetFromInput(toolName: string, input: Record<string, unknown> | null): string | null {
  if (toolName === "write_todos") {
    return null;
  }

  const target =
    input?.file_path ??
    input?.path ??
    input?.target_file ??
    input?.targetPath;

  if (typeof target === "string" && target.trim()) {
    return target.trim();
  }

  if (toolName === "task") {
    const subagentName = readStringField(input, ["subagent_type", "subagentType", "agent", "agentName"]);
    const taskSummary = readStringField(input, ["description", "task", "name", "title", "summary"]);
    if (subagentName && taskSummary) {
      return `${subagentName}：${compactToolDetail(taskSummary)}`;
    }
    if (taskSummary) {
      return compactToolDetail(taskSummary);
    }
    return subagentName ?? null;
  }

  const searchableSummary = readStringField(input, ["query", "pattern", "url"]);
  if (searchableSummary) {
    return compactToolDetail(searchableSummary);
  }

  return null;
}

function describeToolTarget(toolName: string, payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  return describeToolTargetFromInput(toolName, parseToolInput(record.input));
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
    case "task":
      return "启动子任务";
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
  const detailedTarget = target ? `${target}${location ? `（${location}）` : ""}` : null;

  if (event === "on_tool_start") {
    return detailedTarget ? `${action}：${detailedTarget}` : `${action}。`;
  }

  if (event === "on_tool_end") {
    if (detailedTarget) {
      return `${action}完成：${detailedTarget}`;
    }
    return toolName === "task" || action.startsWith("调用工具 ") ? null : `${action}完成。`;
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
  const target = describeToolTargetFromInput(first.name, args);
  const location = describeToolLocation(first.name, args);

  if (target) {
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

function buildDefaultAgentStatuses(runtimePhase: RuntimeStatusPhase, leaderUserAgent?: string): AgentWorkStatus[] {
  const subagentNames = buildGenerationSubagents(runtimePhase, false)
    .map((subagent) => typeof subagent.name === "string" ? subagent.name : null)
    .filter((name): name is string => Boolean(name));

  return ["leader", ...subagentNames].map((name, index) => ({
    name,
    status: index === 0 ? "working" : "idle",
    ...(index === 0 && leaderUserAgent ? { userAgent: leaderUserAgent } : {}),
  }));
}

function incrementAgentWorkCount(agent: AgentWorkStatus): number {
  const currentCount = isFiniteNumber(agent.workCount) && agent.workCount > 0
    ? Math.round(agent.workCount)
    : 0;
  return currentCount + 1;
}

function markAgentWorking(
  agentStatuses: AgentWorkStatus[],
  activeInstanceCounts: Map<string, number>,
): AgentWorkStatus[] {
  return agentStatuses.map((agent) => {
    const activeInstanceCount = activeInstanceCounts.get(agent.name);
    const isActive = isFiniteNumber(activeInstanceCount) && activeInstanceCount > 0;
    const completedWork = !isActive && agent.status === "working";
    return {
      ...agent,
      status: isActive
        ? "working"
        : completedWork
          ? "done"
          : agent.status,
      activeInstanceCount: isActive ? Math.round(activeInstanceCount) : undefined,
      ...(completedWork ? { workCount: incrementAgentWorkCount(agent) } : {}),
    };
  });
}

function markActiveAgentsDone(agentStatuses: AgentWorkStatus[]): AgentWorkStatus[] {
  return agentStatuses.map((agent) => {
    const completedWork = agent.status === "working";
    return {
      ...agent,
      status: completedWork ? "done" : agent.status,
      activeInstanceCount: undefined,
      ...(completedWork ? { workCount: incrementAgentWorkCount(agent) } : {}),
    };
  });
}

function incrementActiveAgentInstance(
  activeInstanceCounts: Map<string, number>,
  name: string,
): void {
  activeInstanceCounts.set(name, (activeInstanceCounts.get(name) ?? 0) + 1);
}

function collectActiveAgentInstanceCounts(
  payload: unknown,
  knownNames: Set<string>,
  activeInstanceCounts = new Map<string, number>(),
  seen = new Set<object>(),
): Map<string, number> {
  if (typeof payload === "string") {
    if (knownNames.has(payload)) {
      incrementActiveAgentInstance(activeInstanceCounts, payload);
    }
    return activeInstanceCounts;
  }

  if (!payload || typeof payload !== "object") {
    return activeInstanceCounts;
  }

  if (seen.has(payload)) {
    return activeInstanceCounts;
  }
  seen.add(payload);

  if (Array.isArray(payload)) {
    for (const item of payload) {
      collectActiveAgentInstanceCounts(item, knownNames, activeInstanceCounts, seen);
    }
    return activeInstanceCounts;
  }

  const record = payload as Record<string, unknown>;
  const recordActiveNames = new Set<string>();
  for (const [key, value] of Object.entries(record)) {
    if (knownNames.has(key)) {
      recordActiveNames.add(key);
    }
    if (typeof value === "string" && knownNames.has(value)) {
      recordActiveNames.add(value);
    }
  }

  for (const key of ["agent", "agentName", "name", "node", "nodeName"] as const) {
    const value = readStringField(record, [key]);
    if (value && knownNames.has(value)) {
      recordActiveNames.add(value);
    }
  }

  for (const name of recordActiveNames) {
    incrementActiveAgentInstance(activeInstanceCounts, name);
  }

  const metadata = readObjectField(record, ["metadata", "kwargs", "config", "langgraph_node"]);
  if (metadata) {
    collectActiveAgentInstanceCounts(metadata, knownNames, activeInstanceCounts, seen);
  }

  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      collectActiveAgentInstanceCounts(value, knownNames, activeInstanceCounts, seen);
    }
  }

  return activeInstanceCounts;
}

function updateAgentStatusesFromChunk(trace: DeepAgentsTraceState, mode: string | undefined, payload: unknown): void {
  const knownNames = new Set(trace.agentStatuses.map((agent) => agent.name));
  const activeInstanceCounts = collectActiveAgentInstanceCounts(payload, knownNames);

  if (activeInstanceCounts.size === 0) {
    trace.agentStatuses = markAgentWorking(trace.agentStatuses, new Map([["leader", 1]]));
    return;
  }

  if (mode === "values") {
    activeInstanceCounts.set("leader", Math.max(activeInstanceCounts.get("leader") ?? 0, 1));
  }

  trace.agentStatuses = markAgentWorking(trace.agentStatuses, activeInstanceCounts);
}

function getTodoBoardStreamProgress(trace: DeepAgentsTraceState): TodoBoardState["streamProgress"] {
  const progress: NonNullable<TodoBoardState["streamProgress"]> = {};
  const inputTokens = trace.runtimeStatus.usage?.inputTokens ?? trace.runtimeStatus.contextWindowUsedTokens;

  if (isFiniteNumber(inputTokens)) {
    progress.inputTokens = inputTokens;
  }
  if (isFiniteNumber(trace.receivedOutputTokens) && trace.receivedOutputTokens > 0) {
    progress.outputTokens = trace.receivedOutputTokens;
    progress.outputTokensEstimated = trace.receivedOutputTokensEstimated;
  }

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

function isMessageToolIntentSummary(summary: string): boolean {
  return /^准备(?:读取文件|写入文件|编辑文件|列出目录|搜索文件|更新 todo|启动子任务)：/.test(summary);
}

export function shouldAppendDeepAgentsWorkflowLog(mode: string, summary: string): boolean {
  if (mode === "messages") {
    return isMessageToolIntentSummary(summary);
  }

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

  if (mode === "updates" && !/[：:/.\[\]0-9A-Za-z\u4e00-\u9fff-]{4,}/.test(summary)) {
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
  trace.runtimeStatus = mergeRuntimeStatus(
    trace.runtimeStatus,
    extractRuntimeStatusPatch(payload, { seenUsageSignatures: trace.seenRuntimeUsageSignatures }),
  );

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
  updateAgentStatusesFromChunk(trace, mode, payload);

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
    agentStatuses: trace.agentStatuses,
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
  if (shouldAppendDeepAgentsWorkflowLog(mode, summary)) {
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
  leaderUserAgent?: string,
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
    agentStatuses: buildDefaultAgentStatuses(runtimePhase, leaderUserAgent),
    seenRuntimeUsageSignatures: new Set(),
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
    agentStatuses: trace.agentStatuses,
  });

  for (let retryCount = 0; ; retryCount += 1) {
    try {
      trace.modelOutputStarted = false;

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
      trace.agentStatuses = markActiveAgentsDone(trace.agentStatuses);
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
        agentStatuses: trace.agentStatuses,
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
        agentStatuses: trace.agentStatuses,
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

function normalizeProtocolModelName(modelName: string, protocol: ModelProtocol): string {
  const prefix = `${protocol}:`;
  return modelName.startsWith(prefix) ? modelName.slice(prefix.length) : modelName;
}

async function resolveModel(config: ModelRoleConfig, effort?: TemplatePhaseEffort) {
  if (config.protocol === "anthropic") {
    return new ChatAnthropic({
      model: normalizeProtocolModelName(config.modelName, config.protocol),
      temperature: 0,
      ...(effort ? { outputConfig: { effort } } : {}),
      ...(config.baseURL ? { anthropicApiUrl: config.baseURL } : {}),
      ...(config.userAgent ? { clientOptions: { defaultHeaders: { "User-Agent": config.userAgent } } } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    });
  }

  return createOpenAICompatibleModel({
    modelName: normalizeProtocolModelName(config.modelName, config.protocol),
    ...(effort ? { effort } : {}),
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.userAgent ? { userAgent: config.userAgent } : {}),
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

export function buildGenerationSubagents(
  runtimePhase: RuntimeStatusPhase,
  includeTemplateSkills: boolean,
  projectConfigGuardPrompt = "",
  middleware?: readonly unknown[],
): Array<Record<string, unknown>> {
  if (runtimePhase !== "generate" && runtimePhase !== "generateRepair" && runtimePhase !== "generate_repair") {
    return [];
  }

  const skills = includeTemplateSkills ? ["/.deepagents/skills"] : undefined;
  const basePrompt = [
    "You are a bounded implementation subagent for the app-builder generation workflow.",
    "Only accept work when the main agent gives you an explicit non-overlapping file/path or responsibility scope.",
    "Do not redefine product requirements, rewrite plan artifacts, or expand beyond the validated planSpec.",
    "Do not edit files outside your assigned ownership. If the work appears coupled or conflict-prone, report that it should be handled by the main agent instead.",
    "Subagents are allowed only as a throughput optimization for genuinely parallel work; if your slice cannot proceed independently, stop and report the blocker.",
    "Return one concise final report listing files touched, work completed, blockers, and validation gaps.",
    projectConfigGuardPrompt.trim(),
  ].filter(Boolean).join("\n");
  const withSkills = (subagent: Record<string, unknown>): Record<string, unknown> => (
    skills ? { ...subagent, skills } : subagent
  );
  const withMiddleware = (subagent: Record<string, unknown>): Record<string, unknown> => (
    middleware && middleware.length > 0 ? { ...subagent, middleware } : subagent
  );

  return [
    withMiddleware(withSkills({
      name: "frontend-implementer",
      description: "Implements independently owned pages, components, styles, and client interactions when that work can run in parallel with other generation slices.",
      systemPrompt: `${basePrompt}\nFrontend scope: implement only assigned page/component/client-interaction files and preserve existing routing, shell, sidebar, and data-fetching contracts.`,
    })),
    withMiddleware(withSkills({
      name: "backend-implementer",
      description: "Implements independently owned API routes, server logic, Prisma/data wiring, and persistence changes when that work can run in parallel with other generation slices.",
      systemPrompt: `${basePrompt}\nBackend scope: implement only assigned API/server/data files. Do not split ownership of shared schema or configuration files with another agent.`,
    })),
    withMiddleware(withSkills({
      name: "integration-verifier",
      description: "Checks independently verifiable integration coverage and reports gaps while other implementation slices run in parallel.",
      systemPrompt: `${basePrompt}\nVerification scope: prefer read-only inspection. Only make narrow fixes when explicitly assigned; otherwise report missing pages, APIs, data wiring, or report coverage gaps.`,
    })),
  ];
}

function buildGeneralPurposeCompatibilitySubagent(
  deepagents: Record<string, unknown>,
  middleware: readonly unknown[],
  includeTemplateSkills: boolean,
): Record<string, unknown> | null {
  const generalPurpose = deepagents.GENERAL_PURPOSE_SUBAGENT;
  if (!generalPurpose || typeof generalPurpose !== "object" || Array.isArray(generalPurpose)) {
    return null;
  }

  return {
    ...(generalPurpose as Record<string, unknown>),
    middleware,
    ...(includeTemplateSkills ? { skills: ["/.deepagents/skills"] } : {}),
  };
}

export class DeepAgentsTextGenerator implements TextGenerator {
  private readonly modelRoles: ModelRoleConfigMap;

  constructor(options?: DeepAgentsTextGeneratorOptions) {
    this.modelRoles = resolveConstructorModelRoles(options);
  }

  private async runPhase<T>(
    runtime: TextGeneratorRuntime,
    options: {
      promptPath?: string;
      systemPrompt?: string;
      promptSnapshotPath: string;
      responseSchema: z.ZodType<T>;
      payload: Record<string, unknown>;
      stage: SessionPolicyStage;
      runtimePhase?: RuntimeStatusPhase;
      timeoutLabel: string;
    },
  ): Promise<T> {
    const deepagents = await loadDeepagentsModule();
    const createDeepAgent = deepagents.createDeepAgent;
    const runtimePhase = options.runtimePhase ?? (
      options.stage === "plan_analysis" || options.stage === "plan"
        ? "plan"
        : options.stage === "plan_repair"
          ? "planRepair"
          : options.stage === "generate"
            ? "generate"
            : "generateRepair"
    );
    const modelRole = modelRoleForRuntimePhase(runtimePhase);
    const modelConfig = modelRole ? (runtime.modelRoles?.[modelRole] ?? this.modelRoles[modelRole]) : this.modelRoles.plan;
    const resolvedModel = await resolveModel(
      modelConfig,
      runtimePhase === "plan" || runtimePhase === "generate"
        ? runtime.templatePhases[runtimePhase]?.effort
        : runtimePhase === "planRepair" || runtimePhase === "plan_repair"
          ? runtime.templatePhases.planRepair?.effort
          : runtime.templatePhases.generateRepair?.effort,
    );
    const payloadPlanSpec = planSpecSchema.safeParse(options.payload.planSpec);
    const projectConfigGuardPrompt = buildProjectConfigGuardPrompt(
      runtime,
      payloadPlanSpec.success ? payloadPlanSpec.data : undefined,
    );
    const baseSystemPrompt = options.systemPrompt !== undefined
      ? await composeInlineSystemPrompt(runtime, options.systemPrompt, options.stage)
      : await loadSystemPrompt(runtime, options.promptPath as string, options.stage);
    const systemPrompt =
      options.stage === "generate" || options.stage === "generate_repair"
        ? appendProjectConfigGuard(baseSystemPrompt, projectConfigGuardPrompt)
        : baseSystemPrompt;
    const skillsDirectory = path.join(runtime.templateDirectory, "skills");

    await fs.writeFile(options.promptSnapshotPath, systemPrompt, "utf8");

    const agentOptions: any = {
      model: resolvedModel,
      responseFormat: toolStrategy(options.responseSchema),
      systemPrompt,
      permissions: buildHostManagedArtifactPermissions(),
    };
    const hostManagedArtifactWriteGuardMiddleware = createHostManagedArtifactWriteGuardMiddleware();
    const writeTodosCompatibilityMiddleware = createWriteTodosCompatibilityMiddleware();
    agentOptions.middleware = [hostManagedArtifactWriteGuardMiddleware, writeTodosCompatibilityMiddleware];

    const hasTemplateSkills = await pathExists(skillsDirectory);
    if (hasTemplateSkills) {
      agentOptions.skills = ["/.deepagents/skills"];
    }

    const generationSubagents = buildGenerationSubagents(
      runtimePhase,
      hasTemplateSkills,
      projectConfigGuardPrompt,
      [hostManagedArtifactWriteGuardMiddleware, writeTodosCompatibilityMiddleware],
    );
    const generalPurposeSubagent = buildGeneralPurposeCompatibilitySubagent(
      deepagents as Record<string, unknown>,
      [hostManagedArtifactWriteGuardMiddleware, writeTodosCompatibilityMiddleware],
      hasTemplateSkills,
    );
    const subagents = [
      ...(generalPurposeSubagent ? [generalPurposeSubagent] : []),
      ...generationSubagents,
    ];
    if (subagents.length > 0) {
      agentOptions.subagents = subagents;
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
      runtimePhase,
      options.timeoutLabel,
      modelConfig.modelName,
      modelConfig.userAgent,
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
      const hostManagedArtifactWriteGuardMiddleware = createHostManagedArtifactWriteGuardMiddleware();
      const writeTodosCompatibilityMiddleware = createWriteTodosCompatibilityMiddleware();
      const agentOptions: any = {
        model: resolvedModel,
        middleware: [hostManagedArtifactWriteGuardMiddleware, writeTodosCompatibilityMiddleware],
        responseFormat: toolStrategy(referenceMarkdownConversionSchema),
        systemPrompt: REFERENCE_MARKDOWN_CONVERSION_SYSTEM_PROMPT,
        permissions: buildHostManagedArtifactPermissions(),
        backend: new deepagents.FilesystemBackend({
          rootDir: runtime.outputDirectory,
          virtualMode: true,
        }),
      };
      const generalPurposeSubagent = buildGeneralPurposeCompatibilitySubagent(
        deepagents as Record<string, unknown>,
        [hostManagedArtifactWriteGuardMiddleware, writeTodosCompatibilityMiddleware],
        false,
      );
      if (generalPurposeSubagent) {
        agentOptions.subagents = [generalPurposeSubagent];
      }
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

  async analyzePrd(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    try {
      return await this.runPhase(runtime, {
        systemPrompt: PRD_ANALYSIS_SYSTEM_PROMPT,
        promptSnapshotPath: path.join(path.dirname(runtime.deepagentsPlanPromptSnapshotPath), "prd-analysis-system-prompt.md"),
        responseSchema: planResultSchema,
        stage: "plan_analysis",
        runtimePhase: "plan",
        timeoutLabel: "deepagents PRD analysis",
        payload: {
          ...buildPlanProjectPayload(spec, runtime),
          planningPipeline: {
            currentStage: "prd-analysis",
            runsInParallelWith: "references.resolve_external",
            nextStage: "prd-assembly",
          },
          localReferences: [],
        },
      });
    } catch (error) {
      await writeErrorLog(runtime.deepagentsErrorLogPath, error);
      throw error;
    }
  }

  async assemblePlanProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    try {
      const prdAnalysisMarkdown = await readIfExists(runtime.deepagentsAnalysisPath) ?? "";
      return await this.runPhase(runtime, {
        systemPrompt: PRD_ASSEMBLY_SYSTEM_PROMPT,
        promptSnapshotPath: path.join(path.dirname(runtime.deepagentsPlanPromptSnapshotPath), "prd-assembly-system-prompt.md"),
        responseSchema: planDeliveryResultSchema,
        stage: "plan",
        runtimePhase: "plan",
        timeoutLabel: "deepagents PRD assembly",
        payload: {
          ...buildPlanProjectPayload(spec, runtime),
          planningPipeline: {
            currentStage: "prd-assembly",
            completedStages: ["prd-analysis", "references.resolve_external"],
          },
          prdAnalysisMarkdown,
        },
      });
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
        responseSchema: planDeliveryResultSchema,
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
        responseSchema: planDeliveryResultSchema,
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
            environmentPolicy: runtime.templateEnvironmentPolicy,
            projectConfigPolicy: runtime.templateProjectConfigPolicy,
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
            ...buildOptionalDesignArtifact(runtime),
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
            environmentPolicy: runtime.templateEnvironmentPolicy,
            projectConfigPolicy: runtime.templateProjectConfigPolicy,
          },
          generationRepairPolicy: {
            dataMode: "rest_api",
            attempt: runtime.generateAttempt ?? 1,
            maxRepairs: runtime.maxGenerateRetries ?? 0,
            validationFailures: runtime.retryReasons ?? [],
          },
          artifacts: {
            analysis: toVirtualWorkspacePath(runtime.outputDirectory, runtime.deepagentsAnalysisPath),
            ...buildOptionalDesignArtifact(runtime),
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
