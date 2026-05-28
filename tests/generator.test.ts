import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  collectPageRoutePatterns,
  pageFilePathToRoutePattern,
  routeToAdminPagePath,
} from "../src/lib/app-router.js";
import {
  apiFilePathToHttpPath,
  buildRuntimeInteractionTargets,
  closeRuntimeInteractionValidationSession,
  detectDevServerOutputFailure,
  matchRuntimeInteractionTarget,
  parseDevServerRequestLine,
  runInteractiveRuntimeValidation,
  runNonInteractiveRuntimeValidation,
  runSmokeRuntimeValidation,
  RuntimeInteractionCoverageTracker,
  runtimeInteractionTargetToProbePath,
  type SmokeBrowserLauncher,
  type SmokeConsoleMessage,
  type SmokePage,
  type SmokeResponse,
  type RuntimeInteractionValidationSession,
} from "../src/lib/interactive-runtime-validation.js";
import { resolveModelRoleConfigs } from "../src/lib/model-config.js";
import { planSpecSchema, validatePlanSpec, type PlanSpec } from "../src/lib/plan-spec.js";
import {
  validateInteractionContract,
  validateInteractionContractForPlanSpec,
  type InteractionContract,
} from "../src/lib/interaction-contract.js";
import {
  filterRedundantValidationDetailLines,
  generateApplication,
  materializeRuntimeEnv,
  resolveSpawnCommand,
  validateSessionPhase,
} from "../src/lib/generator.js";
import { prepareOutputWorkspace } from "../src/lib/output-workspace.js";
import { buildSessionPolicyDocument } from "../src/lib/session-policy.js";
import {
  DEFAULT_GENERATE_SUBAGENT_PARALLELISM,
  buildHostManagedArtifactPermissions,
  buildGenerationSubagents,
  buildPiHostParallelGenerationBoardState,
  buildPiParallelGenerationTaskItems,
  buildPiStructuredPrompt,
  buildPlanProjectPayload,
  buildPlanRepairPayload,
  createPiTaskCompatibilityTool,
  createHostManagedArtifactWriteGuardMiddleware,
  extractStructuredResponseFromPiText,
  HOST_MANAGED_WRITE_PROTECTED_ARTIFACT_PATHS,
  isHostManagedWriteProtectedArtifactPath,
  mapPiToolPathToWorkspaceRelative,
  normalizePiTaskToolCallArgs,
  PiTextGenerator,
  resolveGenerateSubagentParallelism,
  runDeepAgentWithLogs,
  runPiAgentWithLogs,
  rewritePiToolPathInput,
} from "../src/lib/text-generator.js";
import { closeWorkflowBoard } from "../src/lib/terminal-ui.js";
import { copyStarterScaffold, loadTemplatePack } from "../src/lib/template-pack.js";
import {
  GeneratedAppValidator,
  GeneratedProject,
  NormalizedSpec,
  PlanResult,
  type ReferenceMarkdownConversionInput,
  type ReferenceMarkdownConversionResult,
  TextGenerator,
  TextGeneratorRuntime,
} from "../src/lib/types.js";
import {
  LEGACY_WORKSPACE_DIR_NAME,
  WORKSPACE_DIR_NAME,
  createWorkspaceArtifactPaths,
} from "../src/lib/workspace-artifacts.js";

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function containsObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsObjectKey(item, key));
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const object = value as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(object, key) ||
    Object.values(object).some((item) => containsObjectKey(item, key));
}

function buildPlanSpec(): PlanSpec {
  return {
    version: 1,
    appName: "Field Ops Planner",
    summary: "面向现场运维团队的工单计划与执行系统。",
    resources: [
      {
        name: "WorkOrder",
        pluralName: "WorkOrders",
        routeSegment: "work-orders",
        description: "现场工单。",
        fields: [
          { name: "title", label: "标题", type: "string", required: true, source: "prd" },
          { name: "status", label: "状态", type: "string", required: true, source: "prd" },
        ],
        relations: [],
      },
    ],
    pages: [
      {
        name: "工单列表",
        route: "/work-orders",
        kind: "list",
        resourceName: "WorkOrder",
        purpose: "查看与筛选工单。",
      },
      {
        name: "工单详情",
        route: "/work-orders/[id]",
        kind: "detail",
        resourceName: "WorkOrder",
        purpose: "查看与更新单个工单。",
      },
    ],
    apis: [
      {
        name: "WorkOrderCollection",
        resourceName: "WorkOrder",
        path: "/app/api/work-orders/route.ts",
        methods: ["GET", "POST"],
        requestShape: "分页查询参数或创建工单对象。",
        responseShape: "工单列表或新建工单对象。",
      },
    ],
    flows: [
      {
        name: "工单跟踪",
        steps: ["进入工单列表", "查看工单详情", "更新工单状态"],
      },
    ],
    assumptions: ["未定义复杂权限模型，第一版按登录用户统一授权。"],
    acceptanceChecks: [
      {
        id: "resource-work-order",
        description: "必须实现 WorkOrder 资源。",
        type: "resource",
        target: "WorkOrder",
      },
      {
        id: "page-work-order-list",
        description: "必须实现工单列表页。",
        type: "page",
        target: "/work-orders",
      },
      {
        id: "page-work-order-detail",
        description: "必须实现工单详情页。",
        type: "page",
        target: "/work-orders/[id]",
      },
      {
        id: "api-work-order",
        description: "必须实现工单集合接口。",
        type: "api",
        target: "/app/api/work-orders/route.ts",
      },
      {
        id: "flow-work-order",
        description: "必须覆盖工单跟踪流程。",
        type: "flow",
        target: "工单跟踪",
      },
    ],
  };
}

function buildRootDashboardPlanSpec(): PlanSpec {
  const base = buildPlanSpec();
  return {
    ...base,
    pages: [
      {
        name: "首页仪表盘",
        route: "/",
        kind: "dashboard",
        purpose: "在根路径展示核心业务状态。",
      },
    ],
    acceptanceChecks: [
      ...base.acceptanceChecks.filter((check) => check.type !== "page"),
      {
        id: "page-dashboard-root",
        description: "必须实现根路径首页仪表盘。",
        type: "page",
        target: "/",
      },
    ],
  };
}

function buildIndirectSupportPlanSpec(): PlanSpec {
  return {
    version: 1,
    appName: "Weather Aggregation",
    summary: "通过聚合天气 API 返回小时与日预报的轻量天气应用。",
    resources: [
      {
        name: "Weather",
        pluralName: "Weather",
        routeSegment: "weather",
        description: "聚合天气数据。",
        fields: [
          { name: "locationId", label: "位置ID", type: "string", required: true, source: "prd" },
          { name: "temperature", label: "温度", type: "number", required: true, source: "prd" },
        ],
        relations: [],
      },
      {
        name: "HourlyForecast",
        pluralName: "HourlyForecasts",
        routeSegment: "hourly-forecast",
        description: "小时预报嵌套数据。",
        usage: "indirect",
        fields: [
          { name: "time", label: "时间", type: "datetime", required: true, source: "prd" },
          { name: "temperature", label: "温度", type: "number", required: true, source: "prd" },
        ],
        relations: [],
      },
      {
        name: "DailyForecast",
        pluralName: "DailyForecasts",
        routeSegment: "daily-forecast",
        description: "日预报嵌套数据。",
        usage: "indirect",
        fields: [
          { name: "date", label: "日期", type: "date", required: true, source: "prd" },
          { name: "tempMax", label: "最高温", type: "number", required: true, source: "prd" },
        ],
        relations: [],
      },
    ],
    pages: [
      {
        name: "天气看板",
        route: "/",
        kind: "dashboard",
        resourceName: "Weather",
        purpose: "展示实时天气和聚合预报。",
      },
    ],
    apis: [
      {
        name: "WeatherAggregation",
        resourceName: "Weather",
        path: "/app/api/weather/route.ts",
        methods: ["GET"],
        requestShape: "location query",
        responseShape: "now + hourly + daily",
      },
    ],
    flows: [
      {
        name: "天气查询",
        steps: ["打开首页", "请求天气聚合接口", "展示当前天气与预报"],
      },
    ],
    assumptions: ["小时预报与日预报作为 Weather API 的嵌套返回体提供。"],
    acceptanceChecks: [
      {
        id: "page-dashboard",
        description: "首页能展示聚合天气信息。",
        type: "page",
        target: "/",
      },
      {
        id: "api-weather",
        description: "天气聚合接口必须实现。",
        type: "api",
        target: "/app/api/weather/route.ts",
      },
      {
        id: "flow-weather",
        description: "天气查询流程必须可用。",
        type: "flow",
        target: "天气查询",
      },
    ],
  };
}

function buildColonRoutePlanSpec(): PlanSpec {
  return {
    version: 1,
    appName: "Alarm Guard",
    summary: "使用 Next App Router 动态路由展示报警详情和工单详情。",
    resources: [
      {
        name: "Alarm",
        pluralName: "Alarms",
        routeSegment: "alarms",
        description: "报警记录。",
        usage: "indirect",
        fields: [
          { name: "source_Path", label: "源路径", type: "string", required: true, source: "prd" },
        ],
        relations: [],
      },
      {
        name: "WorkOrder",
        pluralName: "WorkOrders",
        routeSegment: "workorders",
        description: "工单记录。",
        fields: [
          { name: "id", label: "ID", type: "number", required: true, source: "prd" },
        ],
        relations: [],
      },
    ],
    pages: [
      {
        name: "报警列表",
        route: "/alarms",
        kind: "list",
        resourceName: "Alarm",
        purpose: "查看报警列表。",
      },
      {
        name: "报警详情",
        route: "/alarms/:source_Path",
        kind: "detail",
        resourceName: "Alarm",
        purpose: "查看单条报警详情。",
      },
      {
        name: "工单列表",
        route: "/workorders",
        kind: "list",
        resourceName: "WorkOrder",
        purpose: "查看工单列表。",
      },
      {
        name: "工单详情",
        route: "/workorders/:id",
        kind: "detail",
        resourceName: "WorkOrder",
        purpose: "查看单条工单详情。",
      },
    ],
    apis: [
      {
        name: "WorkOrderCollection",
        resourceName: "WorkOrder",
        path: "/app/api/workorders/route.ts",
        methods: ["GET"],
        requestShape: "分页查询参数。",
        responseShape: "工单列表。",
      },
    ],
    flows: [
      {
        name: "查看详情",
        steps: ["打开报警列表", "进入报警详情", "进入工单详情"],
      },
    ],
    assumptions: ["动态详情页使用 Next App Router 的 [param] 目录结构落盘。"],
    acceptanceChecks: [
      {
        id: "page-alarm-list",
        description: "必须实现报警列表页。",
        type: "page",
        target: "/alarms",
      },
      {
        id: "page-alarm-detail",
        description: "必须实现报警详情页。",
        type: "page",
        target: "/alarms/:source_Path",
      },
      {
        id: "page-workorder-list",
        description: "必须实现工单列表页。",
        type: "page",
        target: "/workorders",
      },
      {
        id: "page-workorder-detail",
        description: "必须实现工单详情页。",
        type: "page",
        target: "/workorders/:id",
      },
      {
        id: "api-workorder-list",
        description: "必须实现工单列表接口。",
        type: "api",
        target: "/app/api/workorders/route.ts",
      },
      {
        id: "flow-detail",
        description: "必须覆盖查看详情流程。",
        type: "flow",
        target: "查看详情",
      },
    ],
  };
}

function buildPlantRouteGroupPlanSpec(): PlanSpec {
  return {
    version: 1,
    appName: "Plant Tracker",
    summary: "Track plants and maintenance work.",
    resources: [
      {
        name: "Plant",
        pluralName: "Plants",
        routeSegment: "plants",
        description: "A plant record.",
        fields: [
          { name: "name", label: "Name", type: "string", required: true, source: "prd" },
          { name: "status", label: "Status", type: "string", required: true, source: "prd" },
        ],
        relations: [],
      },
    ],
    pages: [
      {
        name: "Plant list",
        route: "/plants",
        kind: "list",
        resourceName: "Plant",
        purpose: "List plants.",
      },
      {
        name: "Plant edit",
        route: "/plants/[id]/edit",
        kind: "edit",
        resourceName: "Plant",
        purpose: "Edit a plant.",
      },
    ],
    apis: [
      {
        name: "PlantCollection",
        resourceName: "Plant",
        path: "/app/api/plants/route.ts",
        methods: ["GET", "POST"],
        requestShape: "Plant query or create payload.",
        responseShape: "Plant list or created plant.",
      },
    ],
    flows: [
      {
        name: "Maintain plants",
        steps: ["Open plant list", "Open edit page", "Save plant changes"],
      },
    ],
    assumptions: ["Authentication is out of scope for this regression."],
    acceptanceChecks: [
      {
        id: "page-plant-list",
        description: "Plant list page exists.",
        type: "page",
        target: "/plants",
      },
      {
        id: "page-plant-edit",
        description: "Plant edit page exists.",
        type: "page",
        target: "/plants/[id]/edit",
      },
      {
        id: "api-plants",
        description: "Plant API exists.",
        type: "api",
        target: "/app/api/plants/route.ts",
      },
      {
        id: "flow-maintain-plants",
        description: "Plant maintenance flow exists.",
        type: "flow",
        target: "Maintain plants",
      },
    ],
  };
}

function uniqueApiPaths(planSpec: PlanSpec): string[] {
  return Array.from(new Set(planSpec.apis.map((api) => api.path)));
}

function buildEmptyInteractionContract(): InteractionContract {
  return {
    flows: [],
    internalOperations: [],
    externalOperations: [],
  };
}

function buildValidInteractionContract(planSpec: PlanSpec = buildPlanSpec()): InteractionContract {
  const firstPage = planSpec.pages[0]?.route ?? "/";
  const firstApi = planSpec.apis[0];
  return {
    flows: planSpec.flows.map((flow) => ({
      name: flow.name,
      critical: true,
      triggerControl: `Open ${firstPage}`,
      fallbackTrigger: "Use sidebar navigation.",
      loadingState: "Show a loading state.",
      emptyState: "Show an empty state.",
      errorState: "Show an error message.",
    })),
    internalOperations: firstApi
      ? [
          {
            name: `${firstApi.name} request`,
            pageRoute: firstPage,
            triggerControl: "Primary action",
            apiPath: firstApi.path,
            method: firstApi.methods[0] ?? "GET",
          },
        ]
      : [],
    externalOperations: [],
  };
}

async function writeEmptyInteractionContract(runtime: TextGeneratorRuntime): Promise<void> {
  let planSpec = buildPlanSpec();
  try {
    planSpec = JSON.parse(await readFile(runtime.deepagentsPlanSpecPath, "utf8")) as PlanSpec;
  } catch {
    planSpec = buildPlanSpec();
  }

  await writeFile(
    runtime.deepagentsInteractionContractPath,
    `${JSON.stringify(buildValidInteractionContract(planSpec), null, 2)}\n`,
    "utf8",
  );
}

function buildTestRuntime(overrides: Partial<TextGeneratorRuntime> = {}): TextGeneratorRuntime {
  return {
    sessionId: "test-session",
    outputDirectory: "/virtual-workspace",
    deepagentsDirectory: "/virtual-workspace/.workspace",
    deepagentsAgentsPath: "/virtual-workspace/.workspace/AGENTS.md",
    deepagentsLogPath: "/virtual-workspace/.workspace/trace.log",
    deepagentsErrorLogPath: "/virtual-workspace/.workspace/error.log",
    deepagentsMetricsLogPath: "/virtual-workspace/.workspace/metrics.jsonl",
    deepagentsRuntimeValidationLogPath: "/virtual-workspace/.workspace/runtime-validation.log",
    deepagentsRuntimeInteractionValidationPath: "/virtual-workspace/.workspace/runtime-interaction-validation.json",
    deepagentsTodoPath: "/virtual-workspace/.workspace/todo.md",
    deepagentsInteractionContractPath: "/virtual-workspace/.workspace/interaction-contract.json",
    deepagentsReferenceManifestPath: "/virtual-workspace/.workspace/references/reference-manifest.json",
    deepagentsConfigPath: "/virtual-workspace/.workspace/config.json",
    deepagentsPlanPromptSnapshotPath: "/virtual-workspace/.workspace/plan-system-prompt.md",
    deepagentsPlanRepairPromptSnapshotPath: "/virtual-workspace/.workspace/plan-repair-system-prompt.md",
    deepagentsGeneratePromptSnapshotPath: "/virtual-workspace/.workspace/generate-system-prompt.md",
    deepagentsGenerateRepairPromptSnapshotPath: "/virtual-workspace/.workspace/generate-repair-system-prompt.md",
    templateId: "full-stack",
    templateName: "Full Stack",
    templateVersion: "1.0.0",
    templateDirectory: "/virtual-workspace/.workspace/template",
    templatePlanPromptPath: "/virtual-workspace/.workspace/template/prompts/plan-system-prompt.md",
    templatePlanRepairPromptPath: "/virtual-workspace/.workspace/template/prompts/plan-repair-system-prompt.md",
    templateGeneratePromptPath: "/virtual-workspace/.workspace/template/prompts/generate-system-prompt.md",
    templateGenerateRepairPromptPath: "/virtual-workspace/.workspace/template/prompts/generate-repair-system-prompt.md",
    sourcePrdSnapshotPath: "/virtual-workspace/.workspace/source-prd.md",
    deepagentsAnalysisPath: "/virtual-workspace/.workspace/prd-analysis.md",
    deepagentsDetailedSpecPath: "/virtual-workspace/.workspace/generated-spec.md",
    deepagentsPlanSpecPath: "/virtual-workspace/.workspace/plan-spec.json",
    deepagentsPlanValidationPath: "/virtual-workspace/.workspace/plan-validation.json",
    deepagentsGenerationValidationPath: "/virtual-workspace/.workspace/generation-validation.json",
    planAttempt: 1,
    maxPlanRetries: 10,
    generateAttempt: 1,
    maxGenerateRetries: 10,
    generateSubagentParallelism: DEFAULT_GENERATE_SUBAGENT_PARALLELISM,
    retryReasons: [],
    templatePhases: {
      plan: { effort: "high" },
      planRepair: { effort: "high" },
      generate: { effort: "medium" },
      generateRepair: { effort: "high" },
    },
    templateRuntimeValidation: {
      copyEnvExample: true,
      steps: [],
    },
    templateInteractiveRuntimeValidation: {
      enabled: false,
      coverageThreshold: 0.8,
      idleTimeoutMs: 10_000,
      readyTimeoutMs: 90_000,
    },
    templateEnvironmentPolicy: {
      lockedKeys: [],
    },
    templateProjectConfigPolicy: {
      guardedFiles: [],
    },
    modelRoles: resolveModelRoleConfigs({
      APP_BUILDER_API_KEY: "test-key",
    }),
    ...overrides,
  };
}

function buildTestRuntimeForOutput(outputDirectory: string, overrides: Partial<TextGeneratorRuntime> = {}): TextGeneratorRuntime {
  const artifacts = createWorkspaceArtifactPaths(outputDirectory);
  return buildTestRuntime({
    outputDirectory,
    deepagentsDirectory: artifacts.workspaceDirectory,
    deepagentsAgentsPath: artifacts.agentsPath,
    deepagentsLogPath: artifacts.logPath,
    deepagentsErrorLogPath: artifacts.errorLogPath,
    deepagentsMetricsLogPath: artifacts.metricsLogPath,
    deepagentsRuntimeValidationLogPath: artifacts.runtimeValidationLogPath,
    deepagentsRuntimeInteractionValidationPath: artifacts.runtimeInteractionValidationPath,
    deepagentsTodoPath: artifacts.todoPath,
    deepagentsInteractionContractPath: artifacts.interactionContractPath,
    deepagentsReferenceManifestPath: artifacts.referenceManifestPath,
    deepagentsConfigPath: artifacts.configPath,
    deepagentsPlanPromptSnapshotPath: artifacts.planPromptSnapshotPath,
    deepagentsPlanRepairPromptSnapshotPath: artifacts.planRepairPromptSnapshotPath,
    deepagentsGeneratePromptSnapshotPath: artifacts.generatePromptSnapshotPath,
    deepagentsGenerateRepairPromptSnapshotPath: artifacts.generateRepairPromptSnapshotPath,
    templateDirectory: artifacts.templateDirectory,
    templatePlanPromptPath: path.join(artifacts.templateDirectory, "prompts", "plan-system-prompt.md"),
    templatePlanRepairPromptPath: path.join(artifacts.templateDirectory, "prompts", "plan-repair-system-prompt.md"),
    templateGeneratePromptPath: path.join(artifacts.templateDirectory, "prompts", "generate-system-prompt.md"),
    templateGenerateRepairPromptPath: path.join(artifacts.templateDirectory, "prompts", "generate-repair-system-prompt.md"),
    sourcePrdSnapshotPath: artifacts.sourcePrdSnapshotPath,
    deepagentsAnalysisPath: artifacts.analysisPath,
    deepagentsDetailedSpecPath: artifacts.detailedSpecPath,
    deepagentsPlanSpecPath: artifacts.planSpecPath,
    deepagentsPlanValidationPath: artifacts.planValidationPath,
    deepagentsGenerationValidationPath: artifacts.generationValidationPath,
    ...overrides,
  });
}

function createFakePiSession(
  events: readonly unknown[],
): {
  session: Parameters<typeof runPiAgentWithLogs>[0]["session"];
  emit: (event: unknown) => void;
  isSubscribed: () => boolean;
  unsubscribeCount: () => number;
} {
  let subscribed = false;
  let unsubscribeCount = 0;
  let handler: ((event: unknown) => void) | undefined;
  const emit = (event: unknown) => {
    if (subscribed) {
      handler?.(event);
    }
  };

  return {
    session: {
      subscribe(callback: (event: never) => void) {
        subscribed = true;
        handler = callback as (event: unknown) => void;
        return () => {
          subscribed = false;
          unsubscribeCount += 1;
        };
      },
      async prompt() {
        for (const event of events) {
          emit(event);
        }
      },
    } as unknown as Parameters<typeof runPiAgentWithLogs>[0]["session"],
    emit,
    isSubscribed: () => subscribed,
    unsubscribeCount: () => unsubscribeCount,
  };
}

async function collectFilesWithExtensions(root: string, extensions: ReadonlySet<string>): Promise<string[]> {
  const absoluteRoot = path.resolve(root);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.isFile() && extensions.has(path.extname(entry.name))) {
        files.push(path.relative(process.cwd(), absolutePath).split(path.sep).join("/"));
      }
    }
  }

  await visit(absoluteRoot);
  return files.sort();
}

async function requestLocalUrl(url: string, method = "GET"): Promise<number> {
  const response = await requestLocalResponse(url, method);
  return response.status;
}

async function requestLocalResponse(
  url: string,
  method = "GET",
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const parsed = new URL(url);
    const requestHeaders: Record<string, string | number> = { ...headers };
    if (body) {
      requestHeaders["content-type"] = requestHeaders["content-type"] ?? "application/json";
      requestHeaders["content-length"] = Buffer.byteLength(body);
    }

    const req = httpRequest(
      {
        host: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        timeout: 2_000,
        headers: requestHeaders,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Timed out requesting ${method} ${url}`));
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function extractValidationToken(html: string): string {
  const match = html.match(/const validationToken = "([^"]+)";/);
  assert.ok(match, "validation page should include a validation token");
  return match[1] ?? "";
}

type FakeSmokeBrowserBehavior = {
  consoleErrors?: Record<string, string[]>;
  pageErrors?: Record<string, string[]>;
  extraResponses?: Record<string, Array<{ url: string; status: number }>>;
};

class FakeSmokeResponse implements SmokeResponse {
  constructor(
    private readonly responseUrl: string,
    private readonly statusCode: number,
  ) {}

  status(): number {
    return this.statusCode;
  }

  url(): string {
    return this.responseUrl;
  }
}

class FakeSmokeConsoleMessage implements SmokeConsoleMessage {
  constructor(private readonly message: string) {}

  type(): string {
    return "error";
  }

  text(): string {
    return this.message;
  }
}

class FakeSmokePage implements SmokePage {
  private readonly consoleListeners: Array<(message: SmokeConsoleMessage) => void> = [];
  private readonly pageErrorListeners: Array<(error: Error) => void> = [];
  private readonly responseListeners: Array<(response: SmokeResponse) => void> = [];
  private bodyText = "";

  constructor(
    private readonly behavior: FakeSmokeBrowserBehavior,
    private readonly visitedPaths: string[],
  ) {}

  on(event: "console" | "pageerror" | "response", listener: ((message: SmokeConsoleMessage) => void) | ((error: Error) => void) | ((response: SmokeResponse) => void)): unknown {
    if (event === "console") {
      this.consoleListeners.push(listener as (message: SmokeConsoleMessage) => void);
    } else if (event === "pageerror") {
      this.pageErrorListeners.push(listener as (error: Error) => void);
    } else {
      this.responseListeners.push(listener as (response: SmokeResponse) => void);
    }
    return this;
  }

  async goto(url: string): Promise<SmokeResponse> {
    const pathname = new URL(url).pathname;
    this.visitedPaths.push(pathname);
    const response = await requestLocalResponse(url);
    this.bodyText = response.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const smokeResponse = new FakeSmokeResponse(url, response.status);
    for (const listener of this.responseListeners) {
      listener(smokeResponse);
    }
    for (const extraResponse of this.behavior.extraResponses?.[pathname] ?? []) {
      for (const listener of this.responseListeners) {
        listener(new FakeSmokeResponse(extraResponse.url, extraResponse.status));
      }
    }
    for (const message of this.behavior.consoleErrors?.[pathname] ?? []) {
      for (const listener of this.consoleListeners) {
        listener(new FakeSmokeConsoleMessage(message));
      }
    }
    for (const message of this.behavior.pageErrors?.[pathname] ?? []) {
      for (const listener of this.pageErrorListeners) {
        listener(new Error(message));
      }
    }
    return smokeResponse;
  }

  async evaluate<T>(): Promise<T> {
    return this.bodyText.length as T;
  }

  async close(): Promise<void> {}
}

function createFakeSmokeBrowserLauncher(behavior: FakeSmokeBrowserBehavior = {}): {
  launcher: SmokeBrowserLauncher;
  visitedPaths: string[];
} {
  const visitedPaths: string[] = [];
  return {
    visitedPaths,
    launcher: {
      async launch() {
        return {
          async newPage() {
            return new FakeSmokePage(behavior, visitedPaths);
          },
          async close() {},
        };
      },
    },
  };
}

async function requestWebSocketUpgradeStatusLine(url: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const parsed = new URL(url);
    const socket = connectNet(Number(parsed.port), parsed.hostname);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out requesting websocket upgrade ${url}`));
    }, 2_000);

    socket.once("connect", () => {
      socket.write(
        [
          `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
          `Host: ${parsed.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
    });

    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (response.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        socket.destroy();
        resolve(response.split("\r\n", 1)[0] ?? "");
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("end", () => {
      if (!response.includes("\r\n\r\n")) {
        clearTimeout(timeout);
        reject(new Error(`Websocket upgrade response ended early for ${url}`));
      }
    });
  });
}

async function canListenOnLocalhost(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isPidRunning(pid);
}

function stopTestProcess(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined || !isPidRunning(child.pid)) {
    return;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Best-effort cleanup for tests that intentionally launch stale processes.
  }
}

