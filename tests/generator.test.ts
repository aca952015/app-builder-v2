import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type PlanSpec } from "../src/lib/plan-spec.js";
import { generateApplication } from "../src/lib/generator.js";
import { copyStarterScaffold, loadTemplatePack } from "../src/lib/template-pack.js";
import { NormalizedSpec, TextGenerator, TextGeneratorRuntime } from "../src/lib/types.js";

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
    await mkdir(path.join(runtime.outputDirectory, "generated"), { recursive: true });
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Stub Report\n\nGenerated during test.\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "generated", "marker.txt"),
      "stub-generator-ran\n",
      "utf8",
    );

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
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Retry Report\n\nArtifacts repaired during retry.\n",
      "utf8",
    );

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
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Generation Report\n\nRepair coverage.\n",
      "utf8",
    );

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
    await mkdir(path.join(runtime.outputDirectory, "app"), { recursive: true });
    await mkdir(path.join(runtime.outputDirectory, "generated"), { recursive: true });
    await writeFile(
      path.join(runtime.outputDirectory, "app", "app-builder-report.md"),
      "# Misplaced Report\n\nThis was incorrectly written beneath /app.\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "generated", "marker.txt"),
      "misplaced-artifacts-recovered\n",
      "utf8",
    );

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
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# REST Split Report\n\nGeneration succeeded.\n",
      "utf8",
    );

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
    });

    assert.ok(result.files.includes("package.json"));
    assert.ok(result.files.includes("prisma/schema.prisma"));
    assert.ok(result.files.includes("app-builder-report.md"));
    assert.ok(result.files.includes("generated/marker.txt"));

    const packageJson = await readFile(path.join(result.outputDirectory, "package.json"), "utf8");
    const gitHead = await readFile(path.join(result.outputDirectory, ".git/HEAD"), "utf8");
    const npmrc = await readFile(path.join(result.outputDirectory, ".npmrc"), "utf8");
    const gitignore = await readFile(path.join(result.outputDirectory, ".gitignore"), "utf8");
    const envExample = await readFile(path.join(result.outputDirectory, ".env.example"), "utf8");
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
    assert.match(envExample, /file:\.\/dev\.db/);
    assert.match(schema, /provider = "sqlite"/);
    assert.match(seed, /demo@example\.com/);
    assert.equal(sidebarMenu.length > 0, true);
    assert.equal(sidebarMenu.some((item) => item.label === "Workspace"), true);
    assert.match(templateLock, /"plan": "prompts\/plan-system-prompt\.md"/);
    assert.match(templateLock, /"planRepair": "prompts\/plan-repair-system-prompt\.md"/);
    assert.match(templateLock, /"generate": "prompts\/generate-system-prompt\.md"/);
    assert.match(templateLock, /"generateRepair": "prompts\/generate-repair-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"plan": "prompts\/plan-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"planRepair": "prompts\/plan-repair-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generate": "prompts\/generate-system-prompt\.md"/);
    assert.match(stagedTemplateManifest, /"generateRepair": "prompts\/generate-repair-system-prompt\.md"/);
    assert.match(planPromptSnapshot, /artifacts\.planSpec/);
    assert.match(planPromptSnapshot, /唯一职责是把原始 PRD 收敛为一份可验证/);
    assert.match(planPromptSnapshot, /`sourcePrdMarkdown` 为主事实来源/);
    assert.match(planPromptSnapshot, /不要为了“确认一下”再次反复读取 `artifacts\.sourcePrd`/);
    assert.match(planRepairPromptSnapshot, /计划修复阶段代理/);
    assert.match(planRepairPromptSnapshot, /validationFailures/);
    assert.match(generatePromptSnapshot, /当前输入中的 `planSpec` 是唯一事实来源/);
    assert.match(generatePromptSnapshot, /implementedResources/);
    assert.match(generateRepairPromptSnapshot, /生成修复阶段代理/);
    assert.match(generateRepairPromptSnapshot, /validationFailures/);
    assert.match(sourcePrdSnapshot, /# Field Ops Planner/);
    assert.match(analysisSnapshot, /# Stub 需求分析报告/);
    assert.match(generatedSpecSnapshot, /# Stub 实施详细设计规格书/);
    assert.equal(planSpec.version, 1);
    assert.equal(planSpec.resources[0]?.name, "WorkOrder");
    assert.equal(planSpec.apis[0]?.path, "/app/api/work-orders/route.ts");
    assert.match(planValidationSnapshot, /"valid": true/);
    assert.match(generationValidationSnapshot, /"valid": true/);
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
      /未被声明为已实现：WorkOrder|未被声明为已实现：\/work-orders/,
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

    assert.ok(copied.includes("package.json"));
    assert.ok(copied.includes("app/layout.tsx"));
    assert.ok(copied.includes("lib/session.ts"));
    assert.ok(copied.includes("prisma/schema.prisma"));
    assert.ok(copied.includes("prisma/seed.ts"));
    assert.ok(copied.includes("config/sidebar-menu.json"));

    const starterPackage = await readFile(path.join(tempRoot, "package.json"), "utf8");
    const starterLayout = await readFile(path.join(tempRoot, "app/layout.tsx"), "utf8");
    const starterEnv = await readFile(path.join(tempRoot, ".env.example"), "utf8");
    const starterSchema = await readFile(path.join(tempRoot, "prisma/schema.prisma"), "utf8");
    const starterMenu = JSON.parse(
      await readFile(path.join(tempRoot, "config/sidebar-menu.json"), "utf8"),
    ) as Array<Record<string, unknown>>;

    assert.match(starterPackage, /"next"/);
    assert.match(starterPackage, /"db:init"/);
    assert.match(starterPackage, /"@tailwindcss\/postcss"/);
    assert.match(starterLayout, /Generated App/);
    assert.match(starterEnv, /file:\.\/dev\.db/);
    assert.match(starterSchema, /provider = "sqlite"/);
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
  assert.match(architectureSource, /SQLite/);
  assert.match(architectureSource, /TailAdmin/);
  assert.match(architectureSource, /route groups/);
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
  assert.match(generatePromptSource, /把 `\/app-builder-report\.md` 改成 `\/app\/app-builder-report\.md`/);
  assert.match(planRepairPromptSource, /validationFailures/);
  assert.match(planRepairPromptSource, /禁止执行：调用任何子代理/);
  assert.match(planRepairPromptSource, /只补齐缺失或错误部分/);
  assert.match(planRepairPromptSource, /`\/\.deepagents\/source-prd\.md`/);
  assert.match(generateRepairPromptSource, /validationFailures/);
  assert.match(generateRepairPromptSource, /禁止执行：调用任何子代理/);
  assert.match(generateRepairPromptSource, /只补齐缺失实现或错误接线/);
  assert.match(generateRepairPromptSource, /`\/\.deepagents\/generation-validation\.json`/);
  assert.match(generateRepairPromptSource, /`\/app-builder-report\.md`/);
});
