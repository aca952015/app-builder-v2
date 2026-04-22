import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { routeToAdminPagePath, routeToPageFileCandidates } from "../src/lib/app-router.js";
import { type PlanSpec } from "../src/lib/plan-spec.js";
import { filterRedundantValidationDetailLines, generateApplication, resolveSpawnCommand } from "../src/lib/generator.js";
import { buildPlanProjectPayload, buildPlanRepairPayload } from "../src/lib/text-generator.js";
import { copyStarterScaffold, loadTemplatePack } from "../src/lib/template-pack.js";
import { GeneratedAppValidator, NormalizedSpec, TextGenerator, TextGeneratorRuntime } from "../src/lib/types.js";

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

function uniqueApiPaths(planSpec: PlanSpec): string[] {
  return Array.from(new Set(planSpec.apis.map((api) => api.path)));
}

function buildTestRuntime(overrides: Partial<TextGeneratorRuntime> = {}): TextGeneratorRuntime {
  return {
    sessionId: "test-session",
    outputDirectory: "/virtual-workspace",
    deepagentsDirectory: "/virtual-workspace/.deepagents",
    deepagentsAgentsPath: "/virtual-workspace/.deepagents/AGENTS.md",
    deepagentsLogPath: "/virtual-workspace/.deepagents/trace.log",
    deepagentsErrorLogPath: "/virtual-workspace/.deepagents/error.log",
    deepagentsRuntimeValidationLogPath: "/virtual-workspace/.deepagents/runtime-validation.log",
    deepagentsConfigPath: "/virtual-workspace/.deepagents/config.json",
    deepagentsPlanPromptSnapshotPath: "/virtual-workspace/.deepagents/plan-system-prompt.md",
    deepagentsPlanRepairPromptSnapshotPath: "/virtual-workspace/.deepagents/plan-repair-system-prompt.md",
    deepagentsGeneratePromptSnapshotPath: "/virtual-workspace/.deepagents/generate-system-prompt.md",
    deepagentsGenerateRepairPromptSnapshotPath: "/virtual-workspace/.deepagents/generate-repair-system-prompt.md",
    templateId: "full-stack",
    templateName: "Full Stack",
    templateVersion: "1.0.0",
    templateDirectory: "/virtual-workspace/.deepagents/template",
    templatePlanPromptPath: "/virtual-workspace/.deepagents/template/prompts/plan-system-prompt.md",
    templatePlanRepairPromptPath: "/virtual-workspace/.deepagents/template/prompts/plan-repair-system-prompt.md",
    templateGeneratePromptPath: "/virtual-workspace/.deepagents/template/prompts/generate-system-prompt.md",
    templateGenerateRepairPromptPath: "/virtual-workspace/.deepagents/template/prompts/generate-repair-system-prompt.md",
    sourcePrdSnapshotPath: "/virtual-workspace/.deepagents/source-prd.md",
    deepagentsAnalysisPath: "/virtual-workspace/.deepagents/prd-analysis.md",
    deepagentsDetailedSpecPath: "/virtual-workspace/.deepagents/generated-spec.md",
    deepagentsPlanSpecPath: "/virtual-workspace/.deepagents/plan-spec.json",
    deepagentsPlanValidationPath: "/virtual-workspace/.deepagents/plan-validation.json",
    deepagentsGenerationValidationPath: "/virtual-workspace/.deepagents/generation-validation.json",
    planAttempt: 1,
    maxPlanRetries: 2,
    generateAttempt: 1,
    maxGenerateRetries: 2,
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
    ...overrides,
  };
}

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
    "生成阶段运行验证失败：pnpm typecheck 未通过。退出码 2。摘要：app/(admin)/page.tsx(24,5): error TS2687。详见 .deepagents/runtime-validation.log。",
  ];

  assert.deepEqual(
    filterRedundantValidationDetailLines(
      "退出码 2。摘要：app/(admin)/page.tsx(24,5): error TS2687。\n补充上下文：Dashboard 类型冲突。",
      reasons,
    ),
    ["补充上下文：Dashboard 类型冲突。"],
  );
});