async function writeMinimalTemplatePack(options: {
  root: string;
  id: string;
  interactiveEnabled?: boolean;
  includeDevServerStep?: boolean;
  idleTimeoutMs?: number;
  readyTimeoutMs?: number;
  coverageThreshold?: number;
  serverCommand?: string;
  serverArgs?: string[];
  generateRepairRetries?: number;
  planRepairRetries?: number;
}): Promise<void> {
  const templateDirectory = path.join(options.root, "templates", options.id);
  const promptsDirectory = path.join(templateDirectory, "prompts");
  await mkdir(promptsDirectory, { recursive: true });

  for (const promptName of [
    "plan-system-prompt.md",
    "plan-repair-system-prompt.md",
    "generate-system-prompt.md",
    "generate-repair-system-prompt.md",
  ]) {
    await writeFile(path.join(promptsDirectory, promptName), `# ${promptName}\n`, "utf8");
  }

  const runtimeSteps = [
    {
      name: "pnpm typecheck",
      command: "pnpm",
      args: ["typecheck"],
    },
    ...(options.includeDevServerStep === false
      ? []
      : [
          {
            name: "node dev server",
            command: options.serverCommand ?? process.execPath,
            args: options.serverArgs ?? ["server.mjs"],
            kind: "dev-server",
          },
        ]),
  ];

  await writeFile(
    path.join(templateDirectory, "template.json"),
    `${JSON.stringify({
      id: options.id,
      name: "Interactive Test Template",
      version: "1.0.0",
      projectRenderer: "interactive-test",
      repairRetries: {
        plan: options.planRepairRetries ?? 10,
        generate: options.generateRepairRetries ?? 10,
      },
      phases: {
        plan: { prompt: "prompts/plan-system-prompt.md", effort: "high" },
        planRepair: { prompt: "prompts/plan-repair-system-prompt.md", effort: "high" },
        generate: { prompt: "prompts/generate-system-prompt.md", effort: "medium" },
        generateRepair: { prompt: "prompts/generate-repair-system-prompt.md", effort: "high" },
      },
      runtimeValidation: {
        copyEnvExample: true,
        steps: runtimeSteps,
      },
      interactiveRuntimeValidation: {
        enabled: options.interactiveEnabled === true,
        ...(options.coverageThreshold !== undefined ? { coverageThreshold: options.coverageThreshold } : {}),
        ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
        ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

test("runDeepAgentWithLogs retries stream for compatible stream output errors", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-stream-retry-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const runtime = buildTestRuntime({
    outputDirectory: tempRoot,
    deepagentsDirectory,
    deepagentsAgentsPath: path.join(deepagentsDirectory, "AGENTS.md"),
    deepagentsLogPath: path.join(deepagentsDirectory, "trace.log"),
    deepagentsErrorLogPath: path.join(deepagentsDirectory, "error.log"),
    deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
    deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
    deepagentsInteractionContractPath: path.join(deepagentsDirectory, "interaction-contract.json"),
    deepagentsReferenceManifestPath: path.join(deepagentsDirectory, "references", "reference-manifest.json"),
    deepagentsConfigPath: path.join(deepagentsDirectory, "config.json"),
    deepagentsPlanPromptSnapshotPath: path.join(deepagentsDirectory, "plan-system-prompt.md"),
    deepagentsPlanRepairPromptSnapshotPath: path.join(deepagentsDirectory, "plan-repair-system-prompt.md"),
    deepagentsGeneratePromptSnapshotPath: path.join(deepagentsDirectory, "generate-system-prompt.md"),
    deepagentsGenerateRepairPromptSnapshotPath: path.join(deepagentsDirectory, "generate-repair-system-prompt.md"),
    templateDirectory: path.join(deepagentsDirectory, "template"),
    templatePlanPromptPath: path.join(deepagentsDirectory, "template", "prompts", "plan-system-prompt.md"),
    templatePlanRepairPromptPath: path.join(deepagentsDirectory, "template", "prompts", "plan-repair-system-prompt.md"),
    templateGeneratePromptPath: path.join(deepagentsDirectory, "template", "prompts", "generate-system-prompt.md"),
    templateGenerateRepairPromptPath: path.join(deepagentsDirectory, "template", "prompts", "generate-repair-system-prompt.md"),
    sourcePrdSnapshotPath: path.join(deepagentsDirectory, "source-prd.md"),
    deepagentsAnalysisPath: path.join(deepagentsDirectory, "prd-analysis.md"),
    deepagentsDetailedSpecPath: path.join(deepagentsDirectory, "generated-spec.md"),
    deepagentsPlanSpecPath: path.join(deepagentsDirectory, "plan-spec.json"),
    deepagentsPlanValidationPath: path.join(deepagentsDirectory, "plan-validation.json"),
    deepagentsGenerationValidationPath: path.join(deepagentsDirectory, "generation-validation.json"),
  });

  await mkdir(deepagentsDirectory, { recursive: true });

  const state = {
    messages: [
      {
        role: "user",
        content: "{\"task\":\"plan\"}",
      },
    ],
  };
  const result = {
    structuredResponse: {
      summary: "retry ok",
    },
  };
  let streamCalls = 0;

  const agent = {
    async stream() {
      streamCalls += 1;

      return {
        async *[Symbol.asyncIterator]() {
          if (streamCalls === 1) {
            throw Object.assign(new Error("output new_sensitive (1027)"), {
              name: "APIError",
            });
          }

          yield ["messages", "retry success"];
          yield ["values", result];
        },
      };
    },
  };

  try {
    const resolved = await runDeepAgentWithLogs(agent, state, runtime, "plan", "deepagents planning");

    assert.equal(streamCalls, 2);
    assert.equal(resolved, result);

    const traceLog = await readFile(runtime.deepagentsLogPath, "utf8");
    assert.match(traceLog, /stream-retry/);
    assert.doesNotMatch(traceLog, /invoke-fallback/);
  } finally {
    await closeWorkflowBoard();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runDeepAgentWithLogs retries stream for transient socket resets", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-stream-reset-retry-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const runtime = buildTestRuntime({
    outputDirectory: tempRoot,
    deepagentsDirectory,
    deepagentsAgentsPath: path.join(deepagentsDirectory, "AGENTS.md"),
    deepagentsLogPath: path.join(deepagentsDirectory, "trace.log"),
    deepagentsErrorLogPath: path.join(deepagentsDirectory, "error.log"),
    deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
    deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
    deepagentsInteractionContractPath: path.join(deepagentsDirectory, "interaction-contract.json"),
    deepagentsReferenceManifestPath: path.join(deepagentsDirectory, "references", "reference-manifest.json"),
    deepagentsConfigPath: path.join(deepagentsDirectory, "config.json"),
    deepagentsPlanPromptSnapshotPath: path.join(deepagentsDirectory, "plan-system-prompt.md"),
    deepagentsPlanRepairPromptSnapshotPath: path.join(deepagentsDirectory, "plan-repair-system-prompt.md"),
    deepagentsGeneratePromptSnapshotPath: path.join(deepagentsDirectory, "generate-system-prompt.md"),
    deepagentsGenerateRepairPromptSnapshotPath: path.join(deepagentsDirectory, "generate-repair-system-prompt.md"),
    templateDirectory: path.join(deepagentsDirectory, "template"),
    templatePlanPromptPath: path.join(deepagentsDirectory, "template", "prompts", "plan-system-prompt.md"),
    templatePlanRepairPromptPath: path.join(deepagentsDirectory, "template", "prompts", "plan-repair-system-prompt.md"),
    templateGeneratePromptPath: path.join(deepagentsDirectory, "template", "prompts", "generate-system-prompt.md"),
    templateGenerateRepairPromptPath: path.join(deepagentsDirectory, "template", "prompts", "generate-repair-system-prompt.md"),
    sourcePrdSnapshotPath: path.join(deepagentsDirectory, "source-prd.md"),
    deepagentsAnalysisPath: path.join(deepagentsDirectory, "prd-analysis.md"),
    deepagentsDetailedSpecPath: path.join(deepagentsDirectory, "generated-spec.md"),
    deepagentsPlanSpecPath: path.join(deepagentsDirectory, "plan-spec.json"),
    deepagentsPlanValidationPath: path.join(deepagentsDirectory, "plan-validation.json"),
    deepagentsGenerationValidationPath: path.join(deepagentsDirectory, "generation-validation.json"),
  });

  await mkdir(deepagentsDirectory, { recursive: true });

  const result = {
    structuredResponse: {
      summary: "socket retry ok",
    },
  };
  let streamCalls = 0;

  const agent = {
    async stream() {
      streamCalls += 1;

      return {
        async *[Symbol.asyncIterator]() {
          if (streamCalls === 1) {
            const socketError = Object.assign(
              new Error(
                "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
              ),
              {
                code: "ECONNRESET",
                path: "https://api.deepseek.com/chat/completions",
              },
            );
            throw Object.assign(new Error("MiddlewareError: upstream stream failed"), {
              cause: socketError,
            });
          }

          yield ["messages", "retry success"];
          yield ["values", result];
        },
      };
    },
  };

  try {
    const resolved = await runDeepAgentWithLogs(agent, { messages: [] }, runtime, "generate", "deepagents generation");

    assert.equal(streamCalls, 2);
    assert.equal(resolved, result);

    const traceLog = await readFile(runtime.deepagentsLogPath, "utf8");
    assert.match(traceLog, /stream-retry/);
    assert.match(traceLog, /socket connection closed unexpectedly|ECONNRESET/);
  } finally {
    await closeWorkflowBoard();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runDeepAgentWithLogs records model-planned todo timing metrics", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-todo-metrics-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const runtime = buildTestRuntime({
    outputDirectory: tempRoot,
    deepagentsDirectory,
    deepagentsLogPath: path.join(deepagentsDirectory, "trace.log"),
    deepagentsMetricsLogPath: path.join(deepagentsDirectory, "metrics.jsonl"),
  });

  await mkdir(deepagentsDirectory, { recursive: true });

  const result = {
    structuredResponse: {
      summary: "todo metrics ok",
    },
  };
  const agent = {
    async stream() {
      return {
        async *[Symbol.asyncIterator]() {
          yield [
            "tools",
            {
              event: "on_tool_end",
              name: "write_todos",
              output: {
                todos: [
                  { content: "分析需求", status: "in_progress" },
                  { content: "生成计划", status: "pending" },
                ],
              },
            },
          ];
          yield [
            "tools",
            {
              event: "on_tool_end",
              name: "write_todos",
              output: {
                todos: [
                  { content: "分析需求", status: "completed" },
                  { content: "生成计划", status: "in_progress" },
                ],
              },
            },
          ];
          yield ["values", result];
        },
      };
    },
  };

  try {
    const resolved = await runDeepAgentWithLogs(agent, { messages: [] }, runtime, "plan", "deepagents planning");

    assert.equal(resolved, result);

    const metricsLog = await readFile(runtime.deepagentsMetricsLogPath, "utf8");
    const metricRecords = metricsLog.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      name: string;
      phase: string;
      sessionId: string;
      status: string;
      attempt?: number;
      durationMs: number;
      metadata?: Record<string, unknown>;
    }>;

    const starts = metricRecords.filter((record) => record.name === "model_todo.start");
    const completed = metricRecords.find((record) => record.name === "model_todo.completed");
    const incomplete = metricRecords.find((record) => record.name === "model_todo.incomplete");

    assert.equal(starts.length, 2);
    assert.equal(completed?.metadata?.content, "分析需求");
    assert.equal(completed?.metadata?.durationBasis, "started");
    assert.equal(incomplete?.metadata?.content, "生成计划");
    assert.equal(incomplete?.metadata?.durationBasis, "open_at_stream_end");
    assert.ok(metricRecords.every((record) => (
      record.sessionId === runtime.sessionId &&
      record.phase === "plan" &&
      record.status === "success" &&
      record.attempt === 1 &&
      record.durationMs >= 0
    )));
  } finally {
    await closeWorkflowBoard();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runPiAgentWithLogs finalizes assistant-text structured responses and ignores late events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-pi-agent-finalize-"));
  const runtime = buildTestRuntimeForOutput(tempRoot);
  const schema = z.object({ summary: z.string() });
  const structuredFromText = { summary: "pi text fallback ok" };
  let lateEventAttempted = false;
  let lateEventDelivered = false;
  const { session, emit, isSubscribed, unsubscribeCount } = createFakePiSession([
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "Reading workspace context.",
      },
    },
    {
      type: "tool_execution_start",
      toolCallId: "tool-read",
      toolName: "read",
      args: { path: "/.workspace/source-prd.md" },
    },
    {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({ response: structuredFromText }) }],
        },
      ],
    },
  ]);

  try {
    await mkdir(runtime.deepagentsDirectory, { recursive: true });
    const result = await runPiAgentWithLogs({
      session,
      structuredResponse: {},
      prompt: buildPiStructuredPrompt({ stage: "plan" }, schema),
      responseSchema: schema,
      runtime,
      runtimePhase: "plan",
      timeoutLabel: "pi agent test",
    }) as { structuredResponse?: unknown };

    lateEventAttempted = true;
    if (isSubscribed()) {
      lateEventDelivered = true;
    }
    emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: "late event should not be logged",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(result.structuredResponse, structuredFromText);
    assert.equal(unsubscribeCount(), 1);
    assert.equal(lateEventAttempted, true);
    assert.equal(lateEventDelivered, false);

    const traceLog = await readFile(runtime.deepagentsLogPath, "utf8");
    assert.match(traceLog, /Pi Agent 生成流程结束/);
    assert.match(traceLog, /读取文件：\/?\.workspace\/source-prd\.md/);
    assert.doesNotMatch(traceLog, /late event should not be logged/);
  } finally {
    await closeWorkflowBoard();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runPiAgentWithLogs fails closed when Pi does not return schema-valid structured data", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-pi-agent-schema-failure-"));
  const runtime = buildTestRuntimeForOutput(tempRoot);
  const schema = z.object({ summary: z.string() });
  const { session, unsubscribeCount } = createFakePiSession([
    {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({ response: { summary: 123 } }) }],
        },
      ],
    },
  ]);

  try {
    await mkdir(runtime.deepagentsDirectory, { recursive: true });
    await assert.rejects(
      () => runPiAgentWithLogs({
        session,
        structuredResponse: {},
        prompt: buildPiStructuredPrompt({ stage: "generate" }, schema),
        responseSchema: schema,
        runtime,
        runtimePhase: "generate",
        timeoutLabel: "pi agent schema failure",
      }),
      /pi agent schema failure did not return a valid structured response/,
    );
    assert.equal(unsubscribeCount(), 1);
  } finally {
    await closeWorkflowBoard();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("normalizePiTaskToolCallArgs accepts DeepAgents and official subagent forms", () => {
  assert.deepEqual(
    normalizePiTaskToolCallArgs({
      subagent_type: "frontend-implementer",
      description: "实现订单列表页面",
    }),
    {
      mode: "single",
      agent: "frontend-implementer",
      task: "实现订单列表页面",
    },
  );

  assert.deepEqual(
    normalizePiTaskToolCallArgs({
      tasks: [
        { agent: "backend-implementer", task: "实现订单 API" },
        { subagentType: "integration-verifier", description: "检查文件覆盖" },
      ],
    }),
    {
      mode: "parallel",
      tasks: [
        { agent: "backend-implementer", task: "实现订单 API" },
        { agent: "integration-verifier", task: "检查文件覆盖" },
      ],
    },
  );

  assert.equal(
    normalizePiTaskToolCallArgs({
      subagent_type: "frontend-implementer",
      description: "单任务",
      tasks: [{ agent: "backend-implementer", task: "并行任务" }],
    }),
    null,
  );
});

test("PiTextGenerator exposes host-level parallel initial generation", () => {
  const generator = new PiTextGenerator(resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "test-key",
  }));

  assert.equal(typeof generator.generateProjectWithParallelAgents, "function");
});

test("buildPiParallelGenerationTaskItems creates default backend frontend and verifier slices", () => {
  const runtime = buildTestRuntimeForOutput("/virtual-output", {
    designPath: "/virtual-output/DESIGN.md",
  });
  const tasks = buildPiParallelGenerationTaskItems(buildPlanSpec(), runtime);

  assert.equal(tasks.length, 9);
  assert.deepEqual(
    tasks.reduce<Record<string, number>>((counts, task) => {
      counts[task.agent] = (counts[task.agent] ?? 0) + 1;
      return counts;
    }, {}),
    {
      "backend-implementer": 3,
      "frontend-implementer": 3,
      "integration-verifier": 3,
    },
  );
  assert.deepEqual(tasks.map((task) => task.instanceIndex), [1, 2, 3, 1, 2, 3, 1, 2, 3]);
  assert.ok(tasks.every((task) => task.instanceCount === 3));
  assert.match(tasks[0]?.task ?? "", /app\/api\/work-orders\/route\.ts/);
  assert.match(tasks[1]?.task ?? "", /backend-implementer instance 2\/3/);
  assert.match(tasks[3]?.task ?? "", /\/work-orders/);
  assert.match(tasks[4]?.task ?? "", /Do not edit shared shell\/style\/navigation files/);
  assert.match(tasks[6]?.task ?? "", /Inspect integration coverage/);
  assert.match(tasks[6]?.task ?? "", /Do not run shell validation commands/);
});

test("buildPiParallelGenerationTaskItems allows explicit per-role parallelism", () => {
  const runtime = buildTestRuntimeForOutput("/virtual-output");
  const tasks = buildPiParallelGenerationTaskItems(buildPlanSpec(), runtime, { parallelism: 2 });

  assert.equal(tasks.length, 6);
  assert.deepEqual(tasks.map((task) => task.shardLabel), [
    "backend-implementer#1",
    "backend-implementer#2",
    "frontend-implementer#1",
    "frontend-implementer#2",
    "integration-verifier#1",
    "integration-verifier#2",
  ]);
  assert.equal(resolveGenerateSubagentParallelism(""), 3);
  assert.equal(resolveGenerateSubagentParallelism("2"), 2);
  assert.throws(() => resolveGenerateSubagentParallelism("0"), /APP_BUILDER_GENERATE_SUBAGENT_PARALLELISM/);
});

test("buildPiHostParallelGenerationBoardState switches visible phase before subagents start", () => {
  const runtime = buildTestRuntimeForOutput("/virtual-output", {
    designPath: "/virtual-output/DESIGN.md",
  });
  const tasks = buildPiParallelGenerationTaskItems(buildPlanSpec(), runtime);
  const modelConfig = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "test-key",
    APP_BUILDER_MODEL: "test-generate-model",
    APP_BUILDER_USER_AGENT: "test-agent",
  }).generate;
  const state = buildPiHostParallelGenerationBoardState({ runtime, modelConfig, tasks });

  assert.equal(state.stage, "生成阶段");
  assert.equal(state.runtimeStatus?.phase, "generate");
  assert.equal(state.runtimeStatus?.subagentCount, 9);
  assert.match(state.narrative, /计划阶段已通过门禁/);
  assert.match(state.narrative, /每类 3 个实例/);
  assert.deepEqual(state.todos.map((todo) => todo.status), ["completed", "in_progress", "pending", "pending"]);
  assert.deepEqual(
    state.agentStatuses?.map((agent) => ({
      name: agent.name,
      status: agent.status,
      activeInstanceCount: agent.activeInstanceCount,
      userAgent: agent.userAgent,
    })),
    [
      { name: "leader", status: "working", activeInstanceCount: undefined, userAgent: "test-agent" },
      { name: "backend-implementer", status: "working", activeInstanceCount: 3, userAgent: undefined },
      { name: "frontend-implementer", status: "working", activeInstanceCount: 3, userAgent: undefined },
      { name: "integration-verifier", status: "working", activeInstanceCount: 3, userAgent: undefined },
    ],
  );
});

test("Pi task compatibility tool delegates DeepAgents-style task calls and blocks non-generation phases", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-pi-task-tool-"));
  const runtime = buildTestRuntimeForOutput(tempRoot);
  const calls: Array<{ requestedAgent: string; subagent: string; task: string; phase: string }> = [];
  const updates: unknown[] = [];

  try {
    const tool = createPiTaskCompatibilityTool({
      runtime,
      runtimePhase: "generateRepair",
      subagents: buildGenerationSubagents("generateRepair", false),
      runTask: async (request) => {
        calls.push({
          requestedAgent: request.requestedAgent,
          subagent: request.subagent.name,
          task: request.task,
          phase: request.runtimePhase,
        });
        request.onUpdate?.({
          content: [{ type: "text", text: "partial child update" }],
          details: request.makeDetails([
            {
              agent: request.subagent.name,
              requestedAgent: request.requestedAgent,
              task: request.task,
              status: "running",
              output: "partial child update",
            },
          ]),
        });
        return {
          agent: request.subagent.name,
          requestedAgent: request.requestedAgent,
          task: request.task,
          status: "completed",
          output: "child completed",
        };
      },
    });

    const result = await tool.execute(
      "task-1",
      { subagent_type: "frontend-fixer", description: "修复订单页面渲染" } as never,
      undefined,
      (partial) => updates.push(partial),
      {} as never,
    );

    assert.deepEqual(calls, [
      {
        requestedAgent: "frontend-fixer",
        subagent: "frontend-implementer",
        task: "修复订单页面渲染",
        phase: "generateRepair",
      },
    ]);
    assert.equal((result as unknown as Record<string, unknown>).isError, false);
    assert.match(String(result.content[0]?.type === "text" ? result.content[0].text : ""), /child completed/);
    assert.equal(updates.length, 1);

    let blockedRunnerCalled = false;
    const planTool = createPiTaskCompatibilityTool({
      runtime,
      runtimePhase: "plan",
      subagents: buildGenerationSubagents("generate", false),
      runTask: async (request) => {
        blockedRunnerCalled = true;
        return {
          agent: request.subagent.name,
          task: request.task,
          status: "completed",
          output: "should not run",
        };
      },
    });
    const blocked = await planTool.execute(
      "task-2",
      { subagent_type: "frontend-implementer", description: "不应在计划阶段执行" } as never,
      undefined,
      undefined,
      {} as never,
    );

    assert.equal((blocked as unknown as Record<string, unknown>).isError, true);
    assert.equal(blockedRunnerCalled, false);
    assert.match(String(blocked.content[0]?.type === "text" ? blocked.content[0].text : ""), /only enabled/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Pi path adapter keeps tool paths inside the generated workspace", () => {
  const outputDirectory = path.resolve("tmp", "pi-path-output");

  assert.equal(
    mapPiToolPathToWorkspaceRelative(path.join(outputDirectory, "app", "page.tsx"), outputDirectory),
    "app/page.tsx",
  );
  assert.equal(mapPiToolPathToWorkspaceRelative("/app/page.tsx", outputDirectory), "app/page.tsx");
  assert.equal(mapPiToolPathToWorkspaceRelative("/.workspace/plan-spec.json", outputDirectory), ".workspace/plan-spec.json");
  assert.equal(mapPiToolPathToWorkspaceRelative("/TODO.md", outputDirectory), ".workspace/todo.md");
  assert.equal(mapPiToolPathToWorkspaceRelative("/todo.md", outputDirectory), ".workspace/todo.md");
  assert.equal(mapPiToolPathToWorkspaceRelative("/.workspace/TODO.md", outputDirectory), ".workspace/todo.md");
  assert.equal(
    mapPiToolPathToWorkspaceRelative(path.join(outputDirectory, "TODO.md"), outputDirectory),
    ".workspace/todo.md",
  );

  const relativeInput: Record<string, unknown> = { path: "./app/page.tsx" };
  assert.deepEqual(rewritePiToolPathInput(relativeInput, outputDirectory), {});
  assert.equal(relativeInput.path, "app/page.tsx");

  const normalizedInput: Record<string, unknown> = { path: "app/../app/page.tsx" };
  assert.deepEqual(rewritePiToolPathInput(normalizedInput, outputDirectory), {});
  assert.equal(normalizedInput.path, "app/page.tsx");

  const parentEscape: Record<string, unknown> = { path: "../outside.txt" };
  assert.match(rewritePiToolPathInput(parentEscape, outputDirectory).blockedReason ?? "", /escapes/);
  assert.equal(parentEscape.path, "../outside.txt");

  const embeddedParentEscape: Record<string, unknown> = { path: "app/../../outside.txt" };
  assert.match(rewritePiToolPathInput(embeddedParentEscape, outputDirectory).blockedReason ?? "", /escapes/);
  assert.equal(embeddedParentEscape.path, "app/../../outside.txt");

  const windowsEscape: Record<string, unknown> = { path: "..\\outside.txt" };
  assert.match(rewritePiToolPathInput(windowsEscape, outputDirectory).blockedReason ?? "", /escapes/);
  assert.equal(windowsEscape.path, "..\\outside.txt");
});

test("interaction contract semantic validation requires plan flow coverage", () => {
  const issues = validateInteractionContractForPlanSpec(buildEmptyInteractionContract(), buildPlanSpec());

  assert.ok(issues.length > 0);
  assert.match(issues.join("\n"), /flows 不能为空/);
  assert.match(issues.join("\n"), /工单跟踪/);
  assert.deepEqual(validateInteractionContractForPlanSpec(buildValidInteractionContract(), buildPlanSpec()), []);
});

test("resolveSpawnCommand finds Windows command shims through PATHEXT", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows-only command shim resolution");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-spawn-resolve-"));

  try {
    const shimPath = path.join(tempRoot, "pnpm.cmd");
    await writeFile(shimPath, "@echo off\r\necho pnpm shim\r\n", "utf8");

    const resolved = await resolveSpawnCommand("pnpm", {
      PATH: tempRoot,
      PATHEXT: ".CMD;.EXE",
    });

    assert.equal(resolved.toLowerCase(), shimPath.toLowerCase());
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("filterRedundantValidationDetailLines removes validation detail already present in reasons", () => {
  const reasons = [
    "生成阶段运行验证失败：pnpm typecheck 未通过。退出码 2。摘要：app/(admin)/page.tsx(24,5): error TS2687。详见 .workspace/runtime-validation.log。",
  ];

  assert.deepEqual(
    filterRedundantValidationDetailLines(
      "退出码 2。摘要：app/(admin)/page.tsx(24,5): error TS2687。\n补充上下文：Dashboard 类型冲突。",
      reasons,
    ),
    ["补充上下文：Dashboard 类型冲突。"],
  );
});

test("pageFilePathToRoutePattern maps App Router page files to public route patterns", () => {
  assert.equal(pageFilePathToRoutePattern("app/(main)/plants/page.tsx"), "/plants");
  assert.equal(pageFilePathToRoutePattern("app/(main)/plants/[id]/edit/page.tsx"), "/plants/[id]/edit");
  assert.equal(pageFilePathToRoutePattern("app/admin/plants/page.tsx"), "/admin/plants");
  assert.equal(pageFilePathToRoutePattern("app/workorders/[id]/page.tsx"), "/workorders/[id]");
  assert.equal(pageFilePathToRoutePattern("app/files/[...path]/page.tsx"), "/files/[...path]");
  assert.equal(pageFilePathToRoutePattern("app/page.tsx"), "/");
  assert.equal(pageFilePathToRoutePattern("pages/plants/page.tsx"), null);
  assert.equal(routeToAdminPagePath("/alarms/:source_Path"), "app/(admin)/alarms/[source_Path]/page.tsx");
});

test("collectPageRoutePatterns follows Next route group URL semantics", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-route-groups-"));

  try {
    const outputDirectory = path.join(tempRoot, "output");
    const pagePaths = [
      "app/(main)/plants/page.tsx",
      "app/(main)/plants/[id]/edit/page.tsx",
      "app/admin/plants/page.tsx",
    ];

    for (const pagePath of pagePaths) {
      const absolutePath = path.join(outputDirectory, pagePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, "export default function Page() { return null; }\n", "utf8");
    }

    const routes = await collectPageRoutePatterns(outputDirectory);

    assert.equal(routes.has("/plants"), true);
    assert.equal(routes.has("/plants/[id]/edit"), true);
    assert.equal(routes.has("/admin/plants"), true);
    assert.equal(
      pageFilePathToRoutePattern("app/admin/plants/page.tsx") === "/plants",
      false,
      "plain admin path keeps admin as a public URL segment",
    );

    const adminOnlyDirectory = path.join(tempRoot, "admin-only");
    const adminOnlyPage = path.join(adminOnlyDirectory, "app/admin/plants/page.tsx");
    await mkdir(path.dirname(adminOnlyPage), { recursive: true });
    await writeFile(adminOnlyPage, "export default function Page() { return null; }\n", "utf8");

    const adminOnlyRoutes = await collectPageRoutePatterns(adminOnlyDirectory);
    assert.equal(adminOnlyRoutes.has("/plants"), false);
    assert.equal(adminOnlyRoutes.has("/admin/plants"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime target matching supports page and API dynamic routes", () => {
  const planSpec = buildPlanSpec();
  planSpec.apis.push({
    name: "WorkOrderItem",
    resourceName: "WorkOrder",
    path: "/app/api/work-orders/[id]/route.ts",
    methods: ["GET", "PATCH"],
    requestShape: "工单 ID 或更新对象。",
    responseShape: "单个工单对象。",
  });

  const targets = buildRuntimeInteractionTargets(planSpec);

  assert.equal(apiFilePathToHttpPath("/app/api/work-orders/[id]/route.ts"), "/api/work-orders/[id]");
  assert.equal(matchRuntimeInteractionTarget("GET", "/work-orders/123", targets)?.label, "GET /work-orders/[id]");
  assert.equal(matchRuntimeInteractionTarget("PATCH", "/api/work-orders/123", targets)?.label, "PATCH /api/work-orders/[id]");
  assert.equal(matchRuntimeInteractionTarget("GET", "/_next/static/chunks/app.js", targets), null);
});

test("static routes take priority over dynamic routes in runtime target matching", () => {
  const planSpec = buildPlanSpec();
  planSpec.pages.push(
    { name: "EquipmentDetail", route: "/resource/equipment/[id]", kind: "detail", purpose: "详情" },
    { name: "EquipmentMaintenance", route: "/resource/equipment/maintenance", kind: "list", purpose: "维护" },
    { name: "EquipmentMaintenanceDetail", route: "/resource/equipment/maintenance/[id]", kind: "detail", purpose: "维护详情" },
    { name: "AdminSectionDetail", route: "/admin/[section]/[id]", kind: "detail", purpose: "管理详情" },
    { name: "TenantSettingsProfile", route: "/[tenant]/settings/profile", kind: "detail", purpose: "租户设置" },
  );

  const targets = buildRuntimeInteractionTargets(planSpec);

  assert.equal(
    matchRuntimeInteractionTarget("GET", "/resource/equipment/maintenance", targets)?.label,
    "GET /resource/equipment/maintenance",
    "static list route should match before dynamic [id]",
  );
  assert.equal(
    matchRuntimeInteractionTarget("GET", "/resource/equipment/maintenance/1", targets)?.label,
    "GET /resource/equipment/maintenance/[id]",
    "dynamic route should still match its own path",
  );
  assert.equal(
    matchRuntimeInteractionTarget("GET", "/resource/equipment/123", targets)?.label,
    "GET /resource/equipment/[id]",
    "dynamic route should match when no static route exists",
  );
  assert.equal(
    matchRuntimeInteractionTarget("GET", "/admin/settings/profile", targets)?.label,
    "GET /admin/[section]/[id]",
    "earlier static segments should outrank later aggregate specificity",
  );
});

test("non-interactive runtime probes sample dynamic page and API routes", () => {
  const planSpec = buildPlanSpec();
  planSpec.pages.push({
    name: "文件预览",
    route: "/files/[...path]",
    kind: "detail",
    purpose: "预览嵌套文件路径。",
  });
  planSpec.apis.push({
    name: "WorkOrderItem",
    resourceName: "WorkOrder",
    path: "/app/api/work-orders/[id]/route.ts",
    methods: ["GET", "PATCH"],
    requestShape: "工单 ID 或更新对象。",
    responseShape: "单个工单对象。",
  });

  const targets = buildRuntimeInteractionTargets(planSpec);
  const detailPage = targets.find((target) => target.label === "GET /work-orders/[id]");
  const catchAllPage = targets.find((target) => target.label === "GET /files/[...path]");
  const itemApi = targets.find((target) => target.label === "PATCH /api/work-orders/[id]");

  assert.ok(detailPage);
  assert.ok(catchAllPage);
  assert.ok(itemApi);
  assert.equal(runtimeInteractionTargetToProbePath(detailPage), "/work-orders/1");
  assert.equal(runtimeInteractionTargetToProbePath(catchAllPage), "/files/sample/path");
  assert.equal(runtimeInteractionTargetToProbePath(itemApi), "/api/work-orders/1");
});

test("interactive runtime coverage rejects API auth failures", () => {
  const tracker = new RuntimeInteractionCoverageTracker(buildRuntimeInteractionTargets(buildPlanSpec()));

  assert.equal(tracker.record({ method: "GET", path: "/work-orders", status: 200 }).record.counted, true);
  assert.equal(tracker.record({ method: "GET", path: "/work-orders/abc", status: 404 }).record.counted, false);
  const apiAuthFailure = tracker.record({ method: "POST", path: "/api/work-orders", status: 401 });
  assert.equal(apiAuthFailure.record.counted, false);
  assert.match(apiAuthFailure.repairReason ?? "", /API 权限错误 401/);
  assert.match(
    tracker.record({ method: "GET", path: "/api/unknown", status: 403 }).repairReason ?? "",
    /API 权限错误 403/,
  );
  assert.equal(tracker.record({ method: "GET", path: "/favicon.ico", status: 500 }).repairReason, undefined);
  assert.match(
    tracker.record({ method: "GET", path: "/api/unknown", status: 500 }).repairReason ?? "",
    /请求返回 500/,
  );

  const summary = tracker.getSummary();
  assert.equal(summary.covered, 1);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.coveredTargets, ["GET /work-orders"]);
});

test("non-interactive runtime validation starts dev server and visits every page and API", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-non-interactive-dev-server-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "function send(req, res, status, body, contentType = 'text/plain') {",
        "  console.log(`${req.method} ${req.url} ${status} in 1ms`);",
        "  res.writeHead(status, { 'content-type': contentType });",
        "  res.end(body);",
        "}",
        "const server = http.createServer((req, res) => {",
        "  if (req.url === '/__app_builder_ready') { send(req, res, 200, 'ready'); return; }",
        "  if (req.url?.startsWith('/work-orders/1')) { send(req, res, 404, 'dynamic page not seeded'); return; }",
        "  if (req.url?.startsWith('/work-orders')) { send(req, res, 200, '<main>work orders</main>', 'text/html'); return; }",
        "  if (req.url?.startsWith('/api/work-orders')) {",
        "    const status = req.method === 'POST' ? 201 : 200;",
        "    send(req, res, status, JSON.stringify({ ok: true, method: req.method }), 'application/json');",
        "    return;",
        "  }",
        "  send(req, res, 404, 'missing');",
        "});",
        "server.listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
    });

    const result = await runNonInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      devServerStep,
      readyTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });

    const dynamicPageRecord = result.artifact.recentRequests.find((record) =>
      record.source === "non-interactive-probe" && record.targetLabel === "GET /work-orders/[id]"
    );
    const artifact = await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8");
    const log = await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8");

    assert.deepEqual(result.reasons, []);
    assert.equal(result.steps[0]?.ok, true);
    assert.equal(result.artifact.valid, true);
    assert.equal(result.artifact.validationMode, "non-interactive");
    assert.equal(result.artifact.completionMode, "automated_probe");
    assert.equal(result.artifact.coverage.covered, 4);
    assert.equal(result.artifact.coverage.total, 4);
    assert.equal(result.artifact.coverageSatisfied, true);
    assert.equal(dynamicPageRecord?.status, 404);
    assert.equal(dynamicPageRecord?.counted, true);
    assert.match(artifact, /"validationMode": "non-interactive"/);
    assert.match(artifact, /"completionMode": "automated_probe"/);
    assert.match(log, /=== non-interactive runtime validation ===/);
    assert.match(log, /\[non-interactive\] GET \/work-orders -> 200/);
    assert.match(log, /\[non-interactive\] GET \/work-orders\/1 -> 404/);
    assert.match(log, /\[non-interactive\] POST \/api\/work-orders -> 201/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("smoke runtime validation starts dev server and renders every planned page only", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-smoke-dev-server-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };
  const fakeBrowser = createFakeSmokeBrowserLauncher();

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "function send(req, res, status, body, contentType = 'text/plain') {",
        "  console.log(`${req.method} ${req.url} ${status} in 1ms`);",
        "  res.writeHead(status, { 'content-type': contentType });",
        "  res.end(body);",
        "}",
        "const server = http.createServer((req, res) => {",
        "  if (req.url === '/__app_builder_ready') { send(req, res, 200, 'ready'); return; }",
        "  if (req.url?.startsWith('/api/')) { send(req, res, 500, 'api should not be directly smoked'); return; }",
        "  if (req.url?.startsWith('/work-orders/1')) { send(req, res, 404, '<main>dynamic page not seeded</main>', 'text/html'); return; }",
        "  if (req.url?.startsWith('/work-orders')) { send(req, res, 200, '<main>work orders</main>', 'text/html'); return; }",
        "  send(req, res, 404, 'missing');",
        "});",
        "server.listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
    });

    const result = await runSmokeRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      devServerStep,
      readyTimeoutMs: 5_000,
      navigationTimeoutMs: 5_000,
      browserLauncher: fakeBrowser.launcher,
    });

    const dynamicPageRecord = result.artifact.recentRequests.find((record) =>
      record.source === "browser-smoke" && record.targetLabel === "GET /work-orders/[id]"
    );
    const artifact = await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8");
    const log = await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8");

    assert.deepEqual(result.reasons, []);
    assert.equal(result.steps[0]?.ok, true);
    assert.equal(result.artifact.valid, true);
    assert.equal(result.artifact.validationMode, "smoke");
    assert.equal(result.artifact.completionMode, "browser_smoke");
    assert.equal(result.artifact.coverage.covered, 2);
    assert.equal(result.artifact.coverage.total, 2);
    assert.equal(result.artifact.coverageSatisfied, true);
    assert.equal(dynamicPageRecord?.status, 404);
    assert.equal(dynamicPageRecord?.counted, true);
    assert.deepEqual(fakeBrowser.visitedPaths.sort(), ["/work-orders", "/work-orders/1"]);
    assert.equal(fakeBrowser.visitedPaths.some((visitedPath) => visitedPath.startsWith("/api/")), false);
    assert.match(artifact, /"validationMode": "smoke"/);
    assert.match(artifact, /"completionMode": "browser_smoke"/);
    assert.match(log, /=== smoke runtime validation ===/);
    assert.match(log, /\[smoke\] GET \/work-orders -> 200/);
    assert.match(log, /\[smoke\] GET \/work-orders\/1 -> 404/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("smoke runtime validation fails on browser render and runtime errors", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const cases: Array<{
    name: string;
    status: number;
    body: string;
    behavior?: FakeSmokeBrowserBehavior;
    expected: RegExp;
    logExpected?: RegExp;
  }> = [
    { name: "page 500", status: 500, body: "server error", expected: /500/ },
    { name: "static 404", status: 404, body: "missing", expected: /页面返回 404/ },
    { name: "empty body", status: 200, body: "<main></main>", expected: /空白页/ },
    {
      name: "pageerror",
      status: 200,
      body: "<main>work orders</main>",
      behavior: { pageErrors: { "/work-orders": ["render exploded"] } },
      expected: /pageerror/,
    },
    {
      name: "console error",
      status: 200,
      body: "<main>work orders</main>",
      behavior: { consoleErrors: { "/work-orders": ["client exploded"] } },
      expected: /console\.error/,
    },
  ];

  for (const smokeCase of cases) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `app-builder-smoke-failure-${smokeCase.name.replace(/\s+/g, "-")}-`));
    const deepagentsDirectory = path.join(tempRoot, ".workspace");
    const serverPath = path.join(tempRoot, "server.mjs");
    const devServerStep = {
      name: "node dev server",
      command: process.execPath,
      args: ["server.mjs"],
      kind: "dev-server" as const,
    };
    const planSpec = buildPlanSpec();
    planSpec.pages = [planSpec.pages[0]!];
    planSpec.apis = [];
    const fakeBrowser = createFakeSmokeBrowserLauncher(smokeCase.behavior);

    try {
      await mkdir(deepagentsDirectory, { recursive: true });
      await writeFile(
        serverPath,
        [
          "import http from 'node:http';",
          "const port = Number(process.env.PORT);",
          `const pageStatus = ${smokeCase.status};`,
          `const pageBody = ${JSON.stringify(smokeCase.body)};`,
          "function send(req, res, status, body, contentType = 'text/plain') {",
          "  console.log(`${req.method} ${req.url} ${status} in 1ms`);",
          "  res.writeHead(status, { 'content-type': contentType });",
          "  res.end(body);",
          "}",
          "const server = http.createServer((req, res) => {",
          "  if (req.url === '/__app_builder_ready') { send(req, res, 200, 'ready'); return; }",
          "  if (req.url?.startsWith('/work-orders')) { send(req, res, pageStatus, pageBody, 'text/html'); return; }",
          "  send(req, res, 404, 'missing');",
          "});",
          "server.listen(port, '127.0.0.1');",
          "",
        ].join("\n"),
        "utf8",
      );

      const runtime = buildTestRuntime({
        outputDirectory: tempRoot,
        deepagentsDirectory,
        deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
        deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      });

      const result = await runSmokeRuntimeValidation({
        runtime,
        planSpec,
        devServerStep,
        readyTimeoutMs: 5_000,
        navigationTimeoutMs: 5_000,
        browserLauncher: fakeBrowser.launcher,
      });
      const artifact = await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8");
      const log = await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8");

      assert.equal(result.artifact.valid, false, smokeCase.name);
      assert.equal(result.steps[0]?.ok, false, smokeCase.name);
      assert.match(result.reasons.join("\n"), smokeCase.expected, smokeCase.name);
      assert.match(artifact, /"validationMode": "smoke"/, smokeCase.name);
      assert.match(artifact, smokeCase.expected, smokeCase.name);
      assert.match(log, smokeCase.logExpected ?? smokeCase.expected, smokeCase.name);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("smoke runtime validation reports missing Playwright Chromium with an install hint", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-smoke-missing-browser-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "const server = http.createServer((req, res) => {",
        "  res.writeHead(200, { 'content-type': 'text/plain' });",
        "  res.end(req.url === '/__app_builder_ready' ? 'ready' : 'ok');",
        "});",
        "server.listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
    });

    const result = await runSmokeRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      devServerStep,
      readyTimeoutMs: 5_000,
      browserLauncher: {
        async launch() {
          throw new Error("Executable doesn't exist at /missing/chromium");
        },
      },
    });

    assert.equal(result.artifact.valid, false);
    assert.match(result.reasons.join("\n"), /pnpm exec playwright install chromium/);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /install chromium/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime parses dev server stdout request lines and cross-origin failures", () => {
  assert.deepEqual(parseDevServerRequestLine(" GET /api/weather/current?city=Beijing 200 in 18ms"), {
    source: "dev-server-output",
    method: "GET",
    path: "/api/weather/current?city=Beijing",
    status: 200,
  });
  assert.deepEqual(parseDevServerRequestLine("\u001b[32mPOST http://127.0.0.1:3000/api/work-orders 201 in 4ms\u001b[0m"), {
    source: "dev-server-output",
    method: "POST",
    path: "/api/work-orders",
    status: 201,
  });
  assert.equal(parseDevServerRequestLine("✓ Ready in 192ms"), null);
  assert.match(
    detectDevServerOutputFailure("⚠ Blocked cross-origin request to Next.js dev resource /_next/static/chunks/app.js from \"127.0.0.1\".") ?? "",
    /跨源资源阻止/,
  );
});

test("interactive runtime exposes proxy and passes after request idle", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-dev-server-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
        [
          "import http from 'node:http';",
          "const port = Number(process.env.PORT);",
          "function send(req, res, status, body) {",
          "  console.log(`${req.method} ${req.url} ${status} in 1ms`);",
          "  res.writeHead(status);",
          "  res.end(body);",
          "}",
          "const server = http.createServer((req, res) => {",
          "  if (req.url?.startsWith('/work-orders')) { send(req, res, 200, 'page'); return; }",
          "  if (req.url?.startsWith('/api/work-orders')) { send(req, res, req.method === 'GET' ? 200 : 201, 'api'); return; }",
          "  if (req.url?.startsWith('/_next/webpack-hmr')) { send(req, res, 426, 'upgrade required'); return; }",
          "  send(req, res, 404, 'missing');",
          "});",
          "server.on('upgrade', (req, socket) => {",
          "  console.log(`${req.method} ${req.url} 101 in 1ms`);",
          "  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');",
          "  socket.end();",
          "});",
          "server.listen(port, '127.0.0.1');",
          "",
        ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 1,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });
    let openedUrl = "";

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: true,
      browserOpener: (url) => {
        openedUrl = url;
        return { attempted: true, opened: true };
      },
      onReady: async ({ proxyUrl, browserOpened }) => {
        assert.equal(browserOpened, true);
        assert.ok(proxyUrl);
        assert.match(proxyUrl ?? "", /^http:\/\/127\.0\.0\.1:/);
        assert.equal(await requestLocalUrl(`${proxyUrl}/work-orders`), 200);
        assert.equal(await requestLocalUrl(`${proxyUrl}/work-orders/abc`), 200);
        assert.equal(await requestLocalUrl(`${proxyUrl}/api/work-orders`), 200);
        assert.equal(await requestLocalUrl(`${proxyUrl}/api/work-orders`, "POST"), 201);
        assert.equal(
          await requestWebSocketUpgradeStatusLine(`${proxyUrl}/_next/webpack-hmr?id=test`),
          "HTTP/1.1 101 Switching Protocols",
        );
      },
    });

    assert.deepEqual(result.reasons, []);
    assert.equal(result.artifact.valid, true);
    assert.match(result.artifact.devServerUrl ?? "", /^http:\/\/127\.0\.0\.1:/);
    assert.match(result.artifact.proxyUrl ?? "", /^http:\/\/127\.0\.0\.1:/);
    assert.equal(result.artifact.validationUrl, `${result.artifact.proxyUrl}/validate`);
    assert.equal(result.artifact.browserOpened, true);
    assert.equal(result.artifact.coverage.covered, 4);
    assert.equal(result.artifact.coverage.total, 4);
    assert.equal(result.artifact.coverageSatisfied, true);
    assert.equal(result.artifact.completionMode, "coverage_proven");
    assert.deepEqual(result.artifact.criticalUncoveredTargets, []);
    assert.equal(openedUrl, result.artifact.validationUrl);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /Visit validation URL/);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /\[proxy\] GET \/work-orders -> 200/);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /Opened default browser/);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /Runtime coverage 4\/4/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /"valid": true/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime validate page can manually complete without coverage pollution", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-manual-complete-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "http.createServer((_req, res) => {",
        "  res.writeHead(200, { 'content-type': 'text/plain' });",
        "  res.end('ok');",
        "}).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 1,
        idleTimeoutMs: 60_000,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: false,
      onReady: async ({ proxyUrl, validationUrl }) => {
        assert.ok(proxyUrl);
        assert.ok(validationUrl);
        assert.equal(validationUrl, `${proxyUrl}/validate`);
        const validationPage = await requestLocalResponse(validationUrl);
        assert.equal(validationPage.status, 200);
        assert.match(validationPage.body, /<iframe[^>]+src="\/"/);
        assert.match(validationPage.body, /<iframe[^>]+allow="[^"]*geolocation \*/);
        assert.match(validationPage.body, /<iframe[^>]+allow="[^"]*camera \*/);
        assert.match(validationPage.body, /<iframe[^>]+allow="[^"]*microphone \*/);
        assert.match(validationPage.body, /<iframe[^>]+allow="[^"]*clipboard-read \*/);
        assert.match(validationPage.body, /<iframe[^>]+allowfullscreen/);
        assert.match(validationPage.body, /验证完成/);
        assert.match(validationPage.body, /\/__app_builder_validate_complete/);
        const validationToken = extractValidationToken(validationPage.body);

        const rejectedCompleteResponse = await requestLocalResponse(`${proxyUrl}/__app_builder_validate_complete`, "POST");
        assert.equal(rejectedCompleteResponse.status, 403);

        const completeResponse = await requestLocalResponse(
          `${proxyUrl}/__app_builder_validate_complete`,
          "POST",
          undefined,
          { "x-app-builder-validation-token": validationToken },
        );
        assert.equal(completeResponse.status, 200);
        assert.match(completeResponse.body, /"manualCompleted":true/);
      },
    });

    assert.deepEqual(result.reasons, []);
    assert.equal(result.artifact.valid, true);
    assert.equal(result.artifact.manualCompleted, true);
    assert.equal(result.artifact.completionMode, "manual_override");
    assert.equal(result.artifact.coverageSatisfied, false);
    assert.deepEqual(result.artifact.criticalUncoveredTargets, [
      "GET /work-orders",
      "GET /work-orders/[id]",
      "GET /api/work-orders",
      "POST /api/work-orders",
    ]);
    assert.match(result.artifact.validationUrl ?? "", /\/validate$/);
    assert.equal(result.artifact.coverage.covered, 0);
    assert.equal(result.artifact.coverage.total, 4);
    assert.equal(result.artifact.recentRequests.length, 0);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /Runtime validation manually completed from \/validate/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /"manualCompleted": true/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /"completionMode": "manual_override"/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /"coverageSatisfied": false/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime validate page can submit implementation requests for repair", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-implementation-request-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "http.createServer((_req, res) => {",
        "  res.writeHead(200, { 'content-type': 'text/plain' });",
        "  res.end('ok');",
        "}).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 1,
        idleTimeoutMs: 60_000,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });
    const requirement = "把工单详情页增加一个状态更新时间字段";

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: false,
      onReady: async ({ proxyUrl, validationUrl }) => {
        assert.ok(proxyUrl);
        assert.ok(validationUrl);
        const validationPage = await requestLocalResponse(validationUrl);
        assert.equal(validationPage.status, 200);
        assert.match(validationPage.body, /提交问题/);
        assert.match(validationPage.body, /输入你希望 Agent 修改或补充的要求/);
        assert.match(validationPage.body, /\/__app_builder_validate_request/);
        const validationToken = extractValidationToken(validationPage.body);

        const rejectedRequestResponse = await requestLocalResponse(
          `${proxyUrl}/__app_builder_validate_request`,
          "POST",
          JSON.stringify({ requirement, requestedAt: "2026-04-29T00:00:00.000Z" }),
        );
        assert.equal(rejectedRequestResponse.status, 403);

        const requestResponse = await requestLocalResponse(
          `${proxyUrl}/__app_builder_validate_request`,
          "POST",
          JSON.stringify({ requirement, requestedAt: "2026-04-29T00:00:00.000Z" }),
          { "x-app-builder-validation-token": validationToken },
        );
        assert.equal(requestResponse.status, 200);
        assert.match(requestResponse.body, /"implementationRequested":true/);
      },
    });

    assert.equal(result.artifact.valid, false);
    assert.match(result.reasons.join("\n"), /用户在运行验证页提交实现要求/);
    assert.match(result.reasons.join("\n"), new RegExp(requirement));
    assert.equal(result.artifact.implementationRequest?.requirement, requirement);
    assert.equal(result.artifact.implementationRequest?.source, "/validate");
    assert.equal(result.artifact.coverage.covered, 0);
    assert.equal(result.artifact.coverage.total, 4);
    assert.equal(result.artifact.recentRequests.length, 0);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /implementation request from \/validate/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /"implementationRequest"/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), new RegExp(requirement));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime captures API 401 response body for repair context", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-proxy-401-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "http.createServer((req, res) => {",
        "  if (req.url?.startsWith('/api/work-orders')) {",
        "    console.error('API auth failed: invalid upstream key');",
        "    res.writeHead(401, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ code: 401, error: 'invalid upstream key', route: req.url }));",
        "    return;",
        "  }",
        "  res.writeHead(200);",
        "  res.end('ok');",
        "}).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 0,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: false,
      onReady: async ({ proxyUrl }) => {
        assert.ok(proxyUrl);
        const response = await requestLocalResponse(`${proxyUrl}/api/work-orders`);
        assert.equal(response.status, 401);
        assert.match(response.body, /invalid upstream key/);
      },
    });

    assert.equal(result.artifact.valid, false);
    assert.match(result.reasons.join("\n"), /API 权限错误 401/);
    assert.match(result.artifact.proxyUrl ?? "", /^http:\/\/127\.0\.0\.1:/);
    assert.equal(result.artifact.failureChain?.request?.status, 401);
    assert.equal(result.artifact.failureChain?.request?.counted, false);
    assert.match(result.artifact.failureChain?.request?.responseBodySummary ?? "", /invalid upstream key/);
    assert.match(result.artifact.failureChain?.recentDevServerOutput.join("\n") ?? "", /API auth failed/);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /\[proxy\] GET \/api\/work-orders -> 401/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /"failureChain"/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /invalid upstream key/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime captures proxy 5xx response body for repair context", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-proxy-5xx-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "http.createServer((req, res) => {",
        "  if (req.url?.startsWith('/api/work-orders')) {",
        "    console.error('API handler failed: missing WorkOrder table');",
        "    res.writeHead(500, { 'content-type': 'application/json' });",
        "    res.end(JSON.stringify({ error: 'missing WorkOrder table', route: req.url }));",
        "    return;",
        "  }",
        "  res.writeHead(200);",
        "  res.end('ok');",
        "}).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 0,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: false,
      onReady: async ({ proxyUrl }) => {
        assert.ok(proxyUrl);
        const response = await requestLocalResponse(`${proxyUrl}/api/work-orders`);
        assert.equal(response.status, 500);
        assert.match(response.body, /missing WorkOrder table/);
      },
    });

    assert.equal(result.artifact.valid, false);
    assert.match(result.reasons.join("\n"), /请求返回 500/);
    assert.match(result.artifact.proxyUrl ?? "", /^http:\/\/127\.0\.0\.1:/);
    assert.match(result.artifact.failureChain?.request?.responseBodySummary ?? "", /missing WorkOrder table/);
    assert.match(result.artifact.failureChain?.recentDevServerOutput.join("\n") ?? "", /API handler failed/);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /\[proxy\] GET \/api\/work-orders -> 500/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /"failureChain"/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /missing WorkOrder table/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime reuses ports and does not reopen browser within a session", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-stable-session-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const startCountPath = path.join(tempRoot, "server-starts.txt");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };
  const session: RuntimeInteractionValidationSession = {};

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
        "import http from 'node:http';",
        `const startCountPath = ${JSON.stringify(startCountPath)};`,
        "const previousStarts = existsSync(startCountPath) ? Number(readFileSync(startCountPath, 'utf8')) : 0;",
        "writeFileSync(startCountPath, String(previousStarts + 1));",
        "const port = Number(process.env.PORT);",
        "http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 0,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });
    const openedUrls: string[] = [];

    const first = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      session,
      openBrowser: true,
      browserOpener: (url) => {
        openedUrls.push(url);
        return { attempted: true, opened: true };
      },
    });

    const second = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      session,
      openBrowser: true,
      browserOpener: (url) => {
        openedUrls.push(url);
        return { attempted: true, opened: true };
      },
    });

    assert.equal(first.artifact.valid, true);
    assert.equal(second.artifact.valid, true);
    assert.equal(first.artifact.devServerUrl, second.artifact.devServerUrl);
    assert.equal(first.artifact.proxyUrl, second.artifact.proxyUrl);
    assert.equal(first.artifact.validationUrl, `${first.artifact.proxyUrl}/validate`);
    assert.equal(second.artifact.validationUrl, first.artifact.validationUrl);
    assert.deepEqual(openedUrls, [first.artifact.validationUrl]);
    assert.equal(session.devPort, Number(new URL(first.artifact.devServerUrl ?? "").port));
    assert.equal(session.proxyPort, Number(new URL(first.artifact.proxyUrl ?? "").port));
    assert.equal(await readFile(startCountPath, "utf8"), "1");
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /Reusing previously opened browser/);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /Reusing existing dev server process/);
  } finally {
    await closeRuntimeInteractionValidationSession(session);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("closeRuntimeInteractionValidationSession terminates dev server descendants", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-process-tree-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const childPath = path.join(tempRoot, "child.mjs");
  const childPidPath = path.join(tempRoot, "child.pid");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };
  const session: RuntimeInteractionValidationSession = {};
  let childPid: number | undefined;

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(childPath, "setInterval(() => {}, 1000);\n", "utf8");
    await writeFile(
      serverPath,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "import http from 'node:http';",
        `const childPidPath = ${JSON.stringify(childPidPath)};`,
        "const child = spawn(process.execPath, ['child.mjs'], { stdio: 'ignore' });",
        "writeFileSync(childPidPath, String(child.pid));",
        "const port = Number(process.env.PORT);",
        "http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 0,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      session,
      openBrowser: false,
    });

    childPid = Number(await readFile(childPidPath, "utf8"));
    assert.equal(result.artifact.valid, true);
    assert.equal(isPidRunning(childPid), true);

    await closeRuntimeInteractionValidationSession(session);
    assert.equal(await waitForPidExit(childPid), true);
    assert.equal(session.devServerProcessCleanup?.attempted, true);
  } finally {
    await closeRuntimeInteractionValidationSession(session);
    if (childPid !== undefined && isPidRunning(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Best-effort cleanup.
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime clears stale Next dev lock for the current output directory before startup", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-stale-next-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const nextDevDirectory = path.join(tempRoot, ".next", "dev");
  const staleProcessPath = path.join(tempRoot, "stale-next.mjs");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };
  let staleProcess: ChildProcess | undefined;

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await mkdir(nextDevDirectory, { recursive: true });
    await writeFile(staleProcessPath, "setInterval(() => {}, 1000);\n", "utf8");
    staleProcess = spawn(process.execPath, ["stale-next.mjs"], {
      cwd: tempRoot,
      stdio: "ignore",
    });
    const stalePid = staleProcess.pid;
    assert.ok(stalePid);
    await writeFile(
      path.join(nextDevDirectory, "lock"),
      `${JSON.stringify({
        pid: stalePid,
        port: 64115,
        hostname: "localhost",
        appUrl: "http://localhost:64115",
        startedAt: Date.now(),
      })}\n`,
      "utf8",
    );
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 0,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: false,
    });

    assert.equal(result.artifact.valid, true);
    assert.equal(await waitForPidExit(stalePid), true);
    assert.match(await readFile(runtime.deepagentsRuntimeValidationLogPath, "utf8"), /Stopped stale Next dev server PID/);
  } finally {
    stopTestProcess(staleProcess);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime fails on blocked cross-origin dev resource output", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-cross-origin-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "console.error('⚠ Blocked cross-origin request to Next.js dev resource /_next/static/chunks/app.js from \"127.0.0.1\".');",
        "http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 0,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: false,
    });

    assert.equal(result.artifact.valid, false);
    assert.match(result.reasons.join("\n"), /跨源资源阻止/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /detectedDevServerError/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime fails from dev server stdout errors", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-stdout-error-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "console.error('Failed to compile: broken app/page.tsx');",
        "http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 1,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      openBrowser: false,
    });

    assert.equal(result.artifact.valid, false);
    assert.match(result.reasons.join("\n"), /stdout\/stderr/);
    assert.match(result.reasons.join("\n"), /Failed to compile/);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /detectedDevServerError/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("interactive runtime detects compile errors before MallocStackLogging noise", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-stdout-noise-"));
  const deepagentsDirectory = path.join(tempRoot, ".workspace");
  const serverPath = path.join(tempRoot, "server.mjs");
  const devServerStep = {
    name: "node dev server",
    command: process.execPath,
    args: ["server.mjs"],
    kind: "dev-server" as const,
  };

  try {
    await mkdir(deepagentsDirectory, { recursive: true });
    await writeFile(
      serverPath,
      [
        "import http from 'node:http';",
        "const port = Number(process.env.PORT);",
        "process.stderr.write([",
        "  \"Error: Can't resolve 'tailwindcss' in '/tmp/generated-app'\",",
        "  ...Array.from({ length: 80 }, (_, index) => `node(${64000 + index}) MallocStackLogging: can't turn off malloc stack logging because it was not enabled.`),",
        "].join('\\n') + '\\n');",
        "http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
        "",
      ].join("\n"),
      "utf8",
    );

    const runtime = buildTestRuntime({
      outputDirectory: tempRoot,
      deepagentsDirectory,
      deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
      deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
      templateInteractiveRuntimeValidation: {
        enabled: true,
        coverageThreshold: 0,
        idleTimeoutMs: 20,
        readyTimeoutMs: 5_000,
        devServerStep,
      },
    });

    const session: RuntimeInteractionValidationSession = {};
    const result = await runInteractiveRuntimeValidation({
      runtime,
      planSpec: buildPlanSpec(),
      config: runtime.templateInteractiveRuntimeValidation,
      session,
      openBrowser: false,
    });

    assert.equal(result.artifact.valid, false);
    assert.match(result.reasons.join("\n"), /Can't resolve 'tailwindcss'/);
    assert.doesNotMatch(result.reasons.join("\n"), /MallocStackLogging/);
    assert.equal(session.devServerProcess, undefined);
    assert.equal(result.artifact.devServerProcessCleanup?.attempted, true);
    assert.match(await readFile(runtime.deepagentsRuntimeInteractionValidationPath, "utf8"), /detectedDevServerError/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("planSpec schema accepts PRD-derived environment variables, references, and project config changes", () => {
  const planSpec = buildPlanSpec();
  planSpec.environmentVariables = [
    {
      name: "QWEATHER_API_KEY",
      value: "e1499e17f3934df58273c9d4ea56bc54",
      description: "和风天气 API 调用密钥。",
      targetFile: ".env.example",
    },
    {
      name: "QWEATHER_API_HOST",
      value: "my6yw2bmj5.re.qweatherapi.com",
      description: "和风天气 API Host。",
      targetFile: ".env.example",
    },
  ];
  planSpec.references = [
    {
      name: "QWeather 实时天气 API",
      type: "external_api",
      url: "https://dev.qweather.com/docs/api/weather/weather-now/",
      description: "用于理解和风天气实时天气接口的认证、请求参数和响应结构。",
      usage: "生成阶段自行判断是否用于相关天气 API 实现。",
      localPath: "/.workspace/references/external/dev-qweather-com-docs-api-weather-weather-now.md",
      retrievedAt: "2026-04-30T00:00:00.000Z",
      contentType: "text/html; charset=utf-8",
      retrievalStatus: "downloaded",
    },
  ];
  planSpec.projectConfigChanges = [
    {
      filePath: "next.config.ts",
      reason: "Allow remote product images required by the PRD.",
      prdEvidence: "PRD: product images are hosted on https://cdn.example.com and must render in the app.",
    },
  ];

  const validation = validatePlanSpec(planSpec);

  assert.equal(validation.success, true);
  if (validation.success) {
    assert.equal(validation.data.environmentVariables?.length, 2);
    assert.equal(validation.data.environmentVariables?.[0]?.name, "QWEATHER_API_KEY");
    assert.equal(validation.data.references?.length, 1);
    assert.equal(validation.data.references?.[0]?.type, "external_api");
    assert.equal(validation.data.projectConfigChanges?.[0]?.filePath, "next.config.ts");
  }
});

async function writeImplementedProjectFiles(options: {
  outputDirectory: string;
  planSpec: PlanSpec;
  reportContents: string;
  pagePathForRoute?: (route: string) => string;
  extraFiles?: Array<{ path: string; contents: string }>;
}): Promise<void> {
  await writeFile(path.join(options.outputDirectory, "app-builder-report.md"), options.reportContents, "utf8");

  for (const apiPath of uniqueApiPaths(options.planSpec)) {
    const relativePath = apiPath.replace(/^\/+/, "");
    const absolutePath = path.join(options.outputDirectory, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "export async function GET() { return Response.json([]); }\n", "utf8");
  }

  const pagePathForRoute = options.pagePathForRoute ?? routeToAdminPagePath;
  for (const page of options.planSpec.pages) {
    const relativePath = pagePathForRoute(page.route);
    const absolutePath = path.join(options.outputDirectory, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "export default function Page() { return null; }\n", "utf8");
  }

  for (const file of options.extraFiles ?? []) {
    const absolutePath = path.join(options.outputDirectory, file.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.contents, "utf8");
  }
}

function routeToMainPagePath(route: string): string {
  return routeToAdminPagePath(route).replace("app/(admin)/", "app/(main)/");
}

class SuccessfulRuntimeValidator implements GeneratedAppValidator {
  async validate(_outputDirectory: string, runtime: TextGeneratorRuntime) {
    await writeFile(
      runtime.deepagentsRuntimeValidationLogPath,
      [
        "=== pnpm install ===",
        "[ok] 执行成功。",
        "=== mv .env.example .env ===",
        "[ok] 已生成 .env。",
        "=== pnpm db:init ===",
        "[ok] 执行成功。",
        "=== pnpm dev ===",
        "[ok] 服务已启动。",
      ].join("\n"),
      "utf8",
    );

    return {
      reasons: [],
      steps: [
        { name: "mv .env.example .env", ok: true, detail: "已生成 .env。" },
        { name: "pnpm install", ok: true, detail: "执行成功。" },
        { name: "pnpm db:init", ok: true, detail: "执行成功。" },
        { name: "pnpm dev", ok: true, detail: "服务已启动。" },
      ],
    };
  }
}

class SequencedRuntimeValidator implements GeneratedAppValidator {
  private callCount = 0;

  async validate(_outputDirectory: string, runtime: TextGeneratorRuntime) {
    this.callCount += 1;

    if (this.callCount === 1) {
      await writeFile(
        runtime.deepagentsRuntimeValidationLogPath,
        [
          "=== pnpm install ===",
          "[ok] 执行成功。",
          "=== mv .env.example .env ===",
          "[ok] 已生成 .env。",
          "=== pnpm db:init ===",
          "[error] Prisma schema 校验失败。",
        ].join("\n"),
        "utf8",
      );

      return {
        reasons: ["生成阶段运行验证失败：pnpm db:init 未通过。Prisma schema 校验失败。详见 .workspace/runtime-validation.log。"],
        steps: [
          { name: "mv .env.example .env", ok: true, detail: "已生成 .env。" },
          { name: "pnpm install", ok: true, detail: "执行成功。" },
          { name: "pnpm db:init", ok: false, detail: "Prisma schema 校验失败。" },
        ],
      };
    }

    await writeFile(
      runtime.deepagentsRuntimeValidationLogPath,
      [
        "=== pnpm install ===",
        "[ok] 执行成功。",
        "=== mv .env.example .env ===",
        "[ok] 已生成 .env。",
        "=== pnpm db:init ===",
        "[ok] 执行成功。",
        "=== pnpm dev ===",
        "[ok] 服务已启动。",
      ].join("\n"),
      "utf8",
    );

    return {
      reasons: [],
      steps: [
        { name: "mv .env.example .env", ok: true, detail: "已生成 .env。" },
        { name: "pnpm install", ok: true, detail: "执行成功。" },
        { name: "pnpm db:init", ok: true, detail: "执行成功。" },
        { name: "pnpm dev", ok: true, detail: "服务已启动。" },
      ],
    };
  }
}

class StubTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    const planSpec = buildPlanSpec();

    await writeFile(
      runtime.deepagentsAnalysisPath,
      [
        "# Stub 需求分析报告",
        "",
        "## 1. 产品目标",
        "",
        "验证宿主会先完成计划阶段，再放行生成阶段。",
        "",
        "## 2. 主要对象",
        "",
        "- WorkOrder",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      [
        "# Stub 实施详细设计规格书",
        "",
        "## 1. 产品概述",
        "",
        "这是计划阶段写入的详细 spec。",
        "",
        "## 3. 数据模型",
        "",
        "- WorkOrder: title, status",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      runtime.deepagentsPlanSpecPath,
      `${JSON.stringify(planSpec, null, 2)}\n`,
      "utf8",
    );
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Stub planner wrote validated planning artifacts.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Stub Report\n\nGenerated during test.\n",
      extraFiles: [{ path: "generated/marker.txt", contents: "stub-generator-ran\n" }],
    });

    return {
      summary: "Stub generator updated the starter scaffold.",
      filesWritten: [
        "app-builder-report.md",
        "generated/marker.txt",
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in StubTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in StubTextGenerator");
  }
}

class MiniAppMenuAnchorTextGenerator extends StubTextGenerator {
  override async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Mini App Menu Report\n\nGenerated during test.\n",
      extraFiles: [{
        path: "components/AppMenu.tsx",
        contents: [
          "export function AppMenu() {",
          "  return (",
          "    <nav aria-label=\"Primary menu\">",
          "      <a href=\"/work-orders\">Work Orders</a>",
          "    </nav>",
          "  );",
          "}",
          "",
        ].join("\n"),
      }],
    });

    return {
      summary: "Generated mini-app menu with an invalid anchor.",
      filesWritten: [
        "app-builder-report.md",
        "components/AppMenu.tsx",
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }
}

class StructuredPlanSpecResultTextGenerator extends StubTextGenerator {
  override async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    const planSpec = buildPlanSpec();
    const interactionContract = buildValidInteractionContract(planSpec);

    await writeFile(runtime.deepagentsAnalysisPath, "# Structured Plan Analysis\n\n使用结构化响应交付计划规格。\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# Structured Plan Spec\n\n结构化响应中的 planSpec 是权威来源。\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, "{ invalid stale plan spec\n", "utf8");
    await writeFile(runtime.deepagentsInteractionContractPath, "{ invalid stale interaction contract\n", "utf8");

    return {
      summary: "Planner returned planSpec as structured response.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      planSpec,
      interactionContract,
      notes: [],
    };
  }
}

class ParallelInitialGenerationTextGenerator extends StubTextGenerator {
  apiStartedAt = 0;
  apiCompletedAt = 0;
  pageStartedAt = 0;
  pageCompletedAt = 0;
  reportStartedAt = 0;
  reportCompletedAt = 0;
  generateProjectCalled = false;

  async generateProjectWithParallelAgents(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    const writeApis = async () => {
      this.apiStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 80));
      for (const apiPath of uniqueApiPaths(planSpec)) {
        const relativePath = apiPath.replace(/^\/+/, "");
        const absolutePath = path.join(runtime.outputDirectory, relativePath);
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, "export async function GET() { return Response.json([]); }\n", "utf8");
      }
      this.apiCompletedAt = Date.now();
    };

    const writePages = async () => {
      this.pageStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 80));
      for (const page of planSpec.pages) {
        const absolutePath = path.join(runtime.outputDirectory, routeToAdminPagePath(page.route));
        await mkdir(path.dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, "export default function Page() { return null; }\n", "utf8");
      }
      this.pageCompletedAt = Date.now();
    };

    const writeReport = async () => {
      this.reportStartedAt = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await writeFile(
        path.join(runtime.outputDirectory, "app-builder-report.md"),
        "# Parallel Generation Report\n\nGenerated by parallel agents.\n",
        "utf8",
      );
      const markerPath = path.join(runtime.outputDirectory, "generated/parallel-marker.txt");
      await mkdir(path.dirname(markerPath), { recursive: true });
      await writeFile(markerPath, "parallel-generation-ran\n", "utf8");
      this.reportCompletedAt = Date.now();
    };

    await Promise.all([writeApis(), writePages(), writeReport()]);

    return {
      summary: "Parallel generation agents wrote disjoint slices.",
      filesWritten: [
        "app-builder-report.md",
        "generated/parallel-marker.txt",
        ...uniqueApiPaths(planSpec).map((apiPath) => apiPath.replace(/^\/+/, "")),
        ...planSpec.pages.map((page) => routeToAdminPagePath(page.route)),
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  override async generateProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    this.generateProjectCalled = true;
    throw new Error("generateProject should not be called when parallel generation is available");
  }
}

