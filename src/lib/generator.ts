import path from "node:path";
import { promises as fs } from "node:fs";

import { validatePlanSpec, type PlanSpec } from "./plan-spec.js";
import { prepareOutputWorkspace, writeDeepagentsConfig } from "./output-workspace.js";
import { parsePrd } from "./prd-parser.js";
import { normalizeSpec } from "./spec-normalizer.js";
import { copyStarterScaffold, loadTemplatePack, stageTemplatePack } from "./template-pack.js";
import { DeepAgentsTextGenerator } from "./text-generator.js";
import {
  appendWorkflowLog,
  closeWorkflowBoard,
  createArtifactItemsForStage,
  createStepItemsForLifecycle,
  updateWorkflowBoard,
} from "./terminal-ui.js";
import {
  GenerateAppOptions,
  GeneratedProject,
  GenerationReport,
  GenerationResult,
  PlanResult,
  TextGeneratorRuntime,
} from "./types.js";

const MAX_PLAN_REPAIRS = 2;
const MAX_GENERATION_REPAIRS = 2;
type RetryStage = "计划阶段" | "计划修复阶段" | "生成阶段" | "生成修复阶段";

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

function resolveAppPrefixedPath(outputDirectory: string, filePath: string): string {
  const relativePath = path.relative(outputDirectory, filePath);
  return path.join(outputDirectory, "app", relativePath);
}

async function relocateIfWrittenUnderApp(outputDirectory: string, filePath: string): Promise<string | null> {
  const currentContents = await readIfExists(filePath);
  if (currentContents && currentContents.trim().length > 0) {
    return null;
  }

  const misplacedPath = resolveAppPrefixedPath(outputDirectory, filePath);
  const misplacedContents = await readIfExists(misplacedPath);
  if (!misplacedContents || misplacedContents.trim().length === 0) {
    return null;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, misplacedContents, "utf8");
  await fs.rm(misplacedPath, { force: true });
  return path.relative(outputDirectory, misplacedPath).split(path.sep).join("/");
}

async function reconcileHostManagedArtifacts(runtime: TextGeneratorRuntime, targets: string[]): Promise<void> {
  for (const target of targets) {
    const relocatedFrom = await relocateIfWrittenUnderApp(runtime.outputDirectory, target);
    if (!relocatedFrom) {
      continue;
    }

    const relocatedTo = path.relative(runtime.outputDirectory, target).split(path.sep).join("/");
    await appendWorkflowLog(`[host] 检测到误写路径 ${relocatedFrom}，已归位到 ${relocatedTo}。`);
  }
}

function collectPlanSpecConsistencyIssues(planSpec: PlanSpec): string[] {
  const issues: string[] = [];
  const resourceNames = new Set(planSpec.resources.map((resource) => resource.name));
  const resourceRouteSegments = new Set<string>();
  const pageRoutes = new Set<string>();
  const apiPaths = new Set<string>();
  const apiOperations = new Set<string>();

  for (const resource of planSpec.resources) {
    if (resourceRouteSegments.has(resource.routeSegment)) {
      issues.push(`resources 中存在重复的 routeSegment：${resource.routeSegment}`);
    }
    resourceRouteSegments.add(resource.routeSegment);
  }

  for (const page of planSpec.pages) {
    if (pageRoutes.has(page.route)) {
      issues.push(`pages 中存在重复的 route：${page.route}`);
    }
    pageRoutes.add(page.route);

    if (page.resourceName && !resourceNames.has(page.resourceName)) {
      issues.push(`页面 ${page.route} 引用了未定义资源 ${page.resourceName}`);
    }
  }

  for (const api of planSpec.apis) {
    apiPaths.add(api.path);

    for (const method of api.methods) {
      const operationKey = `${api.path}#${method}`;
      if (apiOperations.has(operationKey)) {
        issues.push(`apis 中存在重复的 path+method：${method} ${api.path}`);
      }
      apiOperations.add(operationKey);
    }

    if (!resourceNames.has(api.resourceName)) {
      issues.push(`接口 ${api.path} 引用了未定义资源 ${api.resourceName}`);
    }
  }

  for (const resource of planSpec.resources) {
    if (!planSpec.pages.some((page) => page.resourceName === resource.name)) {
      issues.push(`资源 ${resource.name} 缺少页面映射`);
    }
    if (!planSpec.apis.some((api) => api.resourceName === resource.name)) {
      issues.push(`资源 ${resource.name} 缺少 REST API 规划`);
    }
  }

  for (const check of planSpec.acceptanceChecks) {
    if (check.type === "resource" && !resourceNames.has(check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义资源 ${check.target}`);
    }
    if (check.type === "page" && !pageRoutes.has(check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义页面 ${check.target}`);
    }
    if (check.type === "api" && !apiPaths.has(check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义接口 ${check.target}`);
    }
    if (check.type === "flow" && !planSpec.flows.some((flow) => flow.name === check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义流程 ${check.target}`);
    }
  }

  return issues;
}