test("routeToPageFileCandidates normalizes common dynamic route syntaxes to Next App Router paths", () => {
  assert.deepEqual(routeToPageFileCandidates("/workorders/:id"), [
    "app/workorders/[id]/page.tsx",
    "app/(admin)/workorders/[id]/page.tsx",
    "app/(full-width-pages)/workorders/[id]/page.tsx",
  ]);
  assert.deepEqual(routeToPageFileCandidates("/alarms/[source_Path]"), [
    "app/alarms/[source_Path]/page.tsx",
    "app/(admin)/alarms/[source_Path]/page.tsx",
    "app/(full-width-pages)/alarms/[source_Path]/page.tsx",
  ]);
  assert.deepEqual(routeToPageFileCandidates("/files/:path+"), [
    "app/files/[...path]/page.tsx",
    "app/(admin)/files/[...path]/page.tsx",
    "app/(full-width-pages)/files/[...path]/page.tsx",
  ]);
  assert.equal(routeToAdminPagePath("/alarms/:source_Path"), "app/(admin)/alarms/[source_Path]/page.tsx");
});

async function writeImplementedProjectFiles(options: {
  outputDirectory: string;
  planSpec: PlanSpec;
  reportContents: string;
  extraFiles?: Array<{ path: string; contents: string }>;
}): Promise<void> {
  await writeFile(path.join(options.outputDirectory, "app-builder-report.md"), options.reportContents, "utf8");

  for (const apiPath of uniqueApiPaths(options.planSpec)) {
    const relativePath = apiPath.replace(/^\/+/, "");
    const absolutePath = path.join(options.outputDirectory, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, "export async function GET() { return Response.json([]); }\n", "utf8");
  }

  for (const page of options.planSpec.pages) {
    const relativePath = routeToAdminPagePath(page.route);
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
        reasons: ["生成阶段运行验证失败：pnpm db:init 未通过。Prisma schema 校验失败。详见 .deepagents/runtime-validation.log。"],
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
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
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

    return {
      summary: "Stub planner wrote validated planning artifacts.",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
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

class IndirectResourceTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildIndirectSupportPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 间接资源分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 间接资源详细规格\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");

    return {
      summary: "已写入包含 indirect 资源的计划产物。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

    return {
      summary: "已写入使用冒号路由语义的计划产物。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

    return {
      summary: "重试后已补齐必需计划 artifacts。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

    return {
      summary: "计划阶段返回了需要宿主归一化的 plan spec。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

class GenerateStructuredResponseRecoveryTextGenerator implements TextGenerator {
  generationRepairAttempts = 0;

  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

class LooseDeclarationTextGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();

    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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

    return {
      summary: "计划阶段成功，包含仅暴露 API 的支持资源。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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
    const misplacedDeepagentsDirectory = path.join(runtime.outputDirectory, "app", ".deepagents");

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

    return {
      summary: "Planner mistakenly wrote host artifacts under /app.",
      artifactsWritten: [
        "/app/.deepagents/prd-analysis.md",
        "/app/.deepagents/generated-spec.md",
        "/app/.deepagents/plan-spec.json",
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

    return {
      summary: "计划阶段允许同一路径按 method 拆分接口。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
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
      path.join(result.outputDirectory, ".deepagents/template.json"),
      "utf8",
    );
    const sessionAgents = await readFile(
      path.join(result.outputDirectory, ".deepagents/AGENTS.md"),
      "utf8",
    );
    const planPromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/plan-system-prompt.md"),
      "utf8",
    );
    const planRepairPromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/plan-repair-system-prompt.md"),
      "utf8",
    );
    const generatePromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/generate-system-prompt.md"),
      "utf8",
    );
    const generateRepairPromptSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/generate-repair-system-prompt.md"),
      "utf8",
    );
    const sourcePrdSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/source-prd.md"),
      "utf8",
    );
    const analysisSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/prd-analysis.md"),
      "utf8",
    );
    const generatedSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/generated-spec.md"),
      "utf8",
    );
    const planSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/plan-spec.json"),
      "utf8",
    );
    const planValidationSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/plan-validation.json"),
      "utf8",
    );
    const generationValidationSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/generation-validation.json"),
      "utf8",
    );
    const runtimeValidationLog = await readFile(
      path.join(result.outputDirectory, ".deepagents/runtime-validation.log"),
      "utf8",
    );
    const deepagentsConfig = await readFile(
      path.join(result.outputDirectory, ".deepagents/config.json"),
      "utf8",
    );
    const stagedReference = await readFile(
      path.join(result.outputDirectory, ".deepagents/references/generated-app-architecture.md"),
      "utf8",
    );

    const planSpec = JSON.parse(planSpecSnapshot) as PlanSpec;

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
    assert.match(templateLock, /"plan": 5/);
    assert.match(templateLock, /"generate": 5/);
    assert.match(templateLock, /"phases": \{/);
    assert.match(templateLock, /"plan": \{\s*"prompt": "prompts\/plan-system-prompt\.md"/);
    assert.match(templateLock, /"planRepair": \{[\s\S]*"prompt": "prompts\/plan-repair-system-prompt\.md"/);
    assert.match(templateLock, /"generate": \{[\s\S]*"prompt": "prompts\/generate-system-prompt\.md"/);
    assert.match(templateLock, /"generateRepair": \{[\s\S]*"prompt": "prompts\/generate-repair-system-prompt\.md"/);
    assert.match(templateLock, /"planRepair": \{[\s\S]*"effort": "high"/);
    assert.match(templateLock, /"generate": \{[\s\S]*"effort": "medium"/);
    assert.match(stagedTemplateManifest, /"repairRetries": \{/);
    assert.match(stagedTemplateManifest, /"phases": \{/);
    assert.match(stagedTemplateManifest, /"plan": \{\s*"prompt": "prompts\/plan-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"planRepair": \{[\s\S]*"prompt": "prompts\/plan-repair-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generate": \{[\s\S]*"prompt": "prompts\/generate-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generateRepair": \{[\s\S]*"prompt": "prompts\/generate-repair-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generateRepair": \{[\s\S]*"effort": "high"/);
    assert.match(sessionAgents, /# Host Session Policy/);
    assert.match(sessionAgents, /acceptanceChecks\.target/);
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
    assert.match(generateRepairPromptSnapshot, /生成修复阶段代理/);
    assert.match(generateRepairPromptSnapshot, /validationFailures/);
    assert.match(generateRepairPromptSnapshot, /runtimeValidationLog/);
    assert.match(generateRepairPromptSnapshot, /Current stage: Generate Repair Stage/);
    assert.match(sourcePrdSnapshot, /# Field Ops Planner/);
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
    assert.match(deepagentsConfig, /"runtimeValidationLog": "\.deepagents\/runtime-validation\.log"/);
    assert.match(deepagentsConfig, /"repairRetries": \{/);
    assert.match(deepagentsConfig, /"phases": \{/);
    assert.match(deepagentsConfig, /"plan": \{[\s\S]*"prompt": "prompts\/plan-system-prompt\.md"[\s\S]*"effort": "high"/);
    assert.doesNotMatch(deepagentsConfig, /\/Users\/aca\/dev\/app-builder-v2/);
    assert.doesNotMatch(stagedReference, /\/Users\/aca\/dev\/app-builder-v2/);
    assert.equal(result.files.some((file) => file.startsWith(".git/")), false);
    await assert.rejects(() => access(path.join(result.outputDirectory, ".deepagents/normalized-spec.json")));
    await assert.rejects(() => access(path.join(result.outputDirectory, ".deepagents/prompts")));
    await assert.rejects(() => access(path.join(result.outputDirectory, ".deepagents/starter")));
  } finally {
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
      await readFile(path.join(result.outputDirectory, ".deepagents/prd-analysis.md"), "utf8"),
      /重试后的分析稿/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/generated-spec.md"), "utf8"),
      /重试后的详细 Spec/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/plan-spec.json"), "utf8"),
      /"version": 1/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/error.log"), "utf8"),
      /artifacts\.planSpec|artifactsWritten/,
    );
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
      path.join(result.outputDirectory, ".deepagents/plan-spec.json"),
      "utf8",
    );
    const planValidation = await readFile(
      path.join(result.outputDirectory, ".deepagents/plan-validation.json"),
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
      path.join(result.outputDirectory, ".deepagents/plan-validation.json"),
      "utf8",
    );
    const generationValidation = await readFile(
      path.join(result.outputDirectory, ".deepagents/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.planRepairAttempts, 1);
    assert.match(planValidation, /"valid": true/);
    assert.match(generationValidation, /"valid": true/);
  } finally {
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
      path.join(result.outputDirectory, ".deepagents/generation-validation.json"),
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
      path.join(result.outputDirectory, ".deepagents/generation-validation.json"),
      "utf8",
    );

    assert.equal(generator.generationRepairAttempts, 1);
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
      await readFile(path.join(tempRoot, "output", ".deepagents/error.log"), "utf8"),
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
      await readFile(path.join(result.outputDirectory, ".deepagents/generation-validation.json"), "utf8"),
      /"name": "pnpm db:init"/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/generation-validation.json"), "utf8"),
      /"name": "pnpm dev"/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/runtime-validation.log"), "utf8"),
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
      await readFile(path.join(result.outputDirectory, ".deepagents/generation-validation.json"), "utf8"),
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
      path.join(result.outputDirectory, ".deepagents/generation-validation.json"),
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
      path.join(result.outputDirectory, ".deepagents/generation-validation.json"),
      "utf8",
    );

    assert.match(generationValidation, /"valid": true/);
    assert.doesNotMatch(generationValidation, /\/alarms\/:source_Path/);
    assert.doesNotMatch(generationValidation, /\/workorders\/:id/);
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
      await readFile(path.join(result.outputDirectory, ".deepagents/plan-validation.json"), "utf8"),
      /"valid": true/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/generation-validation.json"), "utf8"),
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
      await readFile(path.join(result.outputDirectory, ".deepagents", "prd-analysis.md"), "utf8"),
      /Misplaced 分析稿/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents", "generated-spec.md"), "utf8"),
      /Misplaced Spec/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents", "plan-spec.json"), "utf8"),
      /"version": 1/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"),
      /Misplaced Report/,
    );
    await assert.rejects(() =>
      access(path.join(result.outputDirectory, "app", ".deepagents", "plan-spec.json")),
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
      path.join(result.outputDirectory, ".deepagents/plan-validation.json"),
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
    assert.ok(copied.includes("package.json"));
    assert.ok(copied.includes("prisma.config.ts"));
    assert.ok(copied.includes("app/layout.tsx"));
    assert.ok(copied.includes("lib/session.ts"));
    assert.ok(copied.includes("prisma/schema.prisma"));
    assert.ok(copied.includes("prisma/seed.ts"));
    assert.ok(copied.includes("config/sidebar-menu.json"));

    const starterPackage = await readFile(path.join(tempRoot, "package.json"), "utf8");
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

    const deepagentsConfig = await readFile(
      path.join(result.outputDirectory, ".deepagents/config.json"),
      "utf8",
    );
    const outputEntries = await readdir(result.outputDirectory);

    assert.match(deepagentsConfig, new RegExp(result.sessionId));
    assert.match(deepagentsConfig, /"phase": "complete"/);
    assert.match(deepagentsConfig, /"completedPhases": \[/);
    assert.equal(outputEntries.includes(".git"), true);
  } finally {
    process.chdir(previousCwd);
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
});

test("planning payload passes plan-spec schema validation as a blocking hard constraint to the agent", () => {
  const runtime = buildTestRuntime();
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
  };

  const payload = buildPlanProjectPayload(spec, runtime) as {
    hardConstraints: {
      planSpecSchemaValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
    };
    planSpecSchema: unknown;
  };

  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactKey, "artifacts.planSpec");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactPath, "/.deepagents/plan-spec.json");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.blocking, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.required, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.mustValidateBeforeResponse, true);
  assert.match(payload.hardConstraints.planSpecSchemaValidation.rules.join("\n"), /空字符串/);
  assert.ok(payload.planSpecSchema);
});

test("plan-repair payload preserves the blocking hard constraint for plan-spec schema validation", () => {
  const payload = buildPlanRepairPayload(buildTestRuntime({
    planAttempt: 2,
    retryReasons: ["artifacts.planSpec 鏍￠獙澶辫触锛歱ages.0.resourceName"],
  })) as {
    hardConstraints: {
      planSpecSchemaValidation: {
        artifactKey: string;
        artifactPath: string;
        blocking: boolean;
        required: boolean;
        mustValidateBeforeResponse: boolean;
        rules: string[];
      };
    };
    planSpecSchema: unknown;
  };

  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactKey, "artifacts.planSpec");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.artifactPath, "/.deepagents/plan-spec.json");
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.blocking, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.required, true);
  assert.equal(payload.hardConstraints.planSpecSchemaValidation.mustValidateBeforeResponse, true);
  assert.match(payload.hardConstraints.planSpecSchemaValidation.rules.join("\n"), /非空字符串/);
  assert.ok(payload.planSpecSchema);
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
  assert.match(planPromptSource, /`\/\.deepagents\/source-prd\.md`/);
  assert.match(planPromptSource, /`sourcePrdMarkdown` 为主事实来源/);
  assert.match(planPromptSource, /只有在 `sourcePrdMarkdown` 缺失、截断或明显不可用时，才允许读取 `artifacts\.sourcePrd`/);
  assert.match(planPromptSource, /严禁对同一文件、同一区间做重复读取循环/);
  assert.match(planPromptSource, /对当前尚不存在的 `artifacts\.analysis`、`artifacts\.generatedSpec`、`artifacts\.planSpec`，应直接创建/);
  assert.match(planPromptSource, /`\/\.deepagents\/prd-analysis\.md`/);
  assert.match(planPromptSource, /`hardConstraints\.planSpecSchemaValidation`/);
  assert.match(planPromptSource, /空字符串/);
  assert.match(planPromptSource, /把 `\/\.deepagents\/\.\.\.` 改成 `\/deepagents\/\.\.\.`/);
  assert.match(generatePromptSource, /`planSpec` 是唯一事实来源/);
  assert.match(generatePromptSource, /不能重新分析原始 PRD/);
  assert.match(generatePromptSource, /禁止执行：调用任何子代理/);
  assert.match(generatePromptSource, /implementedPages/);
  assert.match(generatePromptSource, /必须先调用一次 `write_todos`/);
  assert.match(generatePromptSource, /必须持续更新 todo 状态/);
  assert.match(generatePromptSource, /必须先读取 `\/\.deepagents\/references\/generated-app-architecture\.md`/);
  assert.match(generatePromptSource, /route groups、shell、context、sidebar 和鉴权约定/);
  assert.match(generatePromptSource, /`\/\.deepagents\/plan-spec\.json`/);
  assert.match(generatePromptSource, /`\/app-builder-report\.md`/);
  assert.match(generatePromptSource, /持久化、鉴权或启动契约/);
  assert.match(generatePromptSource, /Prisma 配置、schema、seed、脚本/);
  assert.match(generatePromptSource, /schema、seed、脚本、认证\/会话和默认入口数据/);
  assert.match(generatePromptSource, /按输入里的 `template\.runtimeValidation` 执行运行验证/);
  assert.match(generatePromptSource, /把 `\/app-builder-report\.md` 改成 `\/app\/app-builder-report\.md`/);
  assert.match(generatePromptSource, /页面实现必须严格以 `planSpec\.pages\[\*\]\.route` 为准/);
  assert.match(generatePromptSource, /所有承载业务数据的页面必须对接 `planSpec\.apis` 中定义的 Route Handlers/);
  assert.match(generatePromptSource, /禁止在页面组件中用 mock 数据、演示数组、硬编码业务统计、`Math\.random\(\)` 模拟刷新/);
  assert.match(generatePromptSource, /若现有 API 不足以支撑页面展示，先按 `planSpec` 补齐 API，再完成页面接线/);
  assert.match(planRepairPromptSource, /validationFailures/);
  assert.match(planRepairPromptSource, /`hardConstraints\.planSpecSchemaValidation`/);
  assert.match(planRepairPromptSource, /空字符串/);
  assert.match(planRepairPromptSource, /禁止执行：调用任何子代理/);
  assert.match(planRepairPromptSource, /只补齐缺失或错误部分/);
  assert.match(planRepairPromptSource, /`\/\.deepagents\/source-prd\.md`/);
  assert.match(generateRepairPromptSource, /validationFailures/);
  assert.match(generateRepairPromptSource, /禁止执行：调用任何子代理/);
  assert.match(generateRepairPromptSource, /只补齐缺失实现或错误接线/);
  assert.match(generateRepairPromptSource, /页面修复必须严格以 `planSpec\.pages\[\*\]\.route` 为准/);
  assert.match(generateRepairPromptSource, /`\/\.deepagents\/generation-validation\.json`/);
  assert.match(generateRepairPromptSource, /`\/\.deepagents\/runtime-validation\.log`/);
  assert.match(generateRepairPromptSource, /持久化、鉴权或启动契约被局部改坏/);
  assert.match(generateRepairPromptSource, /Prisma 配置、schema、seed、脚本/);
  assert.match(generateRepairPromptSource, /schema、seed、脚本、认证\/会话和默认入口数据/);
  assert.match(generateRepairPromptSource, /`\/app-builder-report\.md`/);
  assert.match(generateRepairPromptSource, /如果现有页面仍使用 mock 数据、演示数组、硬编码业务统计、`Math\.random\(\)` 模拟结果/);
  assert.match(generateRepairPromptSource, /必须改为对接 `planSpec\.apis` 中对应的 Route Handlers/);
});