function buildWeatherEnvPlanSpec(): PlanSpec {
  const planSpec = buildIndirectSupportPlanSpec();
  planSpec.environmentVariables = [
    {
      name: "QWEATHER_API_KEY",
      value: "e1499e17f3934df58273c9d4ea56bc54",
      description: "和风天气 API 调用密钥。",
      targetFile: ".env.example",
    },
    {
      name: "QWEATHER_API_HOST",
      value: "my6yw2bmj5.re.qweatherapi.com",
      description: "和风天气 API Host。",
      targetFile: ".env.example",
    },
  ];
  return planSpec;
}


class ReferenceAwareTextGenerator implements TextGenerator {
  observedLocalReferences: TextGeneratorRuntime["localReferences"];
  observedSpecExternalReferences: NormalizedSpec["externalReferences"] | undefined;

  async planProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    this.observedSpecExternalReferences = spec.externalReferences;
    this.observedLocalReferences = runtime.localReferences;
    const reference = runtime.localReferences?.[0];
    const planSpec = buildPlanSpec();
    planSpec.references = reference ? [{
      name: "QWeather 实时天气 API",
      type: "external_api",
      url: reference.url,
      description: "用于理解实时天气接口的认证、请求参数和响应结构。",
      usage: "生成阶段实现天气 API route 时使用。",
      localPath: reference.localPath,
      retrievedAt: reference.retrievedAt,
      contentType: reference.contentType,
      retrievalStatus: reference.retrievalStatus,
    }] : [];