async function writePlanValidationResult(
  validationPath: string,
  payload: {
    valid: boolean;
    reasons: string[];
    planSpecVersion?: number;
  },
): Promise<void> {
  await fs.writeFile(validationPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeGenerationValidationResult(
  validationPath: string,
  payload: {
    valid: boolean;
    reasons: string[];
  },
): Promise<void> {
  await fs.writeFile(validationPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function updateWorkflowState(
  configPath: string,
  phase: "plan" | "plan_repair" | "generate" | "generate_repair" | "complete",
  completedPhases: Array<"plan" | "generate">,
): Promise<void> {
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  config.workflow = {
    phase,
    completedPhases,
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function validatePlanArtifacts(runtime: TextGeneratorRuntime, result: PlanResult): Promise<{
  reasons: string[];
  planSpec: PlanSpec | null;
}> {
  await reconcileHostManagedArtifacts(runtime, [
    runtime.deepagentsAnalysisPath,
    runtime.deepagentsDetailedSpecPath,
    runtime.deepagentsPlanSpecPath,
  ]);

  const reasons: string[] = [];

  const analysisContents = await readIfExists(runtime.deepagentsAnalysisPath);
  if (!analysisContents || analysisContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.analysis 尚未落盘有效内容。");
  }

  const detailedSpecContents = await readIfExists(runtime.deepagentsDetailedSpecPath);
  if (!detailedSpecContents || detailedSpecContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.generatedSpec 尚未落盘有效内容。");
  }

  let planSpec: PlanSpec | null = null;
  const planSpecContents = await readIfExists(runtime.deepagentsPlanSpecPath);
  if (!planSpecContents || planSpecContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.planSpec 尚未落盘有效内容。");
  } else {
    try {
      const parsed = JSON.parse(planSpecContents);
      const validation = validatePlanSpec(parsed);
      if (!validation.success) {
        reasons.push(...validation.issues.map((issue) => `计划阶段未完成：artifacts.planSpec 校验失败：${issue}`));
      } else {
        planSpec = validation.data;
        reasons.push(...collectPlanSpecConsistencyIssues(planSpec).map(
          (issue) => `计划阶段未完成：artifacts.planSpec 一致性校验失败：${issue}`,
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reasons.push(`计划阶段未完成：artifacts.planSpec 不是合法 JSON：${message}`);
    }
  }

  if (result.planSpecVersion !== 1) {
    reasons.push(`计划阶段未完成：结构化结果返回了不支持的 planSpecVersion=${result.planSpecVersion}。`);
  }

  if (result.artifactsWritten.length === 0) {
    reasons.push("计划阶段未完成：结构化结果中的 artifactsWritten 为空，说明本轮没有明确报告计划产物。");
  }

  await writePlanValidationResult(runtime.deepagentsPlanValidationPath, {
    valid: reasons.length === 0,
    reasons,
    ...(planSpec ? { planSpecVersion: planSpec.version } : {}),
  });

  return {
    reasons,
    planSpec,
  };
}

async function validateGeneratedArtifacts(
  outputDirectory: string,
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
  result: GeneratedProject,
): Promise<{ reasons: string[] }> {
  await reconcileHostManagedArtifacts(runtime, [path.join(outputDirectory, "app-builder-report.md")]);

  const reasons: string[] = [];
  const nonPlanningFiles = result.filesWritten.filter((file) => !file.startsWith(".deepagents/"));

  if (result.filesWritten.length === 0) {
    reasons.push("生成阶段未完成：结构化结果中的 filesWritten 为空，说明本轮没有明确报告已落盘文件。");
  } else if (nonPlanningFiles.length === 0) {
    reasons.push("生成阶段未完成：本轮只报告了计划阶段 artifacts，没有报告任何应用源码或交付文件。");
  }

  const reportPath = path.join(outputDirectory, "app-builder-report.md");
  const reportContents = await readIfExists(reportPath);
  if (nonPlanningFiles.length > 0 && (!reportContents || reportContents.trim().length === 0)) {
    reasons.push("生成阶段未完成：app-builder-report.md 尚未落盘。");
  }

  const implementedResources = new Set(result.implementedResources);
  const implementedPages = new Set(result.implementedPages);
  const implementedApis = new Set(result.implementedApis);

  const missingResources = planSpec.resources
    .map((resource) => resource.name)
    .filter((name) => !implementedResources.has(name));
  if (missingResources.length > 0) {
    reasons.push(`生成阶段未完成：以下资源未被声明为已实现：${missingResources.join(", ")}。`);
  }

  const missingPages = planSpec.pages
    .map((page) => page.route)
    .filter((route) => !implementedPages.has(route));
  if (missingPages.length > 0) {
    reasons.push(`生成阶段未完成：以下页面未被声明为已实现：${missingPages.join(", ")}。`);
  }

  const missingApis = planSpec.apis
    .map((api) => api.path)
    .filter((apiPath) => !implementedApis.has(apiPath));
  if (missingApis.length > 0) {
    reasons.push(`生成阶段未完成：以下接口未被声明为已实现：${missingApis.join(", ")}。`);
  }

  await writeGenerationValidationResult(runtime.deepagentsGenerationValidationPath, {
    valid: reasons.length === 0,
    reasons,
  });

  return { reasons };
}

async function appendRetryNote(logPath: string, attempt: number, stage: RetryStage, reasons: string[]): Promise<void> {
  const lines = [
    `[${new Date().toISOString()}]`,
    `Retry attempt ${attempt} triggered for ${stage} because:`,
    ...reasons.map((reason) => `- ${reason}`),
    "",
  ];
  await fs.appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
}

async function collectGeneratedFiles(outputDirectory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(outputDirectory, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (relativePath === ".deepagents" || relativePath === ".git") {
          continue;
        }
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (relativePath === "template-lock.json") {
        continue;
      }

      files.push(relativePath);
    }
  }

  await visit(outputDirectory);
  return files.sort();
}

export async function generateApplication(options: GenerateAppOptions): Promise<GenerationResult> {
  try {
    const workspaceOptions: {
      outputDirectory?: string;
      force?: boolean;
    } = {};

    if (options.outputDirectory) {
      workspaceOptions.outputDirectory = options.outputDirectory;
    }

    if (options.force !== undefined) {
      workspaceOptions.force = options.force;
    }

    const workspace = await prepareOutputWorkspace(workspaceOptions);
    const template = await loadTemplatePack(options.templateId);
    const templateLock = await stageTemplatePack(template, workspace);

    const sourceMarkdown = await fs.readFile(options.specPath, "utf8");
    const parsed = parsePrd(sourceMarkdown);
    const spec = normalizeSpec(parsed, sourceMarkdown, options.appNameOverride);
    await fs.writeFile(workspace.sourcePrdSnapshotPath, sourceMarkdown, "utf8");

    const generator =
      options.generator ??
      (() => {
        if (!process.env.OPENAI_API_KEY) {
          throw new Error("OPENAI_API_KEY is required.");
        }
        return new DeepAgentsTextGenerator();
      })();
    await copyStarterScaffold(template, workspace.outputDirectory);

    await writeDeepagentsConfig(workspace, {
      sessionId: workspace.sessionId,
      startedAt: new Date().toISOString(),
      appName: spec.appName,
      model: process.env.APP_BUILDER_MODEL || "openai:gpt-4.1-mini",
      workflow: {
        phase: "plan",
        completedPhases: [],
      },
      artifacts: {
        sourcePrd: ".deepagents/source-prd.md",
        analysis: ".deepagents/prd-analysis.md",
        generatedSpec: ".deepagents/generated-spec.md",
        planSpec: ".deepagents/plan-spec.json",
        planValidation: ".deepagents/plan-validation.json",
        generationValidation: ".deepagents/generation-validation.json",
        errorLog: ".deepagents/error.log",
      },
      prompts: {
        plan: ".deepagents/plan-system-prompt.md",
        planRepair: ".deepagents/plan-repair-system-prompt.md",
        generate: ".deepagents/generate-system-prompt.md",
        generateRepair: ".deepagents/generate-repair-system-prompt.md",
      },
      template: templateLock,
    });

    const createRuntime = (overrides: Partial<TextGeneratorRuntime> = {}): TextGeneratorRuntime => ({
      sessionId: workspace.sessionId,
      outputDirectory: workspace.outputDirectory,
      deepagentsDirectory: workspace.deepagentsDirectory,
      deepagentsLogPath: workspace.deepagentsLogPath,
      deepagentsErrorLogPath: workspace.deepagentsErrorLogPath,
      deepagentsConfigPath: workspace.deepagentsConfigPath,
      deepagentsPlanPromptSnapshotPath: workspace.deepagentsPlanPromptSnapshotPath,
      deepagentsPlanRepairPromptSnapshotPath: workspace.deepagentsPlanRepairPromptSnapshotPath,
      deepagentsGeneratePromptSnapshotPath: workspace.deepagentsGeneratePromptSnapshotPath,
      deepagentsGenerateRepairPromptSnapshotPath: workspace.deepagentsGenerateRepairPromptSnapshotPath,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      templateDirectory: workspace.deepagentsTemplateDirectory,
      templatePlanPromptPath: template.planPromptPath,
      templatePlanRepairPromptPath: template.planRepairPromptPath,
      templateGeneratePromptPath: template.generatePromptPath,
      templateGenerateRepairPromptPath: template.generateRepairPromptPath,
      sourcePrdSnapshotPath: workspace.sourcePrdSnapshotPath,
      deepagentsAnalysisPath: workspace.deepagentsAnalysisPath,
      deepagentsDetailedSpecPath: workspace.deepagentsDetailedSpecPath,
      deepagentsPlanSpecPath: workspace.deepagentsPlanSpecPath,
      deepagentsPlanValidationPath: workspace.deepagentsPlanValidationPath,
      deepagentsGenerationValidationPath: workspace.deepagentsGenerationValidationPath,
      maxPlanRetries: MAX_PLAN_REPAIRS,
      maxGenerateRetries: MAX_GENERATION_REPAIRS,
      ...overrides,
    });

    let approvedPlan: PlanSpec | null = null;
    let planRetryReasons: string[] = [];

    {
      const initialRuntime = createRuntime({
        planAttempt: 1,
        retryReasons: [],
      });
      const planResult = await generator.planProject(spec, initialRuntime);
      await appendWorkflowLog("[host] 计划阶段流式输出完成，开始宿主校验。");
      await updateWorkflowBoard({
        stage: "计划阶段",
        todos: createStepItemsForLifecycle("计划阶段", "validating"),
        artifacts: createArtifactItemsForStage("计划阶段", "validating"),
        narrative: "正在验证计划阶段产出物。",
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validatePlanArtifacts(initialRuntime, planResult);
      if (validation.reasons.length === 0) {
        approvedPlan = validation.planSpec;
        await appendWorkflowLog("[host] 计划阶段产出物通过校验。");
        await updateWorkflowBoard({
          stage: "计划阶段",
          todos: createStepItemsForLifecycle("计划阶段", "verified"),
          artifacts: createArtifactItemsForStage("计划阶段", "verified"),
          narrative: "计划阶段产出物已验证，通过生成门禁。",
          outputDirectory: workspace.outputDirectory,
        });
      } else {
        planRetryReasons = validation.reasons;
        await appendWorkflowLog(`[host] 计划阶段校验失败，待修复问题 ${validation.reasons.length} 条。`);
      }
    }

    for (let repairIndex = 0; !approvedPlan && repairIndex < MAX_PLAN_REPAIRS; repairIndex += 1) {
      await updateWorkflowState(workspace.deepagentsConfigPath, "plan_repair", []);
      await appendRetryNote(workspace.deepagentsErrorLogPath, repairIndex + 1, "计划修复阶段", planRetryReasons);
      await appendWorkflowLog(`[host] 启动计划修复轮次 ${repairIndex + 1}。`);

      const repairRuntime = createRuntime({
        planAttempt: repairIndex + 2,
        retryReasons: planRetryReasons,
      });
      const repairResult = await generator.planRepairProject(repairRuntime);
      await appendWorkflowLog("[host] 计划修复输出完成，开始复核。");
      await updateWorkflowBoard({
        stage: "计划阶段",
        todos: createStepItemsForLifecycle("计划阶段", "validating"),
        artifacts: createArtifactItemsForStage("计划阶段", "validating"),
        narrative: "正在复核修复后的计划产出物。",
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validatePlanArtifacts(repairRuntime, repairResult);
      if (validation.reasons.length === 0) {
        approvedPlan = validation.planSpec;
        await appendWorkflowLog("[host] 修复后的计划阶段产出物通过校验。");
        await updateWorkflowBoard({
          stage: "计划阶段",
          todos: createStepItemsForLifecycle("计划阶段", "verified"),
          artifacts: createArtifactItemsForStage("计划阶段", "verified"),
          narrative: "计划阶段产出物已验证，通过生成门禁。",
          outputDirectory: workspace.outputDirectory,
        });
        break;
      }

      planRetryReasons = validation.reasons;
      await appendWorkflowLog(`[host] 计划修复轮次 ${repairIndex + 1} 仍未通过，剩余问题 ${validation.reasons.length} 条。`);
    }

    if (!approvedPlan) {
      throw new Error(`Plan validation failed: ${planRetryReasons.join(" | ")}`);
    }

    await updateWorkflowState(workspace.deepagentsConfigPath, "generate", ["plan"]);

    let generationRetryReasons: string[] = [];

    {
      const initialRuntime = createRuntime({
        generateAttempt: 1,
        retryReasons: [],
      });
      const generatedProject = await generator.generateProject(approvedPlan, initialRuntime);
      await appendWorkflowLog("[host] 生成阶段流式输出完成，开始宿主校验。");
      await updateWorkflowBoard({
        stage: "生成阶段",
        todos: createStepItemsForLifecycle("生成阶段", "validating"),
        artifacts: createArtifactItemsForStage("生成阶段", "validating"),
        narrative: "正在验证生成阶段交付物。",
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validateGeneratedArtifacts(workspace.outputDirectory, initialRuntime, approvedPlan, generatedProject);
      if (validation.reasons.length === 0) {
        generationRetryReasons = [];
        await appendWorkflowLog("[host] 生成阶段交付物通过校验。");
        await updateWorkflowBoard({
          stage: "生成阶段",
          todos: createStepItemsForLifecycle("生成阶段", "verified"),
          artifacts: createArtifactItemsForStage("生成阶段", "verified"),
          narrative: "生成阶段交付物已验证，全部通过。",
          outputDirectory: workspace.outputDirectory,
        });
      } else {
        generationRetryReasons = validation.reasons;
        await appendWorkflowLog(`[host] 生成阶段校验失败，待修复问题 ${validation.reasons.length} 条。`);
      }
    }

    for (let repairIndex = 0; generationRetryReasons.length > 0 && repairIndex < MAX_GENERATION_REPAIRS; repairIndex += 1) {
      await updateWorkflowState(workspace.deepagentsConfigPath, "generate_repair", ["plan"]);
      await appendRetryNote(workspace.deepagentsErrorLogPath, repairIndex + 1, "生成修复阶段", generationRetryReasons);
      await appendWorkflowLog(`[host] 启动生成修复轮次 ${repairIndex + 1}。`);

      const repairRuntime = createRuntime({
        generateAttempt: repairIndex + 2,
        retryReasons: generationRetryReasons,
      });
      const repairedProject = await generator.generateRepairProject(approvedPlan, repairRuntime);
      await appendWorkflowLog("[host] 生成修复输出完成，开始复核。");
      await updateWorkflowBoard({
        stage: "生成阶段",
        todos: createStepItemsForLifecycle("生成阶段", "validating"),
        artifacts: createArtifactItemsForStage("生成阶段", "validating"),
        narrative: "正在复核修复后的生成交付物。",
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validateGeneratedArtifacts(workspace.outputDirectory, repairRuntime, approvedPlan, repairedProject);
      if (validation.reasons.length === 0) {
        generationRetryReasons = [];
        await appendWorkflowLog("[host] 修复后的生成交付物通过校验。");
        await updateWorkflowBoard({
          stage: "生成阶段",
          todos: createStepItemsForLifecycle("生成阶段", "verified"),
          artifacts: createArtifactItemsForStage("生成阶段", "verified"),
          narrative: "生成阶段交付物已验证，全部通过。",
          outputDirectory: workspace.outputDirectory,
        });
        break;
      }

      generationRetryReasons = validation.reasons;
      await appendWorkflowLog(`[host] 生成修复轮次 ${repairIndex + 1} 仍未通过，剩余问题 ${validation.reasons.length} 条。`);
    }

    if (generationRetryReasons.length > 0) {
      throw new Error(`Generation validation failed: ${generationRetryReasons.join(" | ")}`);
    }

    await updateWorkflowState(workspace.deepagentsConfigPath, "complete", ["plan", "generate"]);
    await appendWorkflowLog("[host] 全部阶段完成，准备汇总输出。");

    const outputDirectory = workspace.outputDirectory;
    const writtenFiles = await collectGeneratedFiles(outputDirectory);

    const report: GenerationReport = {
      appName: spec.appName,
      templateId: template.id,
      outputDirectory,
      entities: spec.entities.map((entity) => entity.name),
      screens: spec.screens.map((screen) => `${screen.name} (${screen.route})`),
      warnings: spec.warnings,
      defaultsApplied: spec.defaultsApplied,
    };

    return {
      spec,
      sessionId: workspace.sessionId,
      templateId: template.id,
      outputDirectory,
      files: writtenFiles,
      report,
    };
  } finally {
    await closeWorkflowBoard();
  }
}