    await writeFile(runtime.deepagentsAnalysisPath, "# API 分析\n\n发现 QWeather 文档。\n", "utf8");
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      [
        "# API 规格",
        "",
        "## References",
        `- QWeather 实时天气 API: ${reference?.url} (${reference?.localPath})`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Reference-aware planner wrote local reference paths.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Reference Report\n\nGenerated with local API docs.\n",
    });
    return {
      summary: "Generated with reference-aware plan.",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<PlanResult> {
    throw new Error("planRepairProject should not be called in ReferenceAwareTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    throw new Error("generateRepairProject should not be called in ReferenceAwareTextGenerator");
  }
}

class ConvertingReferenceTextGenerator extends ReferenceAwareTextGenerator {
  readonly convertedMarkdown = "# Weather Now\n\n- Endpoint: `GET /v7/weather/now`\n- Parameters: `location`, `key`\n";
  observedConversionInput: ReferenceMarkdownConversionInput | undefined;
  observedConversionRuntime: Pick<TextGeneratorRuntime, "sessionId" | "outputDirectory"> | undefined;

  async convertReferenceToMarkdown(
    input: ReferenceMarkdownConversionInput,
    runtime: TextGeneratorRuntime,
  ): Promise<ReferenceMarkdownConversionResult> {
    this.observedConversionInput = input;
    this.observedConversionRuntime = {
      sessionId: runtime.sessionId,
      outputDirectory: runtime.outputDirectory,
    };

    return {
      markdown: this.convertedMarkdown,
      notes: ["converted test fixture"],
    };
  }
}

class FailingReferenceConversionTextGenerator extends ReferenceAwareTextGenerator {
  async convertReferenceToMarkdown(): Promise<ReferenceMarkdownConversionResult> {
    throw new Error("conversion unavailable");
  }
}

class MultiReferenceTextGenerator extends ReferenceAwareTextGenerator {
  readonly conversionDelayMs: number;
  readonly conversionFailures: Set<string>;
  maxConcurrentConversions = 0;
  private activeConversions = 0;

  constructor(options: { conversionDelayMs?: number; conversionFailures?: string[] } = {}) {
    super();
    this.conversionDelayMs = options.conversionDelayMs ?? 0;
    this.conversionFailures = new Set(options.conversionFailures ?? []);
  }

  override async planProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    this.observedSpecExternalReferences = spec.externalReferences;
    this.observedLocalReferences = runtime.localReferences;
    const planSpec = buildPlanSpec();
    const references = (runtime.localReferences ?? [])
      .filter((reference) => reference.retrievalStatus === "downloaded" && reference.localPath)
      .map((reference) => ({
        name: reference.name,
        type: reference.type,
        url: reference.url,
        description: `Local reference for ${reference.url}`,
        usage: `Use ${reference.localPath} during generation.`,
        localPath: reference.localPath,
        retrievedAt: reference.retrievedAt,
        contentType: reference.contentType,
        retrievalStatus: reference.retrievalStatus,
      }));
    planSpec.references = references;

    await writeFile(runtime.deepagentsAnalysisPath, "# Multi Reference Analysis\n", "utf8");
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      [
        "# Multi Reference Spec",
        "",
        "## References",
        ...references.map((reference) => `- ${reference.name}: ${reference.localPath}`),
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Multi-reference planner wrote local reference paths.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async convertReferenceToMarkdown(
    input: ReferenceMarkdownConversionInput,
    _runtime: TextGeneratorRuntime,
  ): Promise<ReferenceMarkdownConversionResult> {
    this.activeConversions += 1;
    this.maxConcurrentConversions = Math.max(this.maxConcurrentConversions, this.activeConversions);

    try {
      if (this.conversionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.conversionDelayMs));
      }
      if (this.conversionFailures.has(input.url)) {
        throw new Error(`conversion failed for ${input.url}`);
      }

      return {
        markdown: `# Converted reference\n\n${input.url}\n\n${input.body}`,
        notes: [],
      };
    } finally {
      this.activeConversions -= 1;
    }
  }
}

class SplitPlanReferenceTextGenerator implements TextGenerator {
  analysisStartedAt = 0;
  analysisCompletedAt = 0;
  conversionStartedAt = 0;
  conversionCompletedAt = 0;
  assemblyStartedAt = 0;
  assemblyObservedLocalReferences: TextGeneratorRuntime["localReferences"];
  assemblyObservedAnalysis = "";
  analysisObservedSourceMarkdownLength = 0;
  planProjectCalled = false;

  async analyzePrd(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    this.analysisStartedAt = Date.now();
    this.analysisObservedSourceMarkdownLength = spec.sourceMarkdown.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    await writeFile(
      runtime.deepagentsAnalysisPath,
      [
        "# Parallel PRD Analysis",
        "",
        `App: ${spec.appName}`,
        "External API details will be finalized during PRD assembly after Markdown conversion joins.",
        "",
      ].join("\n"),
      "utf8",
    );
    this.analysisCompletedAt = Date.now();

    return {
      summary: "Wrote PRD analysis while references converted.",
      artifactsWritten: [".workspace/prd-analysis.md"],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async assemblePlanProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    this.assemblyStartedAt = Date.now();
    this.assemblyObservedLocalReferences = runtime.localReferences;
    this.assemblyObservedAnalysis = await readFile(runtime.deepagentsAnalysisPath, "utf8");
    const planSpec = buildPlanSpec();
    const references = (runtime.localReferences ?? [])
      .filter((reference) => reference.retrievalStatus === "downloaded" && reference.localPath)
      .map((reference) => ({
        name: reference.name,
        type: reference.type,
        url: reference.url,
        description: `Converted reference for ${reference.url}`,
        usage: `Use ${reference.localPath} for API details.`,
        localPath: reference.localPath,
        retrievedAt: reference.retrievedAt,
        contentType: reference.contentType,
        retrievalStatus: reference.retrievalStatus,
      }));
    planSpec.references = references;

    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      [
        "# Assembled Spec",
        "",
        this.assemblyObservedAnalysis,
        "## References",
        ...references.map((reference) => `- ${reference.url}: ${reference.localPath}`),
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Assembled final plan from PRD analysis and converted references.",
      artifactsWritten: [
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async convertReferenceToMarkdown(
    input: ReferenceMarkdownConversionInput,
    _runtime: TextGeneratorRuntime,
  ): Promise<ReferenceMarkdownConversionResult> {
    this.conversionStartedAt = this.conversionStartedAt || Date.now();
    await new Promise((resolve) => setTimeout(resolve, 80));
    this.conversionCompletedAt = Date.now();

    return {
      markdown: `# Converted\n\n${input.url}\n\nEndpoint: GET /weather`,
      notes: [],
    };
  }

  async planProject(): Promise<PlanResult> {
    this.planProjectCalled = true;
    throw new Error("planProject should not be called when split PRD analysis/assembly is available");
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<PlanResult> {
    throw new Error("planRepairProject should not be called in SplitPlanReferenceTextGenerator");
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Split Plan Reference Report\n",
    });
    return {
      summary: "Generated from split plan.",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    throw new Error("generateRepairProject should not be called in SplitPlanReferenceTextGenerator");
  }
}

class FlakyPrdAnalysisTextGenerator extends SplitPlanReferenceTextGenerator {
  analysisAttempts = 0;

  override async analyzePrd(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    this.analysisAttempts += 1;
    if (this.analysisAttempts === 1) {
      throw new Error("deepagents PRD analysis did not return a valid structured response.");
    }

    return super.analyzePrd(spec, runtime);
  }
}

class MalformedPrdAnalysisResponseTextGenerator extends SplitPlanReferenceTextGenerator {
  analysisAttempts = 0;

  override async analyzePrd(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult> {
    this.analysisAttempts += 1;
    await super.analyzePrd(spec, runtime);
    throw new Error("deepagents PRD analysis did not return a valid structured response.");
  }
}

class BrokenReferenceTextGenerator extends ReferenceAwareTextGenerator {
  async planRepairProject(runtime: TextGeneratorRuntime) {
    return this.planProject({} as NormalizedSpec, runtime);
  }
}

class EnvRepairTextGenerator implements TextGenerator {
  generateAttempts = 0;
  repairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildWeatherEnvPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 天气分析\n\n需要和风天气环境变量。\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 天气规格\n\n`.env.example` 必须包含 QWeather 配置。\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Weather planner wrote env-aware artifacts.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generateAttempts += 1;
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Weather Report\n\nInitial generated app.\n",
    });

    return {
      summary: "Initial generation omitted environment variables.",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.repairAttempts += 1;
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Weather Report\n\nRepaired generated app.\n",
      extraFiles: [
        {
          path: ".env.example",
          contents: [
            "NEXT_PUBLIC_APP_NAME=Mini App",
            "QWEATHER_API_KEY=e1499e17f3934df58273c9d4ea56bc54",
            "QWEATHER_API_HOST=my6yw2bmj5.re.qweatherapi.com",
            "",
          ].join("\n"),
        },
      ],
    });

    return {
      summary: "Generation repair added environment variables.",
      filesWritten: ["app-builder-report.md", ".env.example"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in EnvRepairTextGenerator");
  }
}

class LockedEnvMutationTextGenerator implements TextGenerator {
  generateAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildWeatherEnvPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 天气分析\n\n需要和风天气环境变量。\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 天气规格\n\n`.env.example` 由 host 合并。\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Weather planner wrote env-aware artifacts.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generateAttempts += 1;
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Weather Report\n\nGenerated app tried to edit locked env keys.\n",
      extraFiles: [
        {
          path: ".env.example",
          contents: [
            "DATABASE_URL=\"file:./wrong.db\"",
            "NEXT_PUBLIC_APP_NAME=Wrong App",
            "QWEATHER_API_KEY=wrong",
            "",
          ].join("\n"),
        },
        {
          path: ".env",
          contents: [
            "DATABASE_URL=\"file:./wrong.db\"",
            "NEXT_PUBLIC_APP_NAME=Wrong App",
            "",
          ].join("\n"),
        },
      ],
    });

    return {
      summary: "Generated app wrote environment files.",
      filesWritten: ["app-builder-report.md", ".env.example", ".env"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<PlanResult> {
    throw new Error("planRepairProject should not be called in LockedEnvMutationTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in LockedEnvMutationTextGenerator");
  }
}

class LockedEnvConflictTextGenerator extends LockedEnvMutationTextGenerator {
  override async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildWeatherEnvPlanSpec();
    planSpec.environmentVariables = [
      {
        name: "DATABASE_URL",
        value: "file:./tenant.db",
        description: "PRD attempted to change the starter database path.",
        targetFile: ".env.example",
      },
      ...(planSpec.environmentVariables ?? []),
    ];

    await writeFile(runtime.deepagentsAnalysisPath, "# 天气分析\n\n错误地要求修改锁定变量。\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 天气规格\n\n包含锁定变量冲突。\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Planner wrote a locked env conflict.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  override async planRepairProject(_runtime: TextGeneratorRuntime): Promise<PlanResult> {
    throw new Error("planRepairProject should not be called in LockedEnvConflictTextGenerator");
  }
}

class LockedEnvPlanRepairTextGenerator extends LockedEnvConflictTextGenerator {
  planRepairAttempts = 0;
  observedPlanRepairReasons: string[] = [];

  override async planRepairProject(runtime: TextGeneratorRuntime): Promise<PlanResult> {
    this.planRepairAttempts += 1;
    this.observedPlanRepairReasons = runtime.retryReasons ?? [];
    const planSpec = buildWeatherEnvPlanSpec();
    planSpec.assumptions = [
      ...planSpec.assumptions,
      "DATABASE_URL 使用 starter 默认值，代码必须兼容模板锁定的 SQLite 配置。",
    ];

    await writeFile(
      runtime.deepagentsAnalysisPath,
      "# 天气分析\n\nPRD 中的 DATABASE_URL 覆盖请求被模板锁定策略拒绝，使用 starter 默认值。\n",
      "utf8",
    );
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      "# 天气规格\n\nDATABASE_URL 使用 starter 默认值；QWeather 变量由 host 合并。\n",
      "utf8",
    );
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Plan repair removed locked env declarations.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }
}

class UnauthorizedNextConfigMutationTextGenerator extends StubTextGenerator {
  override async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Config Report\n\nGenerated app tried to edit protected config.\n",
      extraFiles: [
        {
          path: "next.config.ts",
          contents: "import type { NextConfig } from \"next\";\n\nconst nextConfig: NextConfig = { output: \"standalone\" };\n\nexport default nextConfig;\n",
        },
      ],
    });

    return {
      summary: "Generated app wrote protected config without PRD declaration.",
      filesWritten: ["app-builder-report.md", "next.config.ts"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }
}

class AuthorizedNextConfigMutationTextGenerator extends UnauthorizedNextConfigMutationTextGenerator {
  override async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    planSpec.projectConfigChanges = [
      {
        filePath: "next.config.ts",
        reason: "Enable standalone output required by the PRD deployment target.",
        prdEvidence: "PRD: deploy the generated app as a standalone Next.js server bundle.",
      },
    ];

    await writeFile(
      runtime.deepagentsAnalysisPath,
      "# Config 分析\n\n## 项目配置变更\n\nPRD 明确要求 standalone 部署，需要修改 next.config.ts。\n",
      "utf8",
    );
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      "# Config 规格\n\n需要在 next.config.ts 中设置 output: standalone。\n",
      "utf8",
    );
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Planner declared the PRD-backed project config change.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }
}

class IndirectResourceTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildIndirectSupportPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 间接资源分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 间接资源详细规格\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "已写入包含 indirect 资源的计划产物。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Indirect Resource Report\n\nGenerated with nested forecast data.\n",
    });

    return {
      summary: "已生成聚合天气接口和首页。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in IndirectResourceTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in IndirectResourceTextGenerator");
  }
}

class ColonRouteTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildColonRoutePlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 动态路由分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 动态路由详细规格\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "已写入使用冒号路由语义的计划产物。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Colon Route Report\n\nGenerated with Next dynamic segments.\n",
    });

    return {
      summary: "已生成动态详情页。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in ColonRouteTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in ColonRouteTextGenerator");
  }
}

class MainRouteGroupTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlantRouteGroupPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# Main Route Group Analysis\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# Main Route Group Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "Wrote plan artifacts for pages under an arbitrary route group.",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Main Route Group Report\n\nGenerated under app/(main).\n",
      pagePathForRoute: routeToMainPagePath,
    });

    return {
      summary: "Generated pages under app/(main).",
      filesWritten: [
        "app-builder-report.md",
        ...uniqueApiPaths(planSpec).map((apiPath) => apiPath.replace(/^\/+/, "")),
        ...planSpec.pages.map((page) => routeToMainPagePath(page.route)),
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in MainRouteGroupTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in MainRouteGroupTextGenerator");
  }
}

class RetryingPlanTextGenerator implements TextGenerator {
  planAttempts = 0;
  planRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    this.planAttempts += 1;
    return {
      summary: "第一次计划阶段返回不完整结果。",
      artifactsWritten: [],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async planRepairProject(runtime: TextGeneratorRuntime) {
    this.planRepairAttempts += 1;
    const planSpec = buildPlanSpec();
    await writeFile(
      runtime.deepagentsAnalysisPath,
      "# 重试后的分析稿\n\n已在同一工作目录中补齐 artifacts.analysis。\n",
      "utf8",
    );
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      "# 重试后的详细 Spec\n\n已在同一工作目录中补齐 artifacts.generatedSpec。\n",
      "utf8",
    );
    await writeFile(
      runtime.deepagentsPlanSpecPath,
      `${JSON.stringify(planSpec, null, 2)}\n`,
      "utf8",
    );
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "重试后已补齐必需计划 artifacts。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Retry Report\n\nArtifacts repaired during retry.\n",
    });

    return {
      summary: "生成阶段直接成功。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in RetryingPlanTextGenerator");
  }
}

function buildInconsistentPlanSpec(): PlanSpec {
  return {
    version: 1,
    appName: "能源管理系统",
    summary: "包含报表中心和基础监控能力的能源管理系统。",
    resources: [
      {
        name: "EnergyPlan",
        pluralName: "EnergyPlans",
        routeSegment: "plans",
        description: "能源计划。",
        fields: [
          { name: "id", label: "ID", type: "string", required: true, source: "prd" },
          { name: "name", label: "名称", type: "string", required: true, source: "prd" },
        ],
        relations: [],
      },
    ],
    pages: [
      {
        name: "仪表盘",
        route: "/",
        kind: "dashboard",
        purpose: "系统总览。",
      },
      {
        name: "报表中心",
        route: "/reports",
        kind: "custom",
        purpose: "报表生成与导出。",
      },
      {
        name: "计划管理",
        route: "/plans",
        kind: "list",
        resourceName: "EnergyPlan",
        purpose: "能源计划管理。",
      },
    ],
    apis: [
      {
        name: "能源计划列表",
        resourceName: "EnergyPlan",
        path: "/app/api/plans/route.ts",
        methods: ["GET", "POST"],
        requestShape: "EnergyPlanInput",
        responseShape: "EnergyPlan[]",
      },
      {
        name: "报表列表",
        resourceName: "Report",
        path: "/app/api/reports/route.ts",
        methods: ["GET"],
        requestShape: "ReportQuery",
        responseShape: "Report[]",
      },
      {
        name: "生成报表",
        resourceName: "Report",
        path: "/app/api/reports/generate/route.ts",
        methods: ["POST"],
        requestShape: "GenerateReportInput",
        responseShape: "Report",
      },
      {
        name: "searchCity",
        resourceName: "Report",
        path: "/app/api/search-city/route.ts",
        methods: ["GET"],
        requestShape: "SearchCityQuery",
        responseShape: "CityOption[]",
      },
      {
        name: "manageHistory",
        resourceName: "Report",
        path: "/app/api/manage-history/route.ts",
        methods: ["GET"],
        requestShape: "HistoryQuery",
        responseShape: "HistoryRecord[]",
      },
    ],
    flows: [
      {
        name: "报表生成流程",
        steps: ["进入报表中心", "选择模板", "生成并导出报表"],
      },
    ],
    assumptions: [],
    acceptanceChecks: [
      {
        id: "page-dashboard",
        description: "仪表盘可以正常打开。",
        type: "page",
        target: "Dashboard",
      },
      {
        id: "page-reports",
        description: "报表中心可以正常打开。",
        type: "page",
        target: "Reports",
      },
      {
        id: "resource-report",
        description: "必须支持报表资源。",
        type: "resource",
        target: "Report",
      },
      {
        id: "api-reports",
        description: "必须实现报表列表接口。",
        type: "api",
        target: "/app/api/reports/route.ts",
      },
      {
        id: "api-search-city",
        description: "必须提供城市搜索接口。",
        type: "api",
        target: "searchCity",
      },
      {
        id: "api-manage-history",
        description: "必须提供历史管理接口。",
        type: "api",
        target: "manageHistory",
      },
      {
        id: "flow-reports",
        description: "必须覆盖报表生成流程。",
        type: "flow",
        target: "报表生成流程",
      },
      {
        id: "resource-security",
        description: "用户认证和权限控制正常工作。",
        type: "resource",
        target: "Security",
      },
    ],
  };
}

class NormalizingPlanTextGenerator implements TextGenerator {
  planRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n\n包含报表规划。\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n\n包含报表与计划页面。\n", "utf8");
    await writeFile(
      runtime.deepagentsPlanSpecPath,
      `${JSON.stringify(buildInconsistentPlanSpec(), null, 2)}\n`,
      "utf8",
    );
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段返回了需要宿主归一化的 plan spec。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    this.planRepairAttempts += 1;
    throw new Error("planRepairProject should not be called in NormalizingPlanTextGenerator");
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Normalize Report\n\nHost normalized the plan spec before generation.\n",
    });

    return {
      summary: "生成阶段成功。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in NormalizingPlanTextGenerator");
  }
}

class StructuredResponseRecoveryTextGenerator implements TextGenerator {
  planRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, _runtime: TextGeneratorRuntime) {
    return {
      summary: "第一次计划阶段不完整，强制进入修复。",
      artifactsWritten: [],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async planRepairProject(runtime: TextGeneratorRuntime): Promise<never> {
    this.planRepairAttempts += 1;
    const planSpec = buildPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 恢复后的分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 恢复后的详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);
    throw new Error("deepagents plan repair did not return a valid structured response.");
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Recovered Report\n\nHost recovered after missing structured response.\n",
    });

    return {
      summary: "生成阶段成功。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in StructuredResponseRecoveryTextGenerator");
  }
}

class MissingStructuredGenerateRetryTextGenerator implements TextGenerator {
  planAttempts = 0;
  generationAttempts = 0;
  generationRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    this.planAttempts += 1;
    const planSpec = buildRootDashboardPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
        ".workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generationAttempts += 1;

    if (this.generationAttempts === 1) {
      await writeFile(
        path.join(runtime.outputDirectory, "app-builder-report.md"),
        "# Partial Report\n\nInitial generation wrote only partial artifacts before losing structured output.\n",
        "utf8",
      );
      throw new Error("deepagents generation did not return a valid structured response.");
    }

    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Retried Report\n\nSame generate phase recovered after structured response retry.\n",
      extraFiles: [{ path: "generated/retry-marker.txt", contents: "same-stage-generate-retry\n" }],
    });

    return {
      summary: "生成阶段重试成功。",
      filesWritten: ["app-builder-report.md", "generated/retry-marker.txt"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    this.generationRepairAttempts += 1;
    throw new Error("generateRepairProject should not be called for a missing structured generate response before retry is exhausted");
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in MissingStructuredGenerateRetryTextGenerator");
  }
}

class GenerateStructuredResponseRecoveryTextGenerator implements TextGenerator {
  generationRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<never> {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Generated Report\n\nRecovered after missing structured response.\n",
    });
    throw new Error("deepagents generation did not return a valid structured response.");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    this.generationRepairAttempts += 1;
    throw new Error("generateRepairProject should not be called in GenerateStructuredResponseRecoveryTextGenerator");
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in GenerateStructuredResponseRecoveryTextGenerator");
  }
}

class GenerateRepairStructuredResponseRecoveryTextGenerator implements TextGenerator {
  generationRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(_planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Generation Report\n\nMissing planned outputs.\n",
      "utf8",
    );

    return {
      summary: "第一次生成没有覆盖全部计划定义。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: [],
      implementedPages: [],
      implementedApis: [],
      notes: [],
    };
  }

  async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<never> {
    this.generationRepairAttempts += 1;
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Generation Report\n\nRecovered during generate repair.\n",
    });
    throw new Error("deepagents generation repair did not return a valid structured response.");
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in GenerateRepairStructuredResponseRecoveryTextGenerator");
  }
}

class RetryingGenerationTextGenerator implements TextGenerator {
  planAttempts = 0;
  generationAttempts = 0;
  generationRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    this.planAttempts += 1;
    const planSpec = buildPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generationAttempts += 1;

    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Generation Report\n\nRetrying coverage.\n",
      "utf8",
    );

    if (this.generationAttempts === 1) {
      return {
        summary: "第一次生成没有覆盖全部计划定义。",
        filesWritten: ["app-builder-report.md"],
        implementedResources: [],
        implementedPages: [],
        implementedApis: [],
        notes: [],
      };
    }

    return {
      summary: "第一次生成没有覆盖全部计划定义。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: [],
      implementedPages: [],
      implementedApis: [],
      notes: [],
    };
  }

  async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generationRepairAttempts += 1;
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Generation Report\n\nRepair coverage.\n",
    });

    return {
      summary: "第二次生成已覆盖全部计划定义。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in RetryingGenerationTextGenerator");
  }
}

class RuntimeValidationRepairingTextGenerator implements TextGenerator {
  generationRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Generation Report\n\nInitial delivery.\n",
      extraFiles: [{ path: "generated/marker.txt", contents: "initial-runtime-validation\n" }],
    });

    return {
      summary: "生成阶段覆盖完整，等待宿主运行验证。",
      filesWritten: ["app-builder-report.md", "generated/marker.txt"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generationRepairAttempts += 1;
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Generation Report\n\nRuntime validation repaired.\n",
      extraFiles: [{ path: "generated/marker.txt", contents: "runtime-validation-repaired\n" }],
    });

    return {
      summary: "已修复运行验证问题。",
      filesWritten: ["app-builder-report.md", "generated/marker.txt"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in RuntimeValidationRepairingTextGenerator");
  }
}

class InteractiveRuntimeRepairingTextGenerator implements TextGenerator {
  generationRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 交互式运行验证分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 交互式运行验证规格\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Interactive Runtime Report\n\nInitial delivery.\n",
      extraFiles: [
        {
          path: "server.mjs",
          contents: [
            "console.error('Failed to compile: broken interactive page');",
            "setInterval(() => undefined, 1000);",
            "",
          ].join("\n"),
        },
      ],
    });

    return {
      summary: "生成阶段覆盖完整，但交互式 dev server 会输出错误。",
      filesWritten: ["app-builder-report.md", "server.mjs"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generationRepairAttempts += 1;
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Interactive Runtime Report\n\nRuntime interaction repaired.\n",
      extraFiles: [
        {
          path: "server.mjs",
          contents: [
            "import http from 'node:http';",
            "const port = Number(process.env.PORT);",
            "http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(port, '127.0.0.1');",
            "",
          ].join("\n"),
        },
      ],
    });

    return {
      summary: "交互式运行验证修复完成。",
      filesWritten: ["app-builder-report.md", "server.mjs"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in InteractiveRuntimeRepairingTextGenerator");
  }
}

class InteractiveRuntimeRepairingAfterGenerateRetryBudgetTextGenerator extends InteractiveRuntimeRepairingTextGenerator {
  initialDevServerPidWasRunningWhenRepairStarted: boolean | undefined;

  override async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Interactive Runtime Report\n\nInitial delivery.\n",
      extraFiles: [
        {
          path: "server.mjs",
          contents: [
            "import { writeFileSync } from 'node:fs';",
            "writeFileSync('dev-server.pid', String(process.pid));",
            "console.error(\"Error: Can't resolve 'tailwindcss' in '/tmp/generated-app'\");",
            "setInterval(() => undefined, 1000);",
            "",
          ].join("\n"),
        },
      ],
    });
    await writeFile(
      runtime.deepagentsErrorLogPath,
      [
        "[2026-05-07T00:00:00.000Z]",
        "Retry attempt 1 triggered for 生成修复阶段 because:",
        "- pre-existing generated artifact failure.",
        "",
        "[2026-05-07T00:00:01.000Z]",
        "Retry attempt 2 triggered for 生成修复阶段 because:",
        "- another pre-existing generated artifact failure.",
        "",
      ].join("\n"),
      { encoding: "utf8", flag: "a" },
    );

    return {
      summary: "生成阶段覆盖完整，但交互式 dev server 会输出模块解析错误。",
      filesWritten: ["app-builder-report.md", "server.mjs"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  override async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    const rawPid = await readFile(path.join(runtime.outputDirectory, "dev-server.pid"), "utf8").catch(() => "");
    const pid = Number(rawPid.trim());
    this.initialDevServerPidWasRunningWhenRepairStarted = Number.isInteger(pid) && pid > 0
      ? isPidRunning(pid)
      : undefined;
    return await super.generateRepairProject(planSpec, runtime);
  }
}

class LooseDeclarationTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(_planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await mkdir(path.join(runtime.outputDirectory, "app", "api", "work-orders"), { recursive: true });
    await mkdir(path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]"), { recursive: true });
    await writeFile(path.join(runtime.outputDirectory, "app-builder-report.md"), "# Report\n\nLoose declarations.\n", "utf8");
    await writeFile(
      path.join(runtime.outputDirectory, "app", "api", "work-orders", "route.ts"),
      "export async function GET() { return Response.json([]); }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );

    return {
      summary: "落盘完整，但结构化声明使用展示文案和操作名。",
      filesWritten: [
        "app-builder-report.md",
        "app/api/work-orders/route.ts",
        "app/(admin)/work-orders/page.tsx",
        "app/(admin)/work-orders/[id]/page.tsx",
      ],
      implementedResources: ["WorkOrder"],
      implementedPages: [
        "工单列表 (/work-orders)",
        "工单详情 (/work-orders/[id])",
      ],
      implementedApis: ["getWorkOrders", "createWorkOrder"],
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in LooseDeclarationTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in LooseDeclarationTextGenerator");
  }
}

class ApiOnlySupportResourceTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    planSpec.resources.push({
      name: "AuditLog",
      pluralName: "AuditLogs",
      routeSegment: "audit-logs",
      description: "系统审计日志。",
      fields: [
        { name: "id", label: "ID", type: "string", required: true, source: "assumption" },
        { name: "message", label: "消息", type: "string", required: true, source: "assumption" },
      ],
      relations: [],
    });
    planSpec.apis.push({
      name: "AuditLogCollection",
      resourceName: "AuditLog",
      path: "/app/api/audit-logs/route.ts",
      methods: ["GET"],
      requestShape: "分页查询参数。",
      responseShape: "审计日志列表。",
    });
    planSpec.acceptanceChecks.push({
      id: "resource-audit-log",
      description: "必须规划 AuditLog 资源。",
      type: "resource",
      target: "AuditLog",
    });
    planSpec.acceptanceChecks.push({
      id: "api-audit-log",
      description: "必须实现 AuditLog 集合接口。",
      type: "api",
      target: "/app/api/audit-logs/route.ts",
    });

    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段成功，包含仅暴露 API 的支持资源。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await mkdir(path.join(runtime.outputDirectory, "app", "api", "work-orders"), { recursive: true });
    await mkdir(path.join(runtime.outputDirectory, "app", "api", "audit-logs"), { recursive: true });
    await mkdir(path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]"), { recursive: true });
    await writeFile(path.join(runtime.outputDirectory, "app-builder-report.md"), "# Report\n\nAPI-only support resource.\n", "utf8");
    await writeFile(
      path.join(runtime.outputDirectory, "app", "api", "work-orders", "route.ts"),
      "export async function GET() { return Response.json([]); }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "api", "audit-logs", "route.ts"),
      "export async function GET() { return Response.json([]); }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );

    return {
      summary: "生成阶段成功。",
      filesWritten: [
        "app-builder-report.md",
        "app/api/work-orders/route.ts",
        "app/api/audit-logs/route.ts",
        "app/(admin)/work-orders/page.tsx",
        "app/(admin)/work-orders/[id]/page.tsx",
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: uniqueApiPaths(planSpec),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in ApiOnlySupportResourceTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in ApiOnlySupportResourceTextGenerator");
  }
}

class MisplacedArtifactTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    const misplacedDeepagentsDirectory = path.join(runtime.outputDirectory, "app", ".workspace");

    await mkdir(misplacedDeepagentsDirectory, { recursive: true });
    await writeFile(
      path.join(misplacedDeepagentsDirectory, "prd-analysis.md"),
      "# Misplaced 分析稿\n\nThis was incorrectly written beneath /app.\n",
      "utf8",
    );
    await writeFile(
      path.join(misplacedDeepagentsDirectory, "generated-spec.md"),
      "# Misplaced Spec\n\nThis was incorrectly written beneath /app.\n",
      "utf8",
    );
    await writeFile(
      path.join(misplacedDeepagentsDirectory, "plan-spec.json"),
      `${JSON.stringify(planSpec, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(misplacedDeepagentsDirectory, "interaction-contract.json"),
      `${JSON.stringify(buildValidInteractionContract(planSpec), null, 2)}\n`,
      "utf8",
    );

    return {
      summary: "Planner mistakenly wrote host artifacts under /app.",
      artifactsWritten: [
        "/app/.workspace/prd-analysis.md",
        "/app/.workspace/generated-spec.md",
        "/app/.workspace/plan-spec.json",
        "/app/.workspace/interaction-contract.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# Temporary Report\n\nWill be relocated.\n",
      extraFiles: [{ path: "generated/marker.txt", contents: "misplaced-artifacts-recovered\n" }],
    });
    await mkdir(path.join(runtime.outputDirectory, "app"), { recursive: true });
    await writeFile(
      path.join(runtime.outputDirectory, "app", "app-builder-report.md"),
      "# Misplaced Report\n\nThis was incorrectly written beneath /app.\n",
      "utf8",
    );
    await rm(path.join(runtime.outputDirectory, "app-builder-report.md"));

    return {
      summary: "Generator mistakenly wrote the report under /app.",
      filesWritten: [
        "/app/app-builder-report.md",
        "generated/marker.txt",
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in MisplacedArtifactTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in MisplacedArtifactTextGenerator");
  }
}

class RestSplitApiTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    planSpec.apis = [
      {
        name: "WorkOrderCollectionGet",
        resourceName: "WorkOrder",
        path: "/app/api/work-orders/route.ts",
        methods: ["GET"],
        requestShape: "分页查询参数。",
        responseShape: "工单列表。",
      },
      {
        name: "WorkOrderCollectionPost",
        resourceName: "WorkOrder",
        path: "/app/api/work-orders/route.ts",
        methods: ["POST"],
        requestShape: "创建工单对象。",
        responseShape: "新建工单对象。",
      },
    ];

    await writeFile(runtime.deepagentsAnalysisPath, "# REST Split 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# REST Split 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");
    await writeEmptyInteractionContract(runtime);

    return {
      summary: "计划阶段允许同一路径按 method 拆分接口。",
      artifactsWritten: [
        ".workspace/prd-analysis.md",
        ".workspace/generated-spec.md",
        ".workspace/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await writeImplementedProjectFiles({
      outputDirectory: runtime.outputDirectory,
      planSpec,
      reportContents: "# REST Split Report\n\nGeneration succeeded.\n",
    });

    return {
      summary: "生成阶段成功。",
      filesWritten: ["app-builder-report.md"],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: Array.from(new Set(planSpec.apis.map((api) => api.path))),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("planRepairProject should not be called in RestSplitApiTextGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<never> {
    throw new Error("generateRepairProject should not be called in RestSplitApiTextGenerator");
  }
}

test("generateApplication stages starter scaffold and split-phase artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generationRequirements: "菜单必须使用固定侧边栏，内容区独立滚动。",
      generator: new StubTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
    });

    assert.ok(result.files.includes("package.json"));
    assert.ok(result.files.includes("prisma.config.ts"));
    assert.ok(result.files.includes("prisma/schema.prisma"));
    assert.ok(result.files.includes("app-builder-report.md"));
    assert.ok(result.files.includes("generated/marker.txt"));

    const packageJson = await readFile(path.join(result.outputDirectory, "package.json"), "utf8");
    const gitHead = await readFile(path.join(result.outputDirectory, ".git/HEAD"), "utf8");
    const npmrc = await readFile(path.join(result.outputDirectory, ".npmrc"), "utf8");
    const gitignore = await readFile(path.join(result.outputDirectory, ".gitignore"), "utf8");
    const envExample = await readFile(path.join(result.outputDirectory, ".env.example"), "utf8");
    const prismaConfig = await readFile(path.join(result.outputDirectory, "prisma.config.ts"), "utf8");
    const schema = await readFile(path.join(result.outputDirectory, "prisma/schema.prisma"), "utf8");
    const seed = await readFile(path.join(result.outputDirectory, "prisma/seed.ts"), "utf8");
    const sidebarMenu = JSON.parse(
      await readFile(path.join(result.outputDirectory, "config/sidebar-menu.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    const templateLock = await readFile(path.join(result.outputDirectory, "template-lock.json"), "utf8");
    const stagedTemplateManifest = await readFile(
      path.join(result.outputDirectory, ".workspace/template.json"),
      "utf8",
    );
    const sessionAgents = await readFile(
      path.join(result.outputDirectory, ".workspace/AGENTS.md"),
      "utf8",
    );
    const planPromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-system-prompt.md"),
      "utf8",
    );
    const planRepairPromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-repair-system-prompt.md"),
      "utf8",
    );
    const generatePromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/generate-system-prompt.md"),
      "utf8",
    );
    const generateRepairPromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/generate-repair-system-prompt.md"),
      "utf8",
    );
    const sourcePrdSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/source-prd.md"),
      "utf8",
    );
    const analysisSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/prd-analysis.md"),
      "utf8",
    );
    const generatedSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/generated-spec.md"),
      "utf8",
    );
    const planSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-spec.json"),
      "utf8",
    );
    const planValidationSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-validation.json"),
      "utf8",
    );
    const generationValidationSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );
    const runtimeValidationLog = await readFile(
      path.join(result.outputDirectory, ".workspace/runtime-validation.log"),
      "utf8",
    );
    const metricsLog = await readFile(
      path.join(result.outputDirectory, ".workspace/metrics.jsonl"),
      "utf8",
    );
    const deepagentsConfig = await readFile(
      path.join(result.outputDirectory, ".workspace/config.json"),
      "utf8",
    );
    const stagedReference = await readFile(
      path.join(result.outputDirectory, ".workspace/references/generated-app-architecture.md"),
      "utf8",
    );

    const planSpec = JSON.parse(planSpecSnapshot) as PlanSpec;
    const metricRecords = metricsLog.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      version: number;
      sessionId: string;
      name: string;
      phase: string;
      status: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
    }>;
    const metricNames = metricRecords.map((record) => record.name);

    assert.match(packageJson, /"next"/);
    assert.match(gitHead, /ref: refs\/heads\/main/);
    assert.match(packageJson, /"db:init"/);
    assert.match(packageJson, /"@tailwindcss\/postcss"/);
    assert.match(npmrc, /workspaces=false/);
    assert.match(gitignore, /node_modules/);
    assert.match(envExample, /file:\.\/prisma\/dev\.db/);
    assert.match(prismaConfig, /schema: "prisma\/schema\.prisma"/);
    assert.match(prismaConfig, /const defaultDatabaseUrl = "file:\.\/prisma\/dev\.db"/);
    assert.match(prismaConfig, /process\.env\.DATABASE_URL \?\? defaultDatabaseUrl/);
    assert.match(schema, /provider = "sqlite"/);
    assert.doesNotMatch(schema, /url\s*=\s*env\("DATABASE_URL"\)/);
    assert.match(seed, /demo@example\.com/);
    assert.equal(sidebarMenu.length > 0, true);
    assert.equal(sidebarMenu.some((item) => item.label === "Workspace"), true);
    assert.match(templateLock, /"repairRetries": \{/);
    assert.match(templateLock, /"plan": 10/);
    assert.match(templateLock, /"generate": 10/);
    assert.match(templateLock, /"phases": \{/);
    assert.match(templateLock, /"plan": \{\s*"prompt": "prompts\/plan-system-prompt\.md"/);
    assert.match(templateLock, /"planRepair": \{[\s\S]*"prompt": "prompts\/plan-repair-system-prompt\.md"/);
    assert.match(templateLock, /"generate": \{[\s\S]*"prompt": "prompts\/generate-system-prompt\.md"/);
    assert.match(templateLock, /"generateRepair": \{[\s\S]*"prompt": "prompts\/generate-repair-system-prompt\.md"/);
    assert.match(templateLock, /"planRepair": \{[\s\S]*"effort": "high"/);
    assert.match(templateLock, /"generate": \{[\s\S]*"effort": "medium"/);
    assert.match(templateLock, /"environmentPolicy": \{[\s\S]*"lockedKeys": \[/);
    assert.match(templateLock, /"DATABASE_URL"/);
    assert.match(templateLock, /"projectConfigPolicy": \{[\s\S]*"guardedFiles": \[/);
    assert.match(templateLock, /"next\.config\.ts"/);
    assert.match(stagedTemplateManifest, /"repairRetries": \{/);
    assert.match(stagedTemplateManifest, /"environmentPolicy": \{/);
    assert.match(stagedTemplateManifest, /"projectConfigPolicy": \{/);
    assert.match(stagedTemplateManifest, /"phases": \{/);
    assert.match(stagedTemplateManifest, /"plan": \{\s*"prompt": "prompts\/plan-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"planRepair": \{[\s\S]*"prompt": "prompts\/plan-repair-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generate": \{[\s\S]*"prompt": "prompts\/generate-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generateRepair": \{[\s\S]*"prompt": "prompts\/generate-repair-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generateRepair": \{[\s\S]*"effort": "high"/);
    assert.match(sessionAgents, /# Host Session Policy/);
    assert.match(sessionAgents, /acceptanceChecks\.target/);
    assert.doesNotMatch(sessionAgents, /Do not delegate to child agents or task-style fanout tools/);
    assert.match(sessionAgents, /host may launch default backend, frontend, and integration subagents/);
    assert.match(sessionAgents, /prefer using `task` to launch additional bounded child agents/);
    assert.match(sessionAgents, /frontend, backend, and verification slices/);
    assert.match(sessionAgents, /main agent remains responsible for merging/);
    assert.match(planPromptSnapshot, /artifacts\.planSpec/);
    assert.match(planPromptSnapshot, /# Host Session Policy/);
    assert.match(planPromptSnapshot, /Current stage: Plan Stage/);
    assert.match(planPromptSnapshot, /唯一职责是把原始 PRD 收敛为一份可验证/);
    assert.match(planPromptSnapshot, /`sourcePrdMarkdown` 为主事实来源/);
    assert.match(planPromptSnapshot, /不要为了“确认一下”再次反复读取 `artifacts\.sourcePrd`/);
    assert.match(planRepairPromptSnapshot, /计划修复阶段代理/);
    assert.match(planRepairPromptSnapshot, /validationFailures/);
    assert.match(planRepairPromptSnapshot, /Current stage: Plan Repair Stage/);
    assert.match(generatePromptSnapshot, /当前输入中的 `planSpec` 是唯一事实来源/);
    assert.match(generatePromptSnapshot, /implementedResources/);
    assert.match(generatePromptSnapshot, /Current stage: Generate Stage/);
    assert.match(generatePromptSnapshot, /template\.runtimeValidation/);
    assert.match(generatePromptSnapshot, /默认运行验证模式是非交互式/);
    assert.match(generatePromptSnapshot, /非交互式、交互式和 smoke 三选一运行/);
    assert.match(generatePromptSnapshot, /Host-Enforced Project Config Guard/);
    assert.match(generatePromptSnapshot, /projectConfigChanges` is absent or empty/);
    assert.match(generatePromptSnapshot, /explicitly forbidden to create, modify, delete, rewrite/);
    assert.match(generatePromptSnapshot, /`next\.config\.ts`/);
    assert.match(generatePromptSnapshot, /do not add that declaration during generation/);
    assert.match(generateRepairPromptSnapshot, /生成修复阶段代理/);
    assert.match(generateRepairPromptSnapshot, /validationFailures/);
    assert.match(generateRepairPromptSnapshot, /runtimeValidationLog/);
    assert.match(generateRepairPromptSnapshot, /非交互式、交互式或 smoke 运行验证/);
    assert.match(generateRepairPromptSnapshot, /Current stage: Generate Repair Stage/);
    assert.match(sourcePrdSnapshot, /# Field Ops Planner/);
    assert.match(sourcePrdSnapshot, /## 用户补充生成要求/);
    assert.match(sourcePrdSnapshot, /菜单必须使用固定侧边栏，内容区独立滚动。/);
    assert.ok(sourcePrdSnapshot.indexOf("# Field Ops Planner") < sourcePrdSnapshot.indexOf("## 用户补充生成要求"));
    assert.match(analysisSnapshot, /# Stub 需求分析报告/);
    assert.match(generatedSpecSnapshot, /# Stub 实施详细设计规格书/);
    assert.equal(planSpec.version, 1);
    assert.equal(planSpec.resources[0]?.name, "WorkOrder");
    assert.equal(planSpec.apis[0]?.path, "/app/api/work-orders/route.ts");
    assert.match(planValidationSnapshot, /"valid": true/);
    assert.match(generationValidationSnapshot, /"valid": true/);
    assert.match(generationValidationSnapshot, /"name": "pnpm install"/);
    assert.match(generationValidationSnapshot, /"name": "pnpm db:init"/);
    assert.match(generationValidationSnapshot, /"name": "pnpm dev"/);
    assert.match(runtimeValidationLog, /=== pnpm install ===/);
    assert.match(runtimeValidationLog, /=== pnpm dev ===/);
    assert.match(deepagentsConfig, /"runtimeValidationLog": "\.workspace\/runtime-validation\.log"/);
    assert.match(deepagentsConfig, /"metricsLog": "\.workspace\/metrics\.jsonl"/);
    assert.ok(metricRecords.length >= 10);
    assert.ok(metricNames.includes("workspace.prepare"));
    assert.ok(metricNames.includes("template.load"));
    assert.ok(metricNames.includes("spec.parse_prd"));
    assert.ok(metricNames.includes("plan.project"));
    assert.ok(metricNames.includes("plan.validate_artifacts"));
    assert.ok(metricNames.includes("generate.project"));
    assert.ok(metricNames.includes("generate.validate_artifacts"));
    assert.ok(metricNames.includes("validation.non_interactive_complete"));
    assert.ok(metricRecords.every((record) => (
      record.version === 1 &&
      record.sessionId === result.sessionId &&
      record.status === "success" &&
      typeof record.startedAt === "string" &&
      typeof record.completedAt === "string" &&
      record.durationMs >= 0
    )));
    assert.match(deepagentsConfig, /"repairRetries": \{/);
    assert.match(deepagentsConfig, /"environmentPolicy": \{/);
    assert.match(deepagentsConfig, /"projectConfigPolicy": \{/);
    assert.match(deepagentsConfig, /"phases": \{/);
    assert.match(deepagentsConfig, /"plan": \{[\s\S]*"prompt": "prompts\/plan-system-prompt\.md"[\s\S]*"effort": "high"/);
    assert.doesNotMatch(deepagentsConfig, /\/Users\/aca\/dev\/app-builder-v2/);
    assert.doesNotMatch(stagedReference, /\/Users\/aca\/dev\/app-builder-v2/);
    assert.equal(result.files.some((file) => file.startsWith(".git/")), false);
    await assert.rejects(() => access(path.join(result.outputDirectory, ".workspace/normalized-spec.json")));
    await assert.rejects(() => access(path.join(result.outputDirectory, ".workspace/prompts")));
    await assert.rejects(() => access(path.join(result.outputDirectory, ".workspace/starter")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runtime env materializer replaces placeholder session secret", () => {
  const envExample = [
    "DATABASE_URL=\"file:./prisma/dev.db\"",
    "SESSION_SECRET=replace-this-with-a-long-random-string",
    "",
  ].join("\n");
  const env = materializeRuntimeEnv(envExample);

  assert.match(envExample, /^SESSION_SECRET=replace-this-with-a-long-random-string$/m);
  assert.match(env, /^SESSION_SECRET="[A-Za-z0-9_-]{32,}"$/m);
  assert.doesNotMatch(env, /replace-this-with-a-long-random-string/);
  assert.equal(materializeRuntimeEnv("DATABASE_URL=file:./dev.db\n"), "DATABASE_URL=file:./dev.db\n");
});


test("generateApplication resolves PRD API docs into local reference artifacts before planning", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-refs-"));
  const specPath = path.join(tempRoot, "weather-prd.md");
  const originalFetch = globalThis.fetch;
  const generator = new ConvertingReferenceTextGenerator();
  const rawHtml = "<html><body><h1>Weather Now</h1><code>GET /v7/weather/now</code><p>location,key</p></body></html>";

  try {
    await writeFile(
      specPath,
      [
        "# Weather Console",
        "",
        "Use the QWeather API documentation at https://dev.qweather.com/docs/api/weather/weather-now/ to implement realtime weather.",
        "",
      ].join("\n"),
      "utf8",
    );
    globalThis.fetch = (async () => new Response(
      rawHtml,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    )) as typeof fetch;

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const manifestPath = path.join(result.outputDirectory, ".workspace/references/reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ url: string; localPath?: string; retrievalStatus: string; contentType?: string }> };
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0]?.retrievalStatus, "downloaded");
    assert.equal(manifest.entries[0]?.url, "https://dev.qweather.com/docs/api/weather/weather-now/");
    assert.equal(manifest.entries[0]?.contentType, "text/html; charset=utf-8");
    assert.equal(generator.observedLocalReferences?.[0]?.localPath, manifest.entries[0]?.localPath);
    assert.equal(generator.observedConversionInput?.url, "https://dev.qweather.com/docs/api/weather/weather-now/");
    assert.equal(generator.observedConversionInput?.contentType, "text/html; charset=utf-8");
    assert.equal(generator.observedConversionInput?.body, rawHtml);
    assert.equal(generator.observedConversionRuntime?.sessionId, result.sessionId);

    const localPath = manifest.entries[0]?.localPath;
    assert.ok(localPath?.startsWith("/.workspace/references/external/"));
    assert.equal(path.extname(localPath!), ".md");
    assert.equal(generator.observedSpecExternalReferences?.[0]?.localPath, localPath);
    assert.equal(generator.observedSpecExternalReferences?.[0]?.retrievalStatus, "downloaded");
    assert.equal(await readFile(path.join(result.outputDirectory, localPath!.slice(1)), "utf8"), generator.convertedMarkdown);
    assert.equal(
      await readFile(
        path.join(
          result.outputDirectory,
          ".workspace/references/external/dev-qweather-com-docs-api-weather-weather-now.html",
        ),
        "utf8",
      ),
      rawHtml,
    );

    const planSpec = JSON.parse(await readFile(path.join(result.outputDirectory, ".workspace/plan-spec.json"), "utf8")) as PlanSpec;
    assert.equal(planSpec.references?.[0]?.localPath, localPath);
    assert.equal(planSpec.references?.[0]?.localPath, generator.observedLocalReferences?.[0]?.localPath);
    assert.equal(planSpec.references?.[0]?.retrievalStatus, "downloaded");
    assert.match(await readFile(path.join(result.outputDirectory, ".workspace/generated-spec.md"), "utf8"), new RegExp(localPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication blocks private-network external reference downloads", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-private-ref-"));
  const specPath = path.join(tempRoot, "private-ref-prd.md");
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  try {
    await writeFile(
      specPath,
      [
        "# Internal Notes App",
        "",
        "See http://127.0.0.1:1/private-notes for optional background notes.",
        "See http://[::1]:1/private-notes for optional IPv6 background notes.",
        "",
      ].join("\n"),
      "utf8",
    );
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called for private references");
    }) as typeof fetch;

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new StubTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
    });

    const manifestPath = path.join(result.outputDirectory, ".workspace/references/reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ url: string; retrievalStatus: string; error?: string }>;
    };

    assert.equal(fetchCalled, false);
    assert.equal(manifest.entries.length, 2);
    for (const entry of manifest.entries) {
      assert.equal(entry.retrievalStatus, "failed");
      assert.match(entry.error ?? "", /host is not allowed/);
    }
    assert.deepEqual(
      manifest.entries.map((entry) => entry.url).sort(),
      [
        "http://127.0.0.1:1/private-notes",
        "http://[::1]:1/private-notes",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication keeps downloaded references when Markdown conversion fails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-refs-conversion-fail-"));
  const specPath = path.join(tempRoot, "weather-prd.md");
  const originalFetch = globalThis.fetch;
  const generator = new FailingReferenceConversionTextGenerator();
  const rawHtml = "<html><body><h1>Weather Now</h1><code>GET /v7/weather/now</code><p>location,key</p></body></html>";

  try {
    await writeFile(
      specPath,
      [
        "# Weather Console",
        "",
        "Use API docs at https://docs.example.com/weather/api for weather endpoint parameters.",
        "",
      ].join("\n"),
      "utf8",
    );
    globalThis.fetch = (async () => new Response(
      rawHtml,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    )) as typeof fetch;

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const manifestPath = path.join(result.outputDirectory, ".workspace/references/reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ localPath?: string; retrievalStatus: string }> };
    const localPath = manifest.entries[0]?.localPath;

    assert.equal(manifest.entries[0]?.retrievalStatus, "downloaded");
    assert.ok(localPath?.startsWith("/.workspace/references/external/"));
    assert.equal(path.extname(localPath!), ".md");
    assert.equal(generator.observedLocalReferences?.[0]?.localPath, localPath);

    const convertedContents = await readFile(path.join(result.outputDirectory, localPath!.slice(1)), "utf8");
    assert.match(convertedContents, /Weather Now/);
    assert.match(convertedContents, /GET \/v7\/weather\/now/);
    assert.doesNotMatch(convertedContents, /<html|<body|<code/i);
    assert.equal(
      await readFile(path.join(result.outputDirectory, ".workspace/references/external/docs-example-com-weather-api.html"), "utf8"),
      rawHtml,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication falls back to stripped Markdown when custom generator cannot convert references", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-refs-fallback-"));
  const specPath = path.join(tempRoot, "weather-prd.md");
  const originalFetch = globalThis.fetch;
  const generator = new ReferenceAwareTextGenerator();

  try {
    await writeFile(
      specPath,
      [
        "# Weather Console",
        "",
        "Use API docs at https://docs.example.com/weather/api for weather endpoint parameters.",
        "",
      ].join("\n"),
      "utf8",
    );
    globalThis.fetch = (async () => new Response(
      [
        "<html>",
        "<head><style>.hidden{display:none}</style><script>window.noise = true;</script></head>",
        "<body><nav>Docs menu</nav><h1>Weather Now</h1><code>GET /v7/weather/now</code><p>location,key</p><footer>Copyright</footer></body>",
        "</html>",
      ].join(""),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    )) as typeof fetch;

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const manifestPath = path.join(result.outputDirectory, ".workspace/references/reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { entries: Array<{ localPath?: string; retrievalStatus: string }> };
    const localPath = manifest.entries[0]?.localPath;

    assert.equal(manifest.entries[0]?.retrievalStatus, "downloaded");
    assert.ok(localPath?.startsWith("/.workspace/references/external/"));
    assert.equal(path.extname(localPath!), ".md");
    assert.equal(generator.observedLocalReferences?.[0]?.localPath, localPath);

    const contents = await readFile(path.join(result.outputDirectory, localPath!.slice(1)), "utf8");
    assert.match(contents, /Weather Now/);
    assert.match(contents, /GET \/v7\/weather\/now/);
    assert.match(contents, /location,key/);
    assert.doesNotMatch(contents, /<html|<body|<code/i);
    assert.doesNotMatch(contents, /window\.noise|Docs menu|Copyright/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication converts multiple external references concurrently with stable manifest order", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-refs-concurrent-"));
  const specPath = path.join(tempRoot, "weather-prd.md");
  const originalFetch = globalThis.fetch;
  const generator = new MultiReferenceTextGenerator({ conversionDelayMs: 30 });
  const referenceUrls = [
    "https://docs.example.com/weather/current",
    "https://docs.example.com/weather/current?lang=en",
    "https://docs.example.com/weather/hourly",
    "https://docs.example.com/weather/daily",
    "https://docs.example.com/weather/alerts",
    "https://docs.example.com/weather/indices",
    "https://docs.example.com/weather/grid",
    "https://docs.example.com/weather/minutely",
    "https://docs.example.com/weather/air-quality",
    "https://docs.example.com/weather/geocode",
  ];

  try {
    await writeFile(
      specPath,
      [
        "# Weather Console",
        "",
        "Implement the app using these API docs:",
        ...referenceUrls.map((url, index) => `- API docs ${index + 1}: ${url}`),
        "",
      ].join("\n"),
      "utf8",
    );
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      const index = referenceUrls.indexOf(url);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, referenceUrls.length - index) * 2));
      return new Response(
        `<html><body><h1>Reference ${index + 1}</h1><p>${url}</p></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }) as typeof fetch;

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const manifestPath = path.join(result.outputDirectory, ".workspace/references/reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ url: string; localPath?: string; retrievalStatus: string }>;
    };
    const localPaths = manifest.entries.map((entry) => entry.localPath);

    assert.deepEqual(manifest.entries.map((entry) => entry.url), referenceUrls);
    assert.deepEqual(manifest.entries.map((entry) => entry.retrievalStatus), referenceUrls.map(() => "downloaded"));
    assert.equal(new Set(localPaths).size, referenceUrls.length);
    assert.equal(localPaths[0], "/.workspace/references/external/docs-example-com-weather-current.md");
    assert.equal(localPaths[1], "/.workspace/references/external/docs-example-com-weather-current-2.md");
    assert.equal(generator.maxConcurrentConversions <= 8, true);
    assert.equal(generator.maxConcurrentConversions > 1, true);
    assert.deepEqual(generator.observedLocalReferences?.map((reference) => reference.localPath), localPaths);

    const planSpec = JSON.parse(await readFile(path.join(result.outputDirectory, ".workspace/plan-spec.json"), "utf8")) as PlanSpec;
    assert.deepEqual(planSpec.references?.map((reference) => reference.localPath), localPaths);
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/references/external/docs-example-com-weather-current.html"), "utf8"),
      /Reference 1/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/references/external/docs-example-com-weather-current-2.html"), "utf8"),
      /Reference 2/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication runs reference conversion in parallel with PRD analysis before assembly", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-refs-split-plan-"));
  const specPath = path.join(tempRoot, "weather-prd.md");
  const originalFetch = globalThis.fetch;
  const generator = new SplitPlanReferenceTextGenerator();
  const referenceUrl = "https://docs.example.com/weather/assembly";

  try {
    await writeFile(
      specPath,
      [
        "# Weather Console",
        "",
        `Use API docs at ${referenceUrl} to implement weather endpoint parameters.`,
        "",
      ].join("\n"),
      "utf8",
    );
    globalThis.fetch = (async () => new Response(
      "<html><body><h1>Weather API</h1><code>GET /weather</code></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    )) as typeof fetch;

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const manifestPath = path.join(result.outputDirectory, ".workspace/references/reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ url: string; localPath?: string; retrievalStatus: string }>;
    };
    const localPath = manifest.entries[0]?.localPath;
    const planSpec = JSON.parse(await readFile(path.join(result.outputDirectory, ".workspace/plan-spec.json"), "utf8")) as PlanSpec;
    const generatedSpec = await readFile(path.join(result.outputDirectory, ".workspace/generated-spec.md"), "utf8");

    assert.equal(generator.planProjectCalled, false);
    assert.equal(manifest.entries[0]?.retrievalStatus, "downloaded");
    assert.equal(manifest.entries[0]?.url, referenceUrl);
    assert.ok(localPath);
    assert.match(generator.assemblyObservedAnalysis, /Parallel PRD Analysis/);
    assert.deepEqual(generator.assemblyObservedLocalReferences?.map((reference) => reference.localPath), [localPath]);
    assert.equal(planSpec.references?.[0]?.localPath, localPath);
    assert.match(generatedSpec, /Parallel PRD Analysis/);
    assert.match(generatedSpec, new RegExp(localPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    assert.equal(generator.analysisStartedAt > 0, true);
    assert.equal(generator.conversionStartedAt > 0, true);
    assert.equal(generator.analysisCompletedAt <= generator.assemblyStartedAt, true);
    assert.equal(generator.conversionCompletedAt <= generator.assemblyStartedAt, true);
    assert.equal(generator.analysisStartedAt < generator.conversionCompletedAt, true);
    assert.equal(generator.conversionStartedAt < generator.analysisCompletedAt, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication keeps long PRD analysis as a single full-input model call", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-long-prd-single-analysis-"));
  const specPath = path.join(tempRoot, "long-prd.md");
  const generator = new SplitPlanReferenceTextGenerator();
  const repeatedSections = Array.from({ length: 140 }, (_, index) => [
    `## Operations Area ${index + 1}`,
    "",
    `Role: dispatcher ${index + 1}.`,
    `Screen: operations dashboard ${index + 1}.`,
    `Flow: review incoming work orders, assign crews, capture status, and audit exceptions ${index + 1}.`,
    `Business rule: every assignment must keep region, skill, priority, SLA, and safety constraints visible ${index + 1}.`,
    `Entity: WorkOrder${index + 1} fields include title, region, priority, dueDate, status, owner, notes, and auditTrail.`,
    "",
  ].join("\n")).join("\n");

  try {
    await writeFile(
      specPath,
      [
        "# Large Operations Console",
        "",
        "Build an operations planning system for dispatch leaders.",
        "",
        repeatedSections,
      ].join("\n"),
      "utf8",
    );

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const analysis = await readFile(path.join(result.outputDirectory, ".workspace/prd-analysis.md"), "utf8");
    const metricRecords = (await readFile(path.join(result.outputDirectory, ".workspace/metrics.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name?: string });
    const metricNames = metricRecords.map((record) => record.name);

    assert.equal(generator.planProjectCalled, false);
    assert.ok(generator.analysisObservedSourceMarkdownLength > repeatedSections.length);
    assert.equal(metricNames.filter((name) => name === "plan.prd_analysis").length, 1);
    assert.equal(metricNames.includes("plan.prd_analysis_chunk"), false);
    assert.equal(metricNames.includes("plan.prd_analysis_merge"), false);
    assert.match(analysis, /# Parallel PRD Analysis/);
    assert.doesNotMatch(analysis, /Host assembled this analysis from/);
    await assert.rejects(
      access(path.join(result.outputDirectory, ".workspace/prd-analysis-chunks")),
      /ENOENT/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication retries split PRD analysis when structured response is missing before artifacts exist", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-prd-analysis-retry-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new FlakyPrdAnalysisTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const analysis = await readFile(path.join(result.outputDirectory, ".workspace/prd-analysis.md"), "utf8");
    const generatedSpec = await readFile(path.join(result.outputDirectory, ".workspace/generated-spec.md"), "utf8");
    const metricRecords = (await readFile(path.join(result.outputDirectory, ".workspace/metrics.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name?: string; status?: string });
    const prdAnalysisMetric = metricRecords.find((record) => record.name === "plan.prd_analysis");

    assert.equal(generator.analysisAttempts, 2);
    assert.match(analysis, /Parallel PRD Analysis/);
    assert.match(generatedSpec, /Parallel PRD Analysis/);
    assert.equal(prdAnalysisMetric?.status, "success");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication recovers split PRD analysis when artifact was written but structured response is malformed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-prd-analysis-recover-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new MalformedPrdAnalysisResponseTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const analysis = await readFile(path.join(result.outputDirectory, ".workspace/prd-analysis.md"), "utf8");
    const generatedSpec = await readFile(path.join(result.outputDirectory, ".workspace/generated-spec.md"), "utf8");

    assert.equal(generator.analysisAttempts, 2);
    assert.match(analysis, /Parallel PRD Analysis/);
    assert.match(generatedSpec, /Parallel PRD Analysis/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication can delegate initial generation to parallel agents behind the plan gate", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-parallel-generate-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new ParallelInitialGenerationTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const metricRecords = (await readFile(path.join(result.outputDirectory, ".workspace/metrics.jsonl"), "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name?: string });
    const metricNames = metricRecords.map((record) => record.name);

    assert.equal(generator.generateProjectCalled, false);
    assert.ok(generator.apiStartedAt > 0);
    assert.ok(generator.pageStartedAt > 0);
    assert.ok(generator.reportStartedAt > 0);
    assert.equal(generator.apiStartedAt < generator.pageCompletedAt, true);
    assert.equal(generator.pageStartedAt < generator.reportCompletedAt, true);
    assert.equal(generator.reportStartedAt < generator.apiCompletedAt, true);
    assert.ok(metricNames.includes("plan.validate_artifacts"));
    assert.ok(metricNames.includes("generate.parallel_project"));
    assert.ok(metricNames.includes("generate.validate_artifacts"));
    assert.equal(
      metricNames.indexOf("plan.validate_artifacts") < metricNames.indexOf("generate.parallel_project"),
      true,
    );
    assert.equal(await readFile(path.join(result.outputDirectory, "generated/parallel-marker.txt"), "utf8"), "parallel-generation-ran\n");
    assert.match(await readFile(path.join(result.outputDirectory, ".workspace/generation-validation.json"), "utf8"), /"valid": true/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication isolates reference download and conversion failures", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-refs-mixed-failures-"));
  const specPath = path.join(tempRoot, "weather-prd.md");
  const originalFetch = globalThis.fetch;
  const successUrl = "https://docs.example.com/weather/success";
  const conversionFailureUrl = "https://docs.example.com/weather/conversion-fails";
  const downloadFailureUrl = "https://example.invalid/broken";
  const generator = new MultiReferenceTextGenerator({
    conversionFailures: [conversionFailureUrl],
  });

  try {
    await writeFile(
      specPath,
      [
        "# Weather Console",
        "",
        `Use API docs at ${successUrl}.`,
        `Use API docs at ${conversionFailureUrl}.`,
        "",
        "## Inspiration",
        "",
        `See ${downloadFailureUrl} for an optional idea.`,
        "",
      ].join("\n"),
      "utf8",
    );
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
      if (url === downloadFailureUrl) {
        return new Response("missing", { status: 503, statusText: "Unavailable" });
      }

      return new Response(
        `<html><body><h1>${url === successUrl ? "Success" : "Fallback"}</h1><code>GET /weather</code></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }) as typeof fetch;

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const manifestPath = path.join(result.outputDirectory, ".workspace/references/reference-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{ url: string; localPath?: string; retrievalStatus: string; error?: string }>;
    };

    assert.deepEqual(manifest.entries.map((entry) => entry.url), [successUrl, conversionFailureUrl, downloadFailureUrl]);
    assert.deepEqual(manifest.entries.map((entry) => entry.retrievalStatus), ["downloaded", "downloaded", "failed"]);
    assert.match(manifest.entries[2]?.error ?? "", /HTTP 503 Unavailable/);
    assert.ok(manifest.entries[0]?.localPath);
    assert.ok(manifest.entries[1]?.localPath);
    assert.equal(manifest.entries[2]?.localPath, undefined);

    const successContents = await readFile(path.join(result.outputDirectory, manifest.entries[0]!.localPath!.slice(1)), "utf8");
    const fallbackContents = await readFile(path.join(result.outputDirectory, manifest.entries[1]!.localPath!.slice(1)), "utf8");
    assert.match(successContents, /Converted reference/);
    assert.match(fallbackContents, /Fallback/);
    assert.match(fallbackContents, /GET \/weather/);
    assert.doesNotMatch(fallbackContents, /<html|<body|<code/i);
    assert.deepEqual(
      generator.observedLocalReferences?.map((reference) => reference.retrievalStatus),
      ["downloaded", "downloaded", "failed"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication fails plan validation when required API docs cannot be downloaded", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-refs-fail-"));
  const specPath = path.join(tempRoot, "weather-prd.md");
  const originalFetch = globalThis.fetch;

  try {
    await writeFile(
      specPath,
      "# Weather Console\n\nUse API docs at https://docs.example.invalid/broken-weather-api for weather endpoint parameters.\n",
      "utf8",
    );
    globalThis.fetch = (async () => new Response("not found", { status: 404, statusText: "Not Found" })) as typeof fetch;

    await assert.rejects(
      () => generateApplication({
        specPath,
        outputDirectory: path.join(tempRoot, "output"),
        generator: new BrokenReferenceTextGenerator(),
        validator: new SuccessfulRuntimeValidator(),
      }),
      /Plan validation failed:.*必需参考资料下载失败.*https:\/\/docs\.example\.invalid\/broken-weather-api/s,
    );

    const validation = JSON.parse(await readFile(path.join(tempRoot, "output/.workspace/plan-validation.json"), "utf8")) as { valid: boolean; reasons: string[] };
    assert.equal(validation.valid, false);
    assert.match(validation.reasons.join("\n"), /必需参考资料下载失败/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication repairs mini-app .env.example when planSpec declares environment variables", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-env-vars-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new EnvRepairTextGenerator();
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
    });
    const templateDirectory = path.join(tempRoot, "templates", "mini-app");
    const manifestPath = path.join(templateDirectory, "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.starterDir = "starter";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(path.join(templateDirectory, "starter"), { recursive: true });
    await writeFile(
      path.join(templateDirectory, "starter", ".env.example"),
      "NEXT_PUBLIC_APP_NAME=Mini App\n",
      "utf8",
    );
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "mini-app",
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const envExample = await readFile(path.join(result.outputDirectory, ".env.example"), "utf8");
    const planSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-spec.json"),
      "utf8",
    );
    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.generateAttempts, 1);
    assert.equal(generator.repairAttempts, 0);
    assert.match(envExample, /^NEXT_PUBLIC_APP_NAME=Mini App$/m);
    assert.match(envExample, /^QWEATHER_API_KEY=e1499e17f3934df58273c9d4ea56bc54$/m);
    assert.match(envExample, /^QWEATHER_API_HOST=my6yw2bmj5.re.qweatherapi.com$/m);
    assert.match(planSpecSnapshot, /"environmentVariables": \[/);
    assert.match(generationValidation, /"valid": true/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication restores locked .env.example keys from the starter snapshot", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-env-lock-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new LockedEnvMutationTextGenerator();
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
    });
    const templateDirectory = path.join(tempRoot, "templates", "mini-app");
    const manifestPath = path.join(templateDirectory, "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.starterDir = "starter";
    manifest.environmentPolicy = {
      lockedKeys: ["DATABASE_URL", "NEXT_PUBLIC_APP_NAME"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(path.join(templateDirectory, "starter"), { recursive: true });
    await writeFile(
      path.join(templateDirectory, "starter", ".env.example"),
      [
        "DATABASE_URL=\"file:./prisma/dev.db\"",
        "NEXT_PUBLIC_APP_NAME=Mini App",
        "QWEATHER_API_KEY=starter-value",
        "",
      ].join("\n"),
      "utf8",
    );
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "mini-app",
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const envExample = await readFile(path.join(result.outputDirectory, ".env.example"), "utf8");
    const env = await readFile(path.join(result.outputDirectory, ".env"), "utf8");
    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.generateAttempts, 1);
    assert.match(envExample, /^DATABASE_URL="file:\.\/prisma\/dev\.db"$/m);
    assert.match(envExample, /^NEXT_PUBLIC_APP_NAME=Mini App$/m);
    assert.match(envExample, /^QWEATHER_API_KEY=e1499e17f3934df58273c9d4ea56bc54$/m);
    assert.match(envExample, /^QWEATHER_API_HOST=my6yw2bmj5\.re\.qweatherapi\.com$/m);
    assert.ok(envExample.indexOf("QWEATHER_API_KEY=") < envExample.indexOf("QWEATHER_API_HOST="));
    assert.doesNotMatch(envExample, /wrong\.db|Wrong App|QWEATHER_API_KEY=wrong/);
    assert.equal(env, envExample);
    assert.match(generationValidation, /"valid": true/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication fails plan validation when planSpec declares a locked env key", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-env-lock-conflict-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();
  const generator = new LockedEnvConflictTextGenerator();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
      planRepairRetries: 0,
    });
    const templateDirectory = path.join(tempRoot, "templates", "mini-app");
    const manifestPath = path.join(templateDirectory, "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.starterDir = "starter";
    manifest.environmentPolicy = {
      lockedKeys: ["DATABASE_URL"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(path.join(templateDirectory, "starter"), { recursive: true });
    await writeFile(
      path.join(templateDirectory, "starter", ".env.example"),
      "DATABASE_URL=\"file:./prisma/dev.db\"\n",
      "utf8",
    );
    process.chdir(tempRoot);

    await assert.rejects(
      () => generateApplication({
        specPath,
        outputDirectory: path.join(tempRoot, "output"),
        templateId: "mini-app",
        generator,
        validator: new SuccessfulRuntimeValidator(),
      }),
      /Plan validation failed:.*planSpec\.environmentVariables 不允许声明模板锁定的 \.env\.example 变量：DATABASE_URL/s,
    );

    const validation = JSON.parse(
      await readFile(path.join(tempRoot, "output", ".workspace/plan-validation.json"), "utf8"),
    ) as { valid: boolean; reasons: string[] };
    const envExample = await readFile(path.join(tempRoot, "output", ".env.example"), "utf8");

    assert.equal(generator.generateAttempts, 0);
    assert.equal(validation.valid, false);
    assert.match(
      validation.reasons.join("\n"),
      /计划阶段未完成：planSpec\.environmentVariables 不允许声明模板锁定的 \.env\.example 变量：DATABASE_URL/,
    );
    assert.match(envExample, /^DATABASE_URL="file:\.\/prisma\/dev\.db"$/m);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication removes locked env declarations during plan repair before generation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-env-lock-plan-repair-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();
  const generator = new LockedEnvPlanRepairTextGenerator();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
    });
    const templateDirectory = path.join(tempRoot, "templates", "mini-app");
    const manifestPath = path.join(templateDirectory, "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.starterDir = "starter";
    manifest.environmentPolicy = {
      lockedKeys: ["DATABASE_URL"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(path.join(templateDirectory, "starter"), { recursive: true });
    await writeFile(
      path.join(templateDirectory, "starter", ".env.example"),
      "DATABASE_URL=\"file:./prisma/dev.db\"\n",
      "utf8",
    );
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "mini-app",
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const planSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-spec.json"),
      "utf8",
    );
    const envExample = await readFile(path.join(result.outputDirectory, ".env.example"), "utf8");
    const planValidation = JSON.parse(
      await readFile(path.join(result.outputDirectory, ".workspace/plan-validation.json"), "utf8"),
    ) as { valid: boolean; reasons: string[] };
    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.planRepairAttempts, 1);
    assert.equal(generator.generateAttempts, 1);
    assert.match(generator.observedPlanRepairReasons.join("\n"), /DATABASE_URL/);
    assert.equal(planValidation.valid, true);
    assert.doesNotMatch(planSpecSnapshot, /"name": "DATABASE_URL"/);
    assert.match(planSpecSnapshot, /DATABASE_URL 使用 starter 默认值/);
    assert.match(envExample, /^DATABASE_URL="file:\.\/prisma\/dev\.db"$/m);
    assert.match(envExample, /^QWEATHER_API_KEY=e1499e17f3934df58273c9d4ea56bc54$/m);
    assert.doesNotMatch(envExample, /tenant\.db|wrong\.db/);
    assert.match(generationValidation, /"valid": true/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication fails generation validation when next.config.ts changes without PRD-backed project config declaration", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-next-config-guard-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
      generateRepairRetries: 0,
    });
    const templateDirectory = path.join(tempRoot, "templates", "mini-app");
    const manifestPath = path.join(templateDirectory, "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.starterDir = "starter";
    manifest.projectConfigPolicy = {
      guardedFiles: ["next.config.ts"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(path.join(templateDirectory, "starter"), { recursive: true });
    await writeFile(
      path.join(templateDirectory, "starter", "next.config.ts"),
      "import type { NextConfig } from \"next\";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n",
      "utf8",
    );
    process.chdir(tempRoot);

    await assert.rejects(
      () => generateApplication({
        specPath,
        outputDirectory: path.join(tempRoot, "output"),
        templateId: "mini-app",
        generator: new UnauthorizedNextConfigMutationTextGenerator(),
        validator: new SuccessfulRuntimeValidator(),
      }),
      /projectConfigChanges.*next\.config\.ts/s,
    );

    const generationValidation = await readFile(
      path.join(tempRoot, "output", ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.match(generationValidation, /受保护项目配置文件被修改/);
    assert.match(generationValidation, /next\.config\.ts/);
    assert.match(generationValidation, /projectConfigChanges/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication allows next.config.ts changes when planSpec declares PRD-backed project config change", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-next-config-declared-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
    });
    const templateDirectory = path.join(tempRoot, "templates", "mini-app");
    const manifestPath = path.join(templateDirectory, "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.starterDir = "starter";
    manifest.projectConfigPolicy = {
      guardedFiles: ["next.config.ts"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(path.join(templateDirectory, "starter"), { recursive: true });
    await writeFile(
      path.join(templateDirectory, "starter", "next.config.ts"),
      "import type { NextConfig } from \"next\";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n",
      "utf8",
    );
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "mini-app",
      generator: new AuthorizedNextConfigMutationTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
    });

    const planSpec = JSON.parse(
      await readFile(path.join(result.outputDirectory, ".workspace/plan-spec.json"), "utf8"),
    ) as PlanSpec;
    const nextConfig = await readFile(path.join(result.outputDirectory, "next.config.ts"), "utf8");
    const generatePrompt = await readFile(
      path.join(result.outputDirectory, ".workspace/generate-system-prompt.md"),
      "utf8",
    );
    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(planSpec.projectConfigChanges?.[0]?.filePath, "next.config.ts");
    assert.match(planSpec.projectConfigChanges?.[0]?.prdEvidence ?? "", /standalone/);
    assert.match(nextConfig, /output: "standalone"/);
    assert.doesNotMatch(generatePrompt, /Host-Enforced Project Config Guard/);
    assert.match(generationValidation, /"valid": true/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication rejects mini-app menu anchors that do not use next Link", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-mini-menu-link-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
      includeDevServerStep: false,
      generateRepairRetries: 0,
    });
    process.chdir(tempRoot);

    await assert.rejects(
      () => generateApplication({
        specPath,
        outputDirectory: path.join(tempRoot, "output"),
        templateId: "mini-app",
        generator: new MiniAppMenuAnchorTextGenerator(),
        validator: new SuccessfulRuntimeValidator(),
      }),
      /mini-app 菜单\/导航链接必须使用 next\/link 的 <Link href="\.\.\.">.*<a href="\.\.\.">/s,
    );

    const generationValidation = JSON.parse(
      await readFile(path.join(tempRoot, "output", ".workspace/generation-validation.json"), "utf8"),
    ) as { valid: boolean; reasons: string[] };

    assert.equal(generationValidation.valid, false);
    assert.match(generationValidation.reasons.join("\n"), /components\/AppMenu\.tsx:\d+/);
    assert.match(generationValidation.reasons.join("\n"), /禁止在菜单\/导航上下文中使用 <a href="\.\.\.">/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication retries the plan phase until plan-spec.json is valid", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-retry-plan-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new RetryingPlanTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
    });

    assert.equal(generator.planAttempts, 1);
    assert.equal(generator.planRepairAttempts, 1);
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/prd-analysis.md"), "utf8"),
      /重试后的分析稿/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/generated-spec.md"), "utf8"),
      /重试后的详细 Spec/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/plan-spec.json"), "utf8"),
      /"version": 1/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/error.log"), "utf8"),
      /artifacts\.planSpec|artifactsWritten/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication persists structured plan artifacts before plan validation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-structured-plan-spec-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new StructuredPlanSpecResultTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const persistedPlanSpecContents = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-spec.json"),
      "utf8",
    );
    const persistedPlanSpec = JSON.parse(persistedPlanSpecContents) as PlanSpec;
    const validation = validatePlanSpec(persistedPlanSpec);
    const persistedInteractionContractContents = await readFile(
      path.join(result.outputDirectory, ".workspace/interaction-contract.json"),
      "utf8",
    );
    const persistedInteractionContract = JSON.parse(persistedInteractionContractContents) as InteractionContract;
    const interactionValidation = validateInteractionContract(persistedInteractionContract);
    const planValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-validation.json"),
      "utf8",
    );

    assert.equal(validation.success, true);
    assert.equal(interactionValidation.success, true);
    assert.equal(persistedPlanSpec.appName, "Field Ops Planner");
    assert.doesNotMatch(persistedPlanSpecContents, /invalid stale plan spec/);
    assert.doesNotMatch(persistedInteractionContractContents, /invalid stale interaction contract/);
    assert.match(planValidation, /"valid": true/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication normalizes common plan-spec consistency errors before invoking plan repair", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-normalize-plan-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new NormalizingPlanTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
    });

    const normalizedPlanSpec = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-spec.json"),
      "utf8",
    );
    const planValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-validation.json"),
      "utf8",
    );

    assert.equal(generator.planRepairAttempts, 0);
    assert.match(planValidation, /"valid": true/);
    assert.match(normalizedPlanSpec, /"name": "Report"/);
    assert.match(normalizedPlanSpec, /"resourceName": "Report"/);
    assert.match(normalizedPlanSpec, /"target": "\/"/);
    assert.match(normalizedPlanSpec, /"target": "\/reports"/);
    assert.match(normalizedPlanSpec, /"target": "\/app\/api\/search-city\/route\.ts"/);
    assert.match(normalizedPlanSpec, /"target": "\/app\/api\/manage-history\/route\.ts"/);
    assert.doesNotMatch(normalizedPlanSpec, /"target": "Security"/);
    assert.doesNotMatch(normalizedPlanSpec, /"target": "searchCity"/);
    assert.doesNotMatch(normalizedPlanSpec, /"target": "manageHistory"/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication recovers when plan repair writes valid artifacts but misses the structured response", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-recover-plan-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new StructuredResponseRecoveryTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
    });

    const planValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-validation.json"),
      "utf8",
    );
    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.planRepairAttempts, 2);
    assert.match(planValidation, /"valid": true/);
    assert.match(generationValidation, /"valid": true/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication retries missing structured generate responses before entering repair", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-structured-generate-retry-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();
  const generator = new MissingStructuredGenerateRetryTextGenerator();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "mini-app",
      interactiveEnabled: false,
      includeDevServerStep: false,
    });
    const templateDirectory = path.join(tempRoot, "templates", "mini-app");
    const manifestPath = path.join(templateDirectory, "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.starterDir = "starter";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(path.join(templateDirectory, "starter", "app"), { recursive: true });
    await writeFile(
      path.join(templateDirectory, "starter", "app", "page.tsx"),
      [
        "export default function HomePage() {",
        "  return <main>Mini App Starter — Generated Mini App</main>;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(templateDirectory, "starter", ".env.example"), "NEXT_PUBLIC_APP_NAME=Mini App\n", "utf8");
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "mini-app",
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const pageSource = await readFile(path.join(result.outputDirectory, "app/(admin)/page.tsx"), "utf8");
    const retryMarker = await readFile(path.join(result.outputDirectory, "generated/retry-marker.txt"), "utf8");
    const errorLog = await readFile(path.join(result.outputDirectory, ".workspace/error.log"), "utf8");
    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.planAttempts, 1);
    assert.equal(generator.generationAttempts, 2);
    assert.equal(generator.generationRepairAttempts, 0);
    assert.match(pageSource, /return null/);
    assert.equal(retryMarker, "same-stage-generate-retry\n");
    assert.match(errorLog, /生成阶段结构化响应缺失，准备重试当前阶段第 1\/1 次/);
    assert.doesNotMatch(errorLog, /Retry attempt 1 triggered for 生成修复阶段/);
    assert.match(generationValidation, /"valid": true/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication recovers when generate phase writes valid artifacts but misses the structured response", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-recover-generate-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new GenerateStructuredResponseRecoveryTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
    });

    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.generationRepairAttempts, 0);
    assert.match(generationValidation, /"valid": true/);
    assert.match(
      await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"),
      /Recovered after missing structured response/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication recovers when generate repair writes valid artifacts but misses the structured response", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-recover-generate-repair-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new GenerateRepairStructuredResponseRecoveryTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
    });

    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.generationRepairAttempts, 2);
    assert.match(generationValidation, /"valid": true/);
    assert.match(
      await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"),
      /Recovered during generate repair/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication retries the generate phase without rerunning planning", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-retry-generate-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new RetryingGenerationTextGenerator();

  try {
    await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
    });

    assert.equal(generator.planAttempts, 1);
    assert.equal(generator.generationAttempts, 1);
    assert.equal(generator.generationRepairAttempts, 1);
    assert.match(
      await readFile(path.join(tempRoot, "output", ".workspace/error.log"), "utf8"),
      /尚未完整落盘：WorkOrder|尚未落盘：\/work-orders|尚未落盘：\/app\/api\/work-orders\/route\.ts/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication hands runtime validation failures back to generateRepairProject", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-runtime-validate-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new RuntimeValidationRepairingTextGenerator();
  const validator = new SequencedRuntimeValidator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
      validator,
    });

    assert.equal(generator.generationRepairAttempts, 1);
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/generation-validation.json"), "utf8"),
      /"name": "pnpm db:init"/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/generation-validation.json"), "utf8"),
      /"name": "pnpm dev"/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/runtime-validation.log"), "utf8"),
      /=== pnpm dev ===/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"),
      /Runtime validation repaired/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication can skip the final validation phase", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-skip-validation-"));
  const previousCwd = process.cwd();
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "interactive-skip-validation",
      interactiveEnabled: true,
      coverageThreshold: 1,
      idleTimeoutMs: 20,
    });
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "interactive-skip-validation",
      generator: new StubTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
      skipValidation: true,
    });

    const config = JSON.parse(
      await readFile(path.join(result.outputDirectory, ".workspace/config.json"), "utf8"),
    ) as { workflow?: { phase?: string; completedPhases?: string[] } };
    assert.equal(config.workflow?.phase, "complete");
    assert.deepEqual(config.workflow?.completedPhases, ["plan", "generate"]);
    await assert.rejects(() => access(path.join(result.outputDirectory, ".workspace/runtime-interaction-validation.json")));
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication runs enabled interactive validation and repairs inside validation phase", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-orchestration-"));
  const previousCwd = process.cwd();
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new InteractiveRuntimeRepairingTextGenerator();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "interactive-runtime",
      interactiveEnabled: true,
      coverageThreshold: 0,
      idleTimeoutMs: 20,
      readyTimeoutMs: 1_000,
      serverCommand: process.execPath,
      serverArgs: ["server.mjs"],
    });
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "interactive-runtime",
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const interactionArtifact = await readFile(
      path.join(result.outputDirectory, ".workspace/runtime-interaction-validation.json"),
      "utf8",
    );
    const runtimeLog = await readFile(
      path.join(result.outputDirectory, ".workspace/runtime-validation.log"),
      "utf8",
    );
    const config = await readFile(path.join(result.outputDirectory, ".workspace/config.json"), "utf8");

    assert.equal(generator.generationRepairAttempts, 1);
    assert.match(interactionArtifact, /"valid": true/);
    assert.match(runtimeLog, /interactive runtime validation/);
    assert.match(await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"), /Runtime interaction repaired/);
    assert.match(config, /"phase": "complete"/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication repairs first interactive runtime failure even when generate retry limit is zero", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-runtime-zero-retry-"));
  const previousCwd = process.cwd();
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new InteractiveRuntimeRepairingTextGenerator();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "interactive-runtime-zero-retry",
      interactiveEnabled: true,
      coverageThreshold: 0,
      idleTimeoutMs: 20,
      readyTimeoutMs: 1_000,
      serverCommand: process.execPath,
      serverArgs: ["server.mjs"],
      generateRepairRetries: 0,
    });
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "interactive-runtime-zero-retry",
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const errorLog = await readFile(path.join(result.outputDirectory, ".workspace/error.log"), "utf8");
    const interactionArtifact = await readFile(
      path.join(result.outputDirectory, ".workspace/runtime-interaction-validation.json"),
      "utf8",
    );

    assert.equal(generator.generationRepairAttempts, 1);
    assert.match(errorLog, /Retry attempt 1 triggered for 运行验证修复阶段/);
    assert.match(interactionArtifact, /"valid": true/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication stops failing interactive dev server and repairs even after generate retry budget was used", async (context) => {
  if (!await canListenOnLocalhost()) {
    context.skip("local port binding is not available in this sandbox");
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-interactive-runtime-budget-"));
  const previousCwd = process.cwd();
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new InteractiveRuntimeRepairingAfterGenerateRetryBudgetTextGenerator();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "interactive-runtime-budget",
      interactiveEnabled: true,
      coverageThreshold: 0,
      idleTimeoutMs: 20,
      readyTimeoutMs: 1_000,
      serverCommand: process.execPath,
      serverArgs: ["server.mjs"],
    });
    process.chdir(tempRoot);

    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "interactive-runtime-budget",
      generator,
      validator: new SuccessfulRuntimeValidator(),
    });

    const errorLog = await readFile(path.join(result.outputDirectory, ".workspace/error.log"), "utf8");
    const interactionArtifact = await readFile(
      path.join(result.outputDirectory, ".workspace/runtime-interaction-validation.json"),
      "utf8",
    );

    assert.equal(generator.generationRepairAttempts, 1);
    assert.equal(generator.initialDevServerPidWasRunningWhenRepairStarted, false);
    assert.match(errorLog, /Retry attempt 1 triggered for 运行验证修复阶段/);
    assert.match(interactionArtifact, /"valid": true/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication validates generated coverage from actual files instead of decorative declarations", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-loose-declarations-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new LooseDeclarationTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
    });

    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/generation-validation.json"), "utf8"),
      /"valid": true/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication ignores dedicated page/api coverage for indirect resources", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-indirect-resource-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new IndirectResourceTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
    });

    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.match(generationValidation, /"valid": true/);
    assert.doesNotMatch(generationValidation, /HourlyForecast/);
    assert.doesNotMatch(generationValidation, /DailyForecast/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication accepts colon-style page routes when files are written with Next dynamic segments", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-colon-route-pages-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new ColonRouteTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
    });

    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.match(generationValidation, /"valid": true/);
    assert.doesNotMatch(generationValidation, /\/alarms\/:source_Path/);
    assert.doesNotMatch(generationValidation, /\/workorders\/:id/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication accepts plan pages written under arbitrary App Router route groups", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-main-route-group-pages-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      templateId: "mini-app",
      generator: new MainRouteGroupTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
      runtimeValidationMode: "non-interactive",
    });

    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".workspace/generation-validation.json"),
      "utf8",
    );

    assert.match(generationValidation, /"valid": true/);
    assert.doesNotMatch(generationValidation, /\/plants/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication allows API-only support resources during plan validation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-api-only-resource-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new ApiOnlySupportResourceTextGenerator(),
      validator: new SuccessfulRuntimeValidator(),
    });

    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/plan-validation.json"), "utf8"),
      /"valid": true/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace/generation-validation.json"), "utf8"),
      /"valid": true/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication relocates host artifacts that were mistakenly written under app", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-misplaced-artifacts-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new MisplacedArtifactTextGenerator(),
    });

    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace", "prd-analysis.md"), "utf8"),
      /Misplaced 分析稿/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace", "generated-spec.md"), "utf8"),
      /Misplaced Spec/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".workspace", "plan-spec.json"), "utf8"),
      /"version": 1/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"),
      /Misplaced Report/,
    );
    await assert.rejects(() =>
      access(path.join(result.outputDirectory, "app", ".workspace", "plan-spec.json")),
    );
    await assert.rejects(() =>
      access(path.join(result.outputDirectory, "app", "app-builder-report.md")),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication accepts REST APIs split by method under the same route path", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-rest-split-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new RestSplitApiTextGenerator(),
    });

    const planValidationSnapshot = await readFile(
      path.join(result.outputDirectory, ".workspace/plan-validation.json"),
      "utf8",
    );

    assert.match(planValidationSnapshot, /"valid": true/);
    assert.doesNotMatch(planValidationSnapshot, /重复的 path/);
    assert.doesNotMatch(planValidationSnapshot, /重复的 path\+method/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("full-stack template starter copies scaffold files into the output root", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-starter-"));

  try {
    const template = await loadTemplatePack("full-stack");
    const copied = await copyStarterScaffold(template, tempRoot);

    assert.match(template.description ?? "", /SQLite/);
    assert.equal(template.phases.plan.effort, "high");
    assert.equal(template.phases.generate.effort, "medium");
    assert.equal(template.phases.generateRepair.effort, "high");
    assert.deepEqual(template.environmentPolicy.lockedKeys, ["DATABASE_URL", "APP_URL", "SESSION_SECRET"]);
    assert.deepEqual(template.projectConfigPolicy.guardedFiles, ["next.config.ts"]);
    assert.ok(copied.includes("package.json"));
    assert.ok(copied.includes("prisma.config.ts"));
    assert.ok(copied.includes("app/layout.tsx"));
    assert.ok(copied.includes("lib/session.ts"));
    assert.ok(copied.includes("prisma/schema.prisma"));
    assert.ok(copied.includes("prisma/seed.ts"));
    assert.ok(copied.includes("config/sidebar-menu.json"));

    const starterPackage = await readFile(path.join(tempRoot, "package.json"), "utf8");
    const starterNextConfigTs = await readFile(path.join(tempRoot, "next.config.ts"), "utf8");
    const starterNextConfigJs = await readFile(path.join(tempRoot, "next.config.js"), "utf8");
    const starterLayout = await readFile(path.join(tempRoot, "app/layout.tsx"), "utf8");
    const starterEnv = await readFile(path.join(tempRoot, ".env.example"), "utf8");
    const starterPrismaConfig = await readFile(path.join(tempRoot, "prisma.config.ts"), "utf8");
    const starterSchema = await readFile(path.join(tempRoot, "prisma/schema.prisma"), "utf8");
    const starterMenu = JSON.parse(
      await readFile(path.join(tempRoot, "config/sidebar-menu.json"), "utf8"),
    ) as Array<Record<string, unknown>>;

    assert.match(starterPackage, /"next"/);
    assert.match(starterPackage, /"db:init"/);
    assert.match(starterPackage, /"@tailwindcss\/postcss"/);
    assert.match(starterNextConfigTs, /allowedDevOrigins:\s*\["127\.0\.0\.1", "localhost"\]/);
    assert.doesNotMatch(starterNextConfigTs, /turbopack:\s*\{/);
    assert.doesNotMatch(starterNextConfigTs, /root:\s*__dirname/);
    assert.match(starterNextConfigJs, /allowedDevOrigins:\s*\["127\.0\.0\.1", "localhost"\]/);
    assert.doesNotMatch(starterNextConfigJs, /turbopack:\s*\{/);
    assert.doesNotMatch(starterNextConfigJs, /root:\s*__dirname/);
    assert.match(starterLayout, /Generated App/);
    assert.match(starterEnv, /file:\.\/prisma\/dev\.db/);
    assert.match(starterPrismaConfig, /defineConfig/);
    assert.match(starterPrismaConfig, /file:\.\/prisma\/dev\.db/);
    assert.match(starterSchema, /provider = "sqlite"/);
    assert.doesNotMatch(starterSchema, /url\s*=\s*env\("DATABASE_URL"\)/);
    assert.equal(Array.isArray(starterMenu), true);
    assert.equal(starterMenu.some((item) => item.label === "Dashboard"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("root designs include Spotify design document and mini-app starter does not bundle it", async () => {
  const designSource = await readFile(
    path.resolve(process.cwd(), "designs/Spotify.md"),
    "utf8",
  );

  assert.match(designSource, /Design System/);
  assert.match(designSource, /Color|Palette|Theme/i);
  assert.ok(designSource.trim().length > 200);
  await assert.rejects(
    () => access(path.resolve(process.cwd(), "templates/mini-app/starter/DESIGN.md")),
    /ENOENT/,
  );
});

test("AdminPanel design defines selected sidebar menu styling", async () => {
  const designSource = await readFile(
    path.resolve(process.cwd(), "designs/AdminPanel.md"),
    "utf8",
  );

  assert.match(designSource, /### Sidebar Menu/);
  assert.match(designSource, /\*\*Selected menu item\*\*/);
  assert.match(designSource, /4px left accent bar in `\{colors\.primary\}`/);
  assert.match(designSource, /\*\*Independent menu scroll\*\*/);
  assert.match(designSource, /scroll within the menu area only/);
  assert.match(designSource, /\*\*Sidebar scrollbar styling\*\*/);
  assert.match(designSource, /transparent or `\{colors\.secondary\}` track/);
  assert.match(designSource, /`rgba\(255,255,255,0\.22\)` with hover `rgba\(255,255,255,0\.34\)`/);
  assert.match(designSource, /\*\*Current user block\*\*/);
  assert.match(designSource, /dedicated bottom area outside the scrollable menu list/);
  assert.match(designSource, /`aria-current="page"`/);
});

test("template prompts delegate shell validation to the host", async () => {
  for (const templateId of ["mini-app", "full-stack"] as const) {
    const template = await loadTemplatePack(templateId);
    const promptPaths = [
      template.planPromptPath,
      template.planRepairPromptPath,
      template.generatePromptPath,
      template.generateRepairPromptPath,
    ];

    for (const promptPath of promptPaths) {
      const prompt = await readFile(promptPath, "utf8");
      assert.match(prompt, /## 验证边界/);
      assert.match(prompt, /不要生成、建议或执行 shell 命令/);
      assert.match(prompt, /验证全部由 host 在阶段结束后负责/);
      assert.match(prompt, /不要把 shell 验证命令写入 todo、报告或最终响应/);
    }
  }
});

test("template generation prompts encourage bounded parallel subagents", async () => {
  for (const templateId of ["mini-app", "full-stack"] as const) {
    const template = await loadTemplatePack(templateId);
    const promptPaths = [template.generatePromptPath, template.generateRepairPromptPath];

    for (const promptPath of promptPaths) {
      const prompt = await readFile(promptPath, "utf8");
      assert.match(prompt, /鼓励.*subagent|鼓励.*子代理/);
      assert.match(prompt, /`task`/);
      assert.match(prompt, /启动.*subagent|启动子代理/);
      assert.match(prompt, /frontend-|frontend/);
      assert.match(prompt, /backend-|backend/);
      assert.match(prompt, /integration-verifier/);
      assert.match(prompt, /不重叠的文件路径或职责边界/);
      assert.match(prompt, /不得.*shell 验证命令/);
    }
  }
});

test("template prompts guard next.config.ts edits behind PRD-backed project config declarations", async () => {
  for (const templateId of ["mini-app", "full-stack"] as const) {
    const template = await loadTemplatePack(templateId);
    const planPrompts = [template.planPromptPath, template.planRepairPromptPath];
    const generationPrompts = [template.generatePromptPath, template.generateRepairPromptPath];

    for (const promptPath of planPrompts) {
      const prompt = await readFile(promptPath, "utf8");
      assert.match(prompt, /next\.config\.ts/);
      assert.match(prompt, /template\.projectConfigPolicy\.guardedFiles/);
      assert.match(prompt, /planSpec\.projectConfigChanges/);
      assert.match(prompt, /prdEvidence/);
      assert.match(prompt, /PRD.*明确/s);
      assert.match(prompt, /项目配置/);
    }

    for (const promptPath of generationPrompts) {
      const prompt = await readFile(promptPath, "utf8");
      assert.match(prompt, /next\.config\.ts/);
      assert.match(prompt, /planSpec\.projectConfigChanges/);
      assert.match(prompt, /filePath: "next\.config\.ts"/);
      assert.match(prompt, /不得创建、修改、删除、重写 `next\.config\.ts`/);
      assert.match(prompt, /不得把它列入 `filesWritten`/);
    }
  }
});

test("mini-app template enables interactive runtime validation", async () => {
  const template = await loadTemplatePack("mini-app");
  const planPrompt = await readFile(template.planPromptPath, "utf8");
  const planRepairPrompt = await readFile(template.planRepairPromptPath, "utf8");
  const generatePrompt = await readFile(template.generatePromptPath, "utf8");

  assert.equal(template.phases.plan.effort, "max");
  assert.equal(template.phases.planRepair.effort, "max");
  assert.equal(template.phases.generate.effort, "max");
  assert.equal(template.phases.generateRepair.effort, "max");
  assert.equal(template.skillsDirectory, path.join(process.cwd(), "templates/mini-app/skills"));
  assert.match(planPrompt, /模板技能调用/);
  assert.match(planPrompt, /`protocol-analysis`/);
  assert.match(planPrompt, /`prd-assembly`/);
  assert.match(planRepairPrompt, /模板技能调用/);
  assert.match(planRepairPrompt, /`protocol-analysis`/);
  assert.match(planRepairPrompt, /`prd-assembly`/);
  assert.match(generatePrompt, /SQLite 数据库路径必须/);
  assert.match(generatePrompt, /`\/\.env`/);
  assert.match(generatePrompt, /`\/\.env\.example`/);
  assert.match(generatePrompt, /`\.\/lib\/prisma\.ts`/);
  assert.match(generatePrompt, /defaultDatabaseUrl/);
  await access(path.join(template.skillsDirectory ?? "", "protocol-analysis/SKILL.md"));
  await access(path.join(template.skillsDirectory ?? "", "prd-assembly/SKILL.md"));
  assert.equal(template.interactiveRuntimeValidation.enabled, true);
  assert.equal(template.interactiveRuntimeValidation.coverageThreshold, 0.8);
  assert.equal(template.interactiveRuntimeValidation.idleTimeoutMs, 10_000);
  assert.equal(template.interactiveRuntimeValidation.readyTimeoutMs, 90_000);
  assert.equal(template.interactiveRuntimeValidation.devServerStep?.name, "pnpm dev");
  assert.equal(template.interactiveRuntimeValidation.devServerStep?.command, "pnpm");
  assert.deepEqual(template.interactiveRuntimeValidation.devServerStep?.args, ["dev"]);
  assert.deepEqual(template.environmentPolicy.lockedKeys, [
    "DATABASE_URL",
    "NEXT_PUBLIC_APP_NAME",
    "SYSTEM_USER_EMAIL",
    "SYSTEM_USER_PASSWORD",
  ]);
  assert.deepEqual(template.projectConfigPolicy.guardedFiles, ["next.config.ts"]);

  const nextConfig = await readFile(path.join(template.starterDirectory ?? "", "next.config.ts"), "utf8");
  assert.match(nextConfig, /allowedDevOrigins:\s*\["127\.0\.0\.1", "localhost"\]/);
  assert.match(nextConfig, /turbopack:\s*\{/);
  assert.match(nextConfig, /root:\s*path\.resolve\(process\.cwd\(\)\)/);
});

test("loadTemplatePack parses enabled interactive runtime validation defaults", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-template-interactive-"));
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "interactive-template",
      interactiveEnabled: true,
    });
    process.chdir(tempRoot);

    const template = await loadTemplatePack("interactive-template");

    assert.equal(template.interactiveRuntimeValidation.enabled, true);
    assert.equal(template.interactiveRuntimeValidation.coverageThreshold, 0.8);
    assert.equal(template.interactiveRuntimeValidation.idleTimeoutMs, 10_000);
    assert.equal(template.interactiveRuntimeValidation.readyTimeoutMs, 90_000);
    assert.equal(template.interactiveRuntimeValidation.devServerStep?.name, "node dev server");
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("loadTemplatePack parses and validates template environment policy", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-template-env-policy-"));
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "env-policy-template",
      interactiveEnabled: false,
    });
    const manifestPath = path.join(tempRoot, "templates", "env-policy-template", "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.environmentPolicy = {
      lockedKeys: ["DATABASE_URL", "NEXT_PUBLIC_APP_NAME"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.chdir(tempRoot);

    const template = await loadTemplatePack("env-policy-template");

    assert.deepEqual(template.environmentPolicy.lockedKeys, ["DATABASE_URL", "NEXT_PUBLIC_APP_NAME"]);

    manifest.environmentPolicy = { lockedKeys: "DATABASE_URL" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => loadTemplatePack("env-policy-template"),
      /environmentPolicy\.lockedKeys.*array of strings/,
    );

    manifest.environmentPolicy = { lockedKeys: ["DATABASE_URL", ""] };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => loadTemplatePack("env-policy-template"),
      /environmentPolicy\.lockedKeys\[1\].*non-empty string/,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("loadTemplatePack parses and validates template project config policy", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-template-config-policy-"));
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "config-policy-template",
      interactiveEnabled: false,
    });
    const manifestPath = path.join(tempRoot, "templates", "config-policy-template", "template.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.projectConfigPolicy = {
      guardedFiles: ["./next.config.ts", "next.config.ts"],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.chdir(tempRoot);

    const template = await loadTemplatePack("config-policy-template");

    assert.deepEqual(template.projectConfigPolicy.guardedFiles, ["next.config.ts"]);

    manifest.projectConfigPolicy = { guardedFiles: "next.config.ts" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => loadTemplatePack("config-policy-template"),
      /projectConfigPolicy\.guardedFiles.*array of strings/,
    );

    manifest.projectConfigPolicy = { guardedFiles: ["next.config.ts", ""] };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => loadTemplatePack("config-policy-template"),
      /projectConfigPolicy\.guardedFiles\[1\].*non-empty string/,
    );

    manifest.projectConfigPolicy = { guardedFiles: ["../next.config.ts"] };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => loadTemplatePack("config-policy-template"),
      /projectConfigPolicy\.guardedFiles\[0\].*workspace-relative file path/,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("loadTemplatePack rejects enabled interactive validation without a dev server step", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-template-interactive-invalid-"));
  const previousCwd = process.cwd();

  try {
    await writeMinimalTemplatePack({
      root: tempRoot,
      id: "interactive-template-invalid",
      interactiveEnabled: true,
      includeDevServerStep: false,
    });
    process.chdir(tempRoot);

    await assert.rejects(
      () => loadTemplatePack("interactive-template-invalid"),
      /interactiveRuntimeValidation\.enabled.+kind "dev-server"/,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication creates a session workspace under .out by default", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-session-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();

  process.chdir(tempRoot);

  try {
    const result = await generateApplication({
      specPath,
      generator: new StubTextGenerator(),
    });

    assert.match(result.outputDirectory, /[\\/]\.out[\\/][^\\/]+$/);
    assert.equal(path.basename(result.outputDirectory), result.sessionId);

    const workspaceConfig = await readFile(
      path.join(result.outputDirectory, WORKSPACE_DIR_NAME, "config.json"),
      "utf8",
    );
    const outputEntries = await readdir(result.outputDirectory);

    assert.match(workspaceConfig, new RegExp(result.sessionId));
    assert.match(workspaceConfig, /"phase": "complete"/);
    assert.match(workspaceConfig, /"completedPhases": \[/);
    assert.equal(outputEntries.includes(WORKSPACE_DIR_NAME), true);
    assert.equal(outputEntries.includes(LEGACY_WORKSPACE_DIR_NAME), false);
    assert.equal(outputEntries.includes(".git"), true);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepareOutputWorkspace creates the host workspace artifact contract", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-workspace-contract-"));
  const outputDirectory = path.join(tempRoot, "generated-app");

  try {
    const workspace = await prepareOutputWorkspace({ outputDirectory });
    const artifacts = createWorkspaceArtifactPaths(outputDirectory);
    const outputEntries = await readdir(outputDirectory);
    const workspaceEntries = await readdir(artifacts.workspaceDirectory);

    assert.equal(workspace.deepagentsDirectory, artifacts.workspaceDirectory);
    assert.equal(workspace.deepagentsPlanSpecPath, artifacts.planSpecPath);
    assert.equal(workspace.deepagentsRuntimeValidationLogPath, artifacts.runtimeValidationLogPath);
    assert.equal(outputEntries.includes(WORKSPACE_DIR_NAME), true);
    assert.equal(outputEntries.includes(LEGACY_WORKSPACE_DIR_NAME), false);
    assert.equal(workspaceEntries.includes("AGENTS.md"), true);
    assert.equal(workspaceEntries.includes("references"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepareOutputWorkspace force clears stale output contents", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-workspace-force-"));
  const outputDirectory = path.join(tempRoot, "generated-app");

  try {
    await mkdir(path.join(outputDirectory, "stale"), { recursive: true });
    await writeFile(path.join(outputDirectory, "stale", "old.txt"), "old\n", "utf8");

    const workspace = await prepareOutputWorkspace({ outputDirectory, force: true });
    const outputEntries = await readdir(outputDirectory);

    assert.equal(outputEntries.includes("stale"), false);
    assert.equal(outputEntries.includes(WORKSPACE_DIR_NAME), true);
    assert.equal(outputEntries.includes(".git"), true);
    assert.equal(workspace.outputDirectory, outputDirectory);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateSessionPhase rejects legacy .deepagents-only sessions without migration", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-legacy-workspace-"));
  const sessionId = "legacy-session";
  const outputDirectory = path.join(tempRoot, ".out", sessionId);
  const legacyDirectory = path.join(outputDirectory, LEGACY_WORKSPACE_DIR_NAME);

  try {
    await mkdir(legacyDirectory, { recursive: true });

    await assert.rejects(
      () => validateSessionPhase({ sessionId, cwd: tempRoot, generator: new StubTextGenerator() }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /legacy \.deepagents workspace/);
        assert.match(error.message, /\.workspace/);
        assert.match(error.message, /automatic legacy workspace migration is not supported/);
        return true;
      },
    );

    const outputEntries = await readdir(outputDirectory);
    assert.equal(outputEntries.includes(LEGACY_WORKSPACE_DIR_NAME), true);
    assert.equal(outputEntries.includes(WORKSPACE_DIR_NAME), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("validateSessionPhase rejects session ids with path traversal", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-session-traversal-"));

  try {
    await assert.rejects(
      () => validateSessionPhase({ sessionId: "../outside", cwd: tempRoot, generator: new StubTextGenerator() }),
      /Session id "\.\.\/outside" is invalid/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication persists sanitized role model metadata", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-model-config-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const outputDirectory = path.join(tempRoot, "generated-app");
  const envKeys = [
    "APP_BUILDER_API_KEY",
    "APP_BUILDER_BASE_URL",
    "APP_BUILDER_USER_AGENT",
    "APP_BUILDER_PROTOCOL",
    "APP_BUILDER_MAX_INPUT_TOKENS",
    "APP_BUILDER_MAX_TOKENS",
    "APP_BUILDER_MODEL",
    "APP_BUILDER_PLAN_MODEL",
    "APP_BUILDER_GENERATE_MODEL",
    "APP_BUILDER_REPAIR_MODEL",
    "APP_BUILDER_PLAN_BASE_URL",
    "APP_BUILDER_GENERATE_BASE_URL",
    "APP_BUILDER_REPAIR_BASE_URL",
    "APP_BUILDER_PLAN_PROTOCOL",
    "APP_BUILDER_GENERATE_PROTOCOL",
    "APP_BUILDER_REPAIR_PROTOCOL",
    "APP_BUILDER_PLAN_MAX_INPUT_TOKENS",
    "APP_BUILDER_GENERATE_MAX_INPUT_TOKENS",
    "APP_BUILDER_REPAIR_MAX_INPUT_TOKENS",
    "APP_BUILDER_PLAN_MAX_TOKENS",
    "APP_BUILDER_GENERATE_MAX_TOKENS",
    "APP_BUILDER_REPAIR_MAX_TOKENS",
    "APP_BUILDER_PLAN_API_KEY",
    "APP_BUILDER_GENERATE_API_KEY",
    "APP_BUILDER_REPAIR_API_KEY",
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  try {
    process.env.APP_BUILDER_API_KEY = "global-secret";
    process.env.APP_BUILDER_BASE_URL = "https://global.example/v1";
    process.env.APP_BUILDER_USER_AGENT = "app-builder-test/1.0";
    process.env.APP_BUILDER_PROTOCOL = "openai";
    process.env.APP_BUILDER_MAX_INPUT_TOKENS = "65536";
    process.env.APP_BUILDER_MAX_TOKENS = "8192";
    process.env.APP_BUILDER_MODEL = "openai:global-model";
    process.env.APP_BUILDER_PLAN_MODEL = "openai:plan-model";
    process.env.APP_BUILDER_GENERATE_MODEL = "openai:generate-model";
    process.env.APP_BUILDER_REPAIR_MODEL = "openai:repair-model";
    process.env.APP_BUILDER_PLAN_BASE_URL = "https://plan.example/v1";
    process.env.APP_BUILDER_GENERATE_BASE_URL = "https://generate.example/v1";
    process.env.APP_BUILDER_REPAIR_BASE_URL = "https://repair.example/v1";
    process.env.APP_BUILDER_PLAN_PROTOCOL = "anthropic";
    process.env.APP_BUILDER_GENERATE_PROTOCOL = "openai";
    process.env.APP_BUILDER_REPAIR_PROTOCOL = "anthropic";
    process.env.APP_BUILDER_PLAN_MAX_INPUT_TOKENS = "262144";
    process.env.APP_BUILDER_GENERATE_MAX_INPUT_TOKENS = "131072";
    process.env.APP_BUILDER_REPAIR_MAX_INPUT_TOKENS = "196608";
    process.env.APP_BUILDER_PLAN_MAX_TOKENS = "32768";
    process.env.APP_BUILDER_GENERATE_MAX_TOKENS = "16384";
    process.env.APP_BUILDER_REPAIR_MAX_TOKENS = "24576";
    process.env.APP_BUILDER_PLAN_API_KEY = "plan-secret";
    process.env.APP_BUILDER_GENERATE_API_KEY = "generate-secret";
    process.env.APP_BUILDER_REPAIR_API_KEY = "repair-secret";

    await generateApplication({
      specPath,
      outputDirectory,
      force: true,
      generator: new StubTextGenerator(),
    });

    const configRaw = await readFile(path.join(outputDirectory, ".workspace/config.json"), "utf8");
    const config = JSON.parse(configRaw) as {
      model?: string;
      models?: {
        plan?: {
          modelName?: string;
          protocol?: string;
          baseURL?: string;
          userAgent?: string;
          maxInputTokens?: number;
          maxTokens?: number;
          apiKey?: string;
        };
        generate?: {
          modelName?: string;
          protocol?: string;
          baseURL?: string;
          userAgent?: string;
          maxInputTokens?: number;
          maxTokens?: number;
          apiKey?: string;
        };
        repair?: {
          modelName?: string;
          protocol?: string;
          baseURL?: string;
          userAgent?: string;
          maxInputTokens?: number;
          maxTokens?: number;
          apiKey?: string;
        };
      };
    };

    assert.equal(config.model, "openai:plan-model");
    assert.equal(config.models?.plan?.modelName, "openai:plan-model");
    assert.equal(config.models?.generate?.modelName, "openai:generate-model");
    assert.equal(config.models?.repair?.modelName, "openai:repair-model");
    assert.equal(config.models?.plan?.protocol, "anthropic");
    assert.equal(config.models?.generate?.protocol, "openai");
    assert.equal(config.models?.repair?.protocol, "anthropic");
    assert.equal(config.models?.plan?.baseURL, "https://plan.example/v1");
    assert.equal(config.models?.generate?.baseURL, "https://generate.example/v1");
    assert.equal(config.models?.repair?.baseURL, "https://repair.example/v1");
    assert.equal(config.models?.plan?.userAgent, "app-builder-test/1.0");
    assert.equal(config.models?.generate?.userAgent, "app-builder-test/1.0");
    assert.equal(config.models?.repair?.userAgent, "app-builder-test/1.0");
    assert.equal(config.models?.plan?.maxInputTokens, 262144);
    assert.equal(config.models?.generate?.maxInputTokens, 131072);
    assert.equal(config.models?.repair?.maxInputTokens, 196608);
    assert.equal(config.models?.plan?.maxTokens, 32768);
    assert.equal(config.models?.generate?.maxTokens, 16384);
    assert.equal(config.models?.repair?.maxTokens, 24576);
    assert.equal(config.models?.plan?.apiKey, undefined);
    assert.doesNotMatch(configRaw, /global-secret|plan-secret|generate-secret|repair-secret/);
  } finally {
    for (const key of envKeys) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("starter sidebar source explicitly guards against third-level navigation", async () => {
  const sidebarSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/starter/config/sidebar-menu.ts"),
    "utf8",
  );

  assert.match(sidebarSource, /supports at most two menu levels/);
  assert.match(sidebarSource, /import sidebarMenu from "\.\/sidebar-menu\.json"/);
});

test("full-stack starter login form does not prefill demo credentials", async () => {
  const loginSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/starter/app/(full-width-pages)/login/page.tsx"),
    "utf8",
  );

  assert.doesNotMatch(loginSource, /defaultValue="demo@example\.com"/);
  assert.doesNotMatch(loginSource, /defaultValue="demo12345"/);
});

test("generated app architecture reference matches the TailAdmin starter skeleton", async () => {
  const architectureSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/references/generated-app-architecture.md"),
    "utf8",
  );

  assert.match(architectureSource, /app\/\(admin\)\/layout\.tsx/);
  assert.match(architectureSource, /app\/\(full-width-pages\)\/login\/page\.tsx/);
  assert.match(architectureSource, /layout\/AdminShell\.tsx/);
  assert.match(architectureSource, /config\/sidebar-menu\.json/);
  assert.match(architectureSource, /prisma\.config\.ts/);
  assert.match(architectureSource, /SQLite/);
  assert.match(architectureSource, /TailAdmin/);
  assert.match(architectureSource, /route groups/);
  assert.match(architectureSource, /next\.config\.ts.*protected project configuration file/s);
});

test("planning payload passes plan-spec and locked env validation as blocking hard constraints to the agent", () => {
  const runtime = buildTestRuntime({
    templateEnvironmentPolicy: {
      lockedKeys: ["DATABASE_URL", "NEXT_PUBLIC_APP_NAME"],
    },
  });
  const spec: NormalizedSpec = {
    appName: "Field Ops Planner",
    slug: "field-ops-planner",
    summary: "Plan payload hard-constraint test.",
    roles: ["dispatcher"],
    entities: [],
    screens: [],
    flows: [],
    businessRules: [],
    warnings: [],
    defaultsApplied: [],
    sourceMarkdown: "# PRD",
    externalReferences: [],
  };

  const payload = buildPlanProjectPayload(spec, runtime) as {
    stage: string;
    hardConstraints: {
      planSpecSchemaValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
      interactionContractValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
      environmentVariablePolicyValidation: {
        artifactKey: string;
        artifactPath: string;
        blockedPlanSpecPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        lockedKeys: string[];
        rules: string[];
      };
      referenceUsageValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
    };
    planSpecSchema: unknown;
    artifacts: {
      interactionContract: string;
      referenceManifest: string;
    };
  };

  assert.equal(payload.stage, "计划阶段");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactKey, "artifacts.planSpec");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactPath, "/.workspace/plan-spec.json");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.blocking, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.required, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.mustValidateBeforeResponse, true);
  assert.match(payload.hardConstraints.planSpecSchemaValidation.rules.join("\n"), /空字符串/);
  assert.match(payload.hardConstraints.planSpecSchemaValidation.rules.join("\n"), /项目配置变更/);
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.artifactKey, "artifacts.planSpec");
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.artifactPath, "/.workspace/plan-spec.json");
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.blockedPlanSpecPath, "environmentVariables[*].name");
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.blocking, true);
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.required, true);
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.mustValidateBeforeResponse, true);
  assert.deepEqual(payload.hardConstraints.environmentVariablePolicyValidation.lockedKeys, [
    "DATABASE_URL",
    "NEXT_PUBLIC_APP_NAME",
  ]);
  assert.match(payload.hardConstraints.environmentVariablePolicyValidation.rules.join("\n"), /DATABASE_URL, NEXT_PUBLIC_APP_NAME/);
  assert.match(payload.hardConstraints.environmentVariablePolicyValidation.rules.join("\n"), /优先级高于 PRD/);
  assert.ok(payload.planSpecSchema);
  assert.equal(payload.artifacts.interactionContract, "/.workspace/interaction-contract.json");
  assert.equal(
    payload.hardConstraints.interactionContractValidation.artifactKey,
    "artifacts.interactionContract",
  );
  assert.equal(
    payload.hardConstraints.interactionContractValidation.artifactPath,
    "/.workspace/interaction-contract.json",
  );
  assert.equal(payload.hardConstraints.interactionContractValidation.blocking, true);
  assert.equal(payload.artifacts.referenceManifest, "/.workspace/references/reference-manifest.json");
  assert.equal(
    payload.hardConstraints.referenceUsageValidation.artifactKey,
    "artifacts.referenceManifest",
  );
  assert.equal(
    payload.hardConstraints.referenceUsageValidation.artifactPath,
    "/.workspace/references/reference-manifest.json",
  );
  assert.equal(payload.hardConstraints.referenceUsageValidation.blocking, true);
  assert.equal(payload.hardConstraints.referenceUsageValidation.required, true);
  assert.equal(payload.hardConstraints.referenceUsageValidation.mustValidateBeforeResponse, true);
  assert.match(payload.hardConstraints.referenceUsageValidation.rules.join("\n"), /必须先读取其 localPath/);
  assert.match(JSON.stringify(payload.planSpecSchema), /references/);
  assert.match(JSON.stringify(payload.planSpecSchema), /projectConfigChanges/);
  assert.doesNotMatch(JSON.stringify(payload.planSpecSchema), /relatedApis/);
});

test("plan-spec JSON schema avoids const for Gemini tool declarations", () => {
  const schema = z.toJSONSchema(planSpecSchema);
  const schemaProperties = asRecord(asRecord(schema).properties);
  const versionSchema = asRecord(schemaProperties.version);
  const environmentVariablesSchema = asRecord(schemaProperties.environmentVariables);
  const environmentVariableItems = asRecord(environmentVariablesSchema.items);
  const environmentVariableProperties = asRecord(environmentVariableItems.properties);
  const targetFileSchema = asRecord(environmentVariableProperties.targetFile);

  assert.equal(containsObjectKey(schema, "const"), false);
  assert.equal(versionSchema.minimum, 1);
  assert.equal(versionSchema.maximum, 1);
  assert.deepEqual(targetFileSchema.enum, [".env.example"]);
});

test("plan-repair payload preserves the blocking hard constraint for plan-spec schema validation", () => {
  const payload = buildPlanRepairPayload(buildTestRuntime({
    planAttempt: 2,
    retryReasons: ["artifacts.planSpec 校验失败：pages.0.resourceName"],
    templateEnvironmentPolicy: {
      lockedKeys: ["DATABASE_URL"],
    },
  })) as {
    stage: string;
    hardConstraints: {
      planSpecSchemaValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
      interactionContractValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
      environmentVariablePolicyValidation: {
        artifactKey: string;
        artifactPath: string;
        blockedPlanSpecPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        lockedKeys: string[];
        rules: string[];
      };
      referenceUsageValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
    };
    planSpecSchema: unknown;
    artifacts: {
      interactionContract: string;
      referenceManifest: string;
    };
  };

  assert.equal(payload.stage, "计划修复阶段");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactKey, "artifacts.planSpec");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactPath, "/.workspace/plan-spec.json");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.blocking, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.required, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.mustValidateBeforeResponse, true);
  assert.match(payload.hardConstraints.planSpecSchemaValidation.rules.join("\n"), /非空字符串/);
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.artifactKey, "artifacts.planSpec");
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.artifactPath, "/.workspace/plan-spec.json");
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.blockedPlanSpecPath, "environmentVariables[*].name");
  assert.equal(payload.hardConstraints.environmentVariablePolicyValidation.blocking, true);
  assert.deepEqual(payload.hardConstraints.environmentVariablePolicyValidation.lockedKeys, ["DATABASE_URL"]);
  assert.match(payload.hardConstraints.environmentVariablePolicyValidation.rules.join("\n"), /DATABASE_URL/);
  assert.ok(payload.planSpecSchema);
  assert.equal(payload.artifacts.interactionContract, "/.workspace/interaction-contract.json");
  assert.equal(
    payload.hardConstraints.interactionContractValidation.artifactKey,
    "artifacts.interactionContract",
  );
  assert.equal(payload.artifacts.referenceManifest, "/.workspace/references/reference-manifest.json");
  assert.equal(payload.hardConstraints.referenceUsageValidation.artifactKey, "artifacts.referenceManifest");
  assert.equal(payload.hardConstraints.referenceUsageValidation.artifactPath, "/.workspace/references/reference-manifest.json");
  assert.equal(payload.hardConstraints.referenceUsageValidation.blocking, true);
  assert.match(payload.hardConstraints.referenceUsageValidation.rules.join("\n"), /不能凭模型记忆/);
});

test("hard cutover source scan keeps public surfaces on Pi Agent and .workspace", async () => {
  const publicSurfaceFiles = [
    "README.md",
    "AGENTS.md",
    "src/lib/cli.ts",
    "src/lib/session-policy.ts",
    ...await collectFilesWithExtensions("templates", new Set([".md", ".json"])),
  ];

  for (const filePath of publicSurfaceFiles) {
    const contents = await readFile(filePath, "utf8");
    assert.doesNotMatch(contents, /\bdeepagents\b|DeepAgents|\.deepagents/i, `${filePath} still exposes a DeepAgents-era term`);
  }

  const sourceFiles = [
    ...await collectFilesWithExtensions("src", new Set([".ts"])),
    ...await collectFilesWithExtensions("scripts", new Set([".mjs"])),
  ];
  const legacyLiteralMatches: Array<{ filePath: string; line: string }> = [];
  for (const filePath of sourceFiles) {
    const lines = (await readFile(filePath, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (/["'`]\/?\.deepagents|\/\.deepagents|\.deepagents\//.test(line)) {
        legacyLiteralMatches.push({ filePath, line: `${index + 1}:${line.trim()}` });
      }
    });
  }

  assert.deepEqual(legacyLiteralMatches, [
    {
      filePath: "src/lib/workspace-artifacts.ts",
      line: "4:export const LEGACY_WORKSPACE_DIR_NAME = \".deepagents\";",
    },
  ]);
});

test("host policy and Pi/compat permissions block model writes to host-materialized artifacts", () => {
  const policy = buildSessionPolicyDocument();
  const permissions = buildHostManagedArtifactPermissions();
  const protectedPaths: string[] = [...HOST_MANAGED_WRITE_PROTECTED_ARTIFACT_PATHS];

  assert.match(policy, /Host-materialized JSON, validation, runtime, config, prompt snapshot, and source mirror artifacts are read-only to model file tools/);
  assert.match(policy, /This write-protection does not apply to `artifacts\.analysis` or `artifacts\.generatedSpec`/);
  assert.match(policy, /`artifacts\.todo` = `\/\.workspace\/todo\.md`/);
  assert.match(policy, /host monitors it and uses it as the live todo board/);
  assert.equal(permissions.length, 1);
  assert.deepEqual(permissions[0]?.operations, ["write"]);
  assert.equal(permissions[0]?.mode, "deny");
  assert.deepEqual(permissions[0]?.paths, protectedPaths);
  assert.ok(protectedPaths.includes("/.workspace/plan-spec.json"));
  assert.ok(protectedPaths.includes("/.workspace/interaction-contract.json"));
  assert.ok(protectedPaths.includes("/.workspace/plan-validation.json"));
  assert.equal(protectedPaths.includes("/.workspace/todo.md"), false);
  assert.equal(protectedPaths.includes("/.workspace/prd-analysis.md"), false);
  assert.equal(protectedPaths.includes("/.workspace/generated-spec.md"), false);
});

test("host-managed artifact write guard soft-blocks protected file writes", async () => {
  const middleware = createHostManagedArtifactWriteGuardMiddleware() as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  let handlerCalled = false;

  const result = await middleware.wrapToolCall(
    {
      toolCall: {
        id: "call-plan-spec",
        name: "write_file",
        args: {
          file_path: "/.workspace/plan-spec.json",
          content: "{}",
        },
      },
      tool: undefined,
      state: { messages: [] },
      runtime: {},
    },
    async () => {
      handlerCalled = true;
      throw new Error("handler should not be called for protected host artifacts");
    },
  ) as { content?: unknown; name?: string; status?: string; tool_call_id?: string };

  assert.equal(handlerCalled, false);
  assert.equal(result.name, "write_file");
  assert.equal(result.status, "error");
  assert.equal(result.tool_call_id, "call-plan-spec");
  assert.match(String(result.content), /host-managed artifact write blocked/);
  assert.equal(isHostManagedWriteProtectedArtifactPath("/.workspace/plan-spec.json"), true);
  assert.equal(isHostManagedWriteProtectedArtifactPath("/.workspace/prd-analysis.md"), false);
});

test("host-managed artifact write guard allows model-owned planning markdown writes", async () => {
  const middleware = createHostManagedArtifactWriteGuardMiddleware() as {
    wrapToolCall: (
      request: unknown,
      handler: (request: unknown) => Promise<unknown>,
    ) => Promise<unknown>;
  };
  const expected = { content: "ok", name: "write_file", tool_call_id: "call-analysis" };
  let handlerCalled = false;

  const result = await middleware.wrapToolCall(
    {
      toolCall: {
        id: "call-analysis",
        name: "write_file",
        args: {
          file_path: "/.workspace/prd-analysis.md",
          content: "# Analysis\n",
        },
      },
      tool: undefined,
      state: { messages: [] },
      runtime: {},
    },
    async () => {
      handlerCalled = true;
      return expected;
    },
  );

  assert.equal(handlerCalled, true);
  assert.equal(result, expected);
});

test("mini-app prompts require interaction contract traceability", async () => {
  const planPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/prompts/plan-system-prompt.md"),
    "utf8",
  );
  const generatePromptSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/prompts/generate-system-prompt.md"),
    "utf8",
  );
  const generateRepairPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/prompts/generate-repair-system-prompt.md"),
    "utf8",
  );
  const architectureReferenceSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/references/generated-app-architecture.md"),
    "utf8",
  );

  assert.match(planPromptSource, /artifacts\.interactionContract/);
  assert.match(planPromptSource, /triggerControl/);
  assert.match(planPromptSource, /endpointPath/);
  assert.match(generatePromptSource, /必须读取 `artifacts\.interactionContract`/);
  assert.match(generatePromptSource, /artifacts\.design/);
  assert.match(generatePromptSource, /通常为 `\/DESIGN\.md`/);
  assert.match(generatePromptSource, /fallbackTrigger/);
  assert.match(generatePromptSource, /Interaction contract trace/);
  assert.match(generatePromptSource, /`next\/link` 的 `<Link href="\.\.\.">`/);
  assert.match(generatePromptSource, /禁止在这些菜单\/导航上下文中使用 `<a href="\.\.\.">`/);
  assert.match(generateRepairPromptSource, /必须读取 `artifacts\.interactionContract`/);
  assert.match(generateRepairPromptSource, /artifacts\.design/);
  assert.match(generateRepairPromptSource, /通常为 `\/DESIGN\.md`/);
  assert.match(generateRepairPromptSource, /endpointPath/);
  assert.match(generateRepairPromptSource, /Interaction contract trace/);
  assert.match(generateRepairPromptSource, /validationFailures.*mini-app 菜单\/导航链接约束/);
  assert.match(generateRepairPromptSource, /`import Link from "next\/link";`/);
  assert.match(architectureReferenceSource, /Menu, navigation, top-bar, tabs, breadcrumb, and sidebar route links must use `next\/link`'s `<Link href="\.\.\.">` component/);
});
test("split prompts enforce plan-spec gating and plan-spec-only generation", async () => {
  const planPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/prompts/plan-system-prompt.md"),
    "utf8",
  );
  const planRepairPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/prompts/plan-repair-system-prompt.md"),
    "utf8",
  );
  const generatePromptSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/prompts/generate-system-prompt.md"),
    "utf8",
  );
  const generateRepairPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/prompts/generate-repair-system-prompt.md"),
    "utf8",
  );

  assert.match(planPromptSource, /artifacts\.planSpec/);
  assert.match(planPromptSource, /必须严格符合输入里的 `planSpecSchema`/);
  assert.match(planPromptSource, /不能写应用源码/);
  assert.match(planPromptSource, /禁止执行：调用任何子代理/);
  assert.match(planPromptSource, /必须先调用一次 `write_todos`/);
  assert.match(planPromptSource, /必须持续更新 todo 状态/);
  assert.match(planPromptSource, /`\/\.workspace\/todo\.md`/);
  assert.match(planPromptSource, /`\/\.workspace\/source-prd\.md`/);
  assert.match(planPromptSource, /`sourcePrdMarkdown` 为主事实来源/);
  assert.match(planPromptSource, /只有在 `sourcePrdMarkdown` 缺失、截断或明显不可用时，才允许读取 `artifacts\.sourcePrd`/);
  assert.match(planPromptSource, /严禁对同一文件、同一区间做重复读取循环/);
  assert.match(planPromptSource, /对当前尚不存在的 `artifacts\.analysis`、`artifacts\.generatedSpec`，应直接创建/);
  assert.match(planPromptSource, /最终结构化响应必须包含 `planSpec` 字段/);
  assert.match(planPromptSource, /`\/\.workspace\/prd-analysis\.md`/);
  assert.match(planPromptSource, /`hardConstraints\.planSpecSchemaValidation`/);
  assert.match(planPromptSource, /`hardConstraints\.environmentVariablePolicyValidation`/);
  assert.match(planPromptSource, /空字符串/);
  assert.match(planPromptSource, /把 `\/\.workspace\/\.\.\.` 改成 `\/workspace\/\.\.\.`/);
  assert.match(planPromptSource, /planSpec\.references/);
  assert.match(planPromptSource, /优先级高于 PRD 环境变量覆盖请求/);
  assert.match(planPromptSource, /计划阶段必须省略该变量/);
  assert.match(planPromptSource, /不要求也不提供 `relatedApis`/);
  assert.match(generatePromptSource, /`planSpec` 是唯一事实来源/);
  assert.match(generatePromptSource, /不能重新分析原始 PRD/);
  assert.match(generatePromptSource, /`artifacts\.interactionContract` 是页面交互/);
  assert.match(generatePromptSource, /必须读取 `artifacts\.interactionContract`/);
  assert.match(generatePromptSource, /internalOperations\[\*\]/);
  assert.match(generatePromptSource, /interaction contract trace/);
  assert.match(generatePromptSource, /planSpec\.references/);
  assert.match(generatePromptSource, /自行判断哪些 reference 与当前要实现的页面\/API 相关/);
  assert.match(generatePromptSource, /`references` 不是宿主强制验收项/);
  assert.doesNotMatch(generatePromptSource, /当前禁止执行：调用任何子代理/);
  assert.match(generatePromptSource, /宿主会优先启动 backend、frontend、integration 三类默认 subagent/);
  assert.match(generatePromptSource, /parallelGeneration\.results/);
  assert.match(generatePromptSource, /鼓励在有明确并行价值时调用 `task` 工具启动子代理/);
  assert.match(generatePromptSource, /通过 `task` 同时启动多个 subagent/);
  assert.match(generatePromptSource, /frontend-implementer/);
  assert.match(generatePromptSource, /backend-implementer/);
  assert.match(generatePromptSource, /integration-verifier/);
  assert.match(generatePromptSource, /至少两个实现或验证切片可以真正并行推进/);
  assert.match(generatePromptSource, /无法通过并行带来生成提效，必须由主代理直接实现/);
  assert.match(generatePromptSource, /implementedPages/);
  assert.match(generatePromptSource, /必须先调用一次 `write_todos`/);
  assert.match(generatePromptSource, /必须持续更新 todo 状态/);
  assert.match(generatePromptSource, /`\/\.workspace\/todo\.md`/);
  assert.match(generatePromptSource, /必须先读取 `\/\.workspace\/references\/generated-app-architecture\.md`/);
  assert.match(generatePromptSource, /route groups、shell、context、sidebar 和鉴权约定/);
  assert.match(generatePromptSource, /`\/\.workspace\/plan-spec\.json`/);
  assert.match(generatePromptSource, /`\/app-builder-report\.md`/);
  assert.match(generatePromptSource, /持久化、鉴权或启动契约/);
  assert.match(generatePromptSource, /Prisma 配置、schema、seed、脚本/);
  assert.match(generatePromptSource, /schema、seed、脚本、认证\/会话和默认入口数据/);
  assert.match(generatePromptSource, /按输入里的 `template\.runtimeValidation` 执行运行验证/);
  assert.match(generatePromptSource, /默认运行验证模式是非交互式/);
  assert.match(generatePromptSource, /`planSpec\.pages` 的全部页面路由和 `planSpec\.apis` 的全部 API 方法/);
  assert.match(generatePromptSource, /非交互式、交互式和 smoke 三选一运行/);
  assert.match(generatePromptSource, /把 `\/app-builder-report\.md` 改成 `\/app\/app-builder-report\.md`/);
  assert.match(generatePromptSource, /页面实现必须严格以 `planSpec\.pages\[\*\]\.route` 为准/);
  assert.match(generatePromptSource, /所有承载业务数据的页面必须对接 `planSpec\.apis` 中定义的 Route Handlers/);
  assert.match(generatePromptSource, /禁止在页面组件中用 mock 数据、演示数组、硬编码业务统计、`Math\.random\(\)` 模拟刷新/);
  assert.match(generatePromptSource, /若现有 API 不足以支撑页面展示，先按 `planSpec` 补齐 API，再完成页面接线/);
  assert.match(planRepairPromptSource, /validationFailures/);
  assert.match(planRepairPromptSource, /`hardConstraints\.planSpecSchemaValidation`/);
  assert.match(planRepairPromptSource, /`hardConstraints\.environmentVariablePolicyValidation`/);
  assert.match(planRepairPromptSource, /空字符串/);
  assert.match(planRepairPromptSource, /禁止执行：调用任何子代理/);
  assert.match(planRepairPromptSource, /只补齐缺失或错误部分/);
  assert.match(planRepairPromptSource, /`\/\.workspace\/source-prd\.md`/);
  assert.match(planRepairPromptSource, /planSpec\.references/);
  assert.match(planRepairPromptSource, /必须从 `planSpec\.environmentVariables` 删除对应条目/);
  assert.match(generateRepairPromptSource, /validationFailures/);
  assert.doesNotMatch(generateRepairPromptSource, /当前禁止执行：调用任何子代理/);
  assert.match(generateRepairPromptSource, /鼓励在多个失败项或修补切片彼此独立时调用 `task` 工具启动子代理/);
  assert.match(generateRepairPromptSource, /通过 `task` 同时启动多个 subagent/);
  assert.match(generateRepairPromptSource, /frontend-fixer/);
  assert.match(generateRepairPromptSource, /backend-fixer/);
  assert.match(generateRepairPromptSource, /integration-verifier/);
  assert.match(generateRepairPromptSource, /修补切片可以真正并行推进/);
  assert.match(generateRepairPromptSource, /并行不会缩短总修复时间，必须由主代理直接修补/);
  assert.match(generateRepairPromptSource, /只补齐缺失实现或错误接线/);
  assert.match(generateRepairPromptSource, /必须先读取 `artifacts\.interactionContract`/);
  assert.match(generateRepairPromptSource, /flows\/internalOperations\/externalOperations/);
  assert.match(generateRepairPromptSource, /interaction contract trace/);
  assert.match(generateRepairPromptSource, /planSpec\.references/);
  assert.match(generateRepairPromptSource, /声明 locked key 或锁定变量冲突，这是计划规格问题/);
  assert.match(generateRepairPromptSource, /不要修改 `\.env`\/`\.env\.example` 或应用代码来绕过锁定/);
  assert.match(generateRepairPromptSource, /`references` 不是宿主强制验收项/);
  assert.match(generateRepairPromptSource, /页面修复必须严格以 `planSpec\.pages\[\*\]\.route` 为准/);
  assert.match(generateRepairPromptSource, /`\/\.workspace\/generation-validation\.json`/);
  assert.match(generateRepairPromptSource, /`\/\.workspace\/runtime-validation\.log`/);
  assert.match(generateRepairPromptSource, /非交互式、交互式或 smoke 运行验证/);
  assert.match(generateRepairPromptSource, /持久化、鉴权或启动契约被局部改坏/);
  assert.match(generateRepairPromptSource, /Prisma 配置、schema、seed、脚本/);
  assert.match(generateRepairPromptSource, /schema、seed、脚本、认证\/会话和默认入口数据/);
  assert.match(generateRepairPromptSource, /`\/app-builder-report\.md`/);
  assert.match(generateRepairPromptSource, /如果现有页面仍使用 mock 数据、演示数组、硬编码业务统计、`Math\.random\(\)` 模拟结果/);
  assert.match(generateRepairPromptSource, /必须改为对接 `planSpec\.apis` 中对应的 Route Handlers/);
});

test("mini-app prompts preserve PRD environment configuration through planSpec", async () => {
  const planPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/prompts/plan-system-prompt.md"),
    "utf8",
  );
  const planRepairPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/prompts/plan-repair-system-prompt.md"),
    "utf8",
  );
  const generatePromptSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/prompts/generate-system-prompt.md"),
    "utf8",
  );
  const generateRepairPromptSource = await readFile(
    path.resolve(process.cwd(), "templates/mini-app/prompts/generate-repair-system-prompt.md"),
    "utf8",
  );

  assert.match(planPromptSource, /你是 mini-app 模板的“计划阶段代理”/);
  assert.match(planPromptSource, /环境配置/);
  assert.match(planPromptSource, /planSpec\.environmentVariables/);
  assert.match(planPromptSource, /planSpec\.references/);
  assert.match(planPromptSource, /不要求也不提供 `relatedApis`/);
  assert.match(planPromptSource, /targetFile` 写 `\.env\.example`/);
  assert.match(planPromptSource, /template\.environmentPolicy\.lockedKeys/);
  assert.match(planPromptSource, /hardConstraints\.environmentVariablePolicyValidation/);
  assert.match(planPromptSource, /优先级高于 PRD 环境变量覆盖请求/);
  assert.match(planPromptSource, /计划阶段必须省略该变量/);
  assert.match(planRepairPromptSource, /计划修复阶段代理/);
  assert.match(planRepairPromptSource, /planSpec\.environmentVariables/);
  assert.match(planRepairPromptSource, /planSpec\.references/);
  assert.match(planRepairPromptSource, /lockedKeys/);
  assert.match(planRepairPromptSource, /必须从 `planSpec\.environmentVariables` 删除对应条目/);
  assert.match(generatePromptSource, /planSpec\.environmentVariables/);
  assert.match(generatePromptSource, /planSpec\.references/);
  assert.match(generatePromptSource, /自行判断哪些 reference 与当前要实现的页面\/API 相关/);
  assert.match(generatePromptSource, /`references` 不是宿主强制验收项/);
  assert.match(generatePromptSource, /最终合并和落盘由 host 负责/);
  assert.match(generatePromptSource, /不应仅因为环境变量合并而包含 `\.env\.example`/);
  assert.match(generatePromptSource, /默认运行验证模式是非交互式/);
  assert.match(generatePromptSource, /非交互式、交互式和 smoke 三选一运行/);
  assert.match(generateRepairPromptSource, /planSpec\.environmentVariables/);
  assert.match(generateRepairPromptSource, /planSpec\.references/);
  assert.match(generateRepairPromptSource, /`references` 不是宿主强制验收项/);
  assert.match(generateRepairPromptSource, /不要直接修补根目录 `\/\.env\.example`/);
  assert.match(generateRepairPromptSource, /非交互式、交互式或 smoke 运行验证/);
  assert.match(generateRepairPromptSource, /声明 locked key 或锁定变量冲突，这是计划规格问题/);
  assert.match(generateRepairPromptSource, /不要修改 `\.env`\/`\.env\.example` 或应用代码来绕过锁定/);
});
