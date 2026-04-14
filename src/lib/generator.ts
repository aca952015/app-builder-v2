import path from "node:path";
import { promises as fs } from "node:fs";

import { prepareOutputWorkspace, writeDeepagentsConfig } from "./output-workspace.js";
import { parsePrd } from "./prd-parser.js";
import { normalizeSpec } from "./spec-normalizer.js";
import { copyStarterScaffold, loadTemplatePack, stageTemplatePack } from "./template-pack.js";
import { DeepAgentsTextGenerator } from "./text-generator.js";
import { GenerateAppOptions, GenerationReport, GenerationResult, NormalizedSpec, ParsedPrd, TextGeneratorRuntime } from "./types.js";

const ANALYSIS_PLACEHOLDER = [
  "# PRD Analysis",
  "",
  "deepagents 将在运行过程中更新这份分析稿。",
  "",
].join("\n");

const GENERATED_SPEC_PLACEHOLDER = [
  "# Generated Spec",
  "",
  "deepagents 将在运行过程中更新这份详细 spec。",
  "",
].join("\n");

function isPlaceholderOrInsufficient(contents: string, placeholder: string, requiredMarkers: string[]): boolean {
  const normalized = contents.trim();
  if (normalized === placeholder.trim()) {
    return true;
  }

  if (normalized.length < 80) {
    return true;
  }

  return requiredMarkers.some((marker) => !normalized.includes(marker));
}

function buildDetailedSpecFallback(spec: NormalizedSpec): string {
  const entities = spec.entities
    .map((entity) => [
      `### ${entity.name}`,
      "",
      `- 路由段：\`${entity.routeSegment}\``,
      `- 描述：${entity.description}`,
      "- 字段：",
      ...entity.fields.map((field) => `  - ${field.name} (${field.type}${field.required ? ", required" : ", optional"})`),
      "",
    ].join("\n"))
    .join("\n");

  return [
    `# ${spec.appName} 生成用 Spec`,
    "",
    "## 产品概述",
    "",
    spec.summary,
    "",
    "## 用户角色",
    "",
    ...spec.roles.map((role) => `- ${role}`),
    "",
    "## 数据模型",
    "",
    entities || "- 无",
    "",
    "## 页面清单",
    "",
    ...spec.screens.map((screen) => `- ${screen.name} (${screen.route}): ${screen.purpose}`),
    "",
    "## 核心流程",
    "",
    ...spec.flows.map((flow) => `- ${flow}`),
    "",
    "## 业务规则",
    "",
    ...spec.businessRules.map((rule) => `- ${rule}`),
    "",
    "## 默认假设",
    "",
    ...(spec.defaultsApplied.length > 0 ? spec.defaultsApplied.map((item) => `- ${item}`) : ["- 无"]),
    "",
    "## 风险与警告",
    "",
    ...(spec.warnings.length > 0 ? spec.warnings.map((item) => `- ${item}`) : ["- 无"]),
    "",
  ].join("\n");
}

function buildAnalysisFallback(parsed: ParsedPrd, spec: NormalizedSpec): string {
  return [
    `# ${spec.appName} PRD 分析稿`,
    "",
    "## 产品目标",
    "",
    parsed.summary || spec.summary,
    "",
    "## 用户角色",
    "",
    ...(spec.roles.length > 0 ? spec.roles.map((role) => `- ${role}`) : ["- 未明确角色，已按通用内部工具处理"]),
    "",
    "## 实体与核心对象",
    "",
    ...(spec.entities.length > 0
      ? spec.entities.map((entity) => `- ${entity.name}: ${entity.description}`)
      : ["- 未识别到明确业务实体"]),
    "",
    "## 页面与信息架构",
    "",
    ...(spec.screens.length > 0
      ? spec.screens.map((screen) => `- ${screen.name} (${screen.route}): ${screen.purpose}`)
      : ["- 未识别到明确页面"]),
    "",
    "## 关键流程",
    "",
    ...(spec.flows.length > 0 ? spec.flows.map((flow) => `- ${flow}`) : ["- 未识别到明确流程"]),
    "",
    "## 业务规则与约束",
    "",
    ...(spec.businessRules.length > 0 ? spec.businessRules.map((rule) => `- ${rule}`) : ["- 未识别到明确规则"]),
    "",
    "## 默认假设",
    "",
    ...(spec.defaultsApplied.length > 0 ? spec.defaultsApplied.map((item) => `- ${item}`) : ["- 无"]),
    "",
    "## 风险与待确认项",
    "",
    ...(spec.warnings.length > 0 ? spec.warnings.map((item) => `- ${item}`) : ["- 无"]),
    "",
  ].join("\n");
}

async function collectGeneratedFiles(outputDirectory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(outputDirectory, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (relativePath === ".deepagents") {
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
  await copyStarterScaffold(template, workspace.outputDirectory);

  const sourceMarkdown = await fs.readFile(options.specPath, "utf8");
  const parsed = parsePrd(sourceMarkdown);
  const spec = normalizeSpec(parsed, sourceMarkdown, options.appNameOverride);
  await fs.writeFile(workspace.sourcePrdSnapshotPath, sourceMarkdown, "utf8");
  await fs.writeFile(
    workspace.normalizedSpecSnapshotPath,
    `${JSON.stringify(spec, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    workspace.deepagentsAnalysisPath,
    ANALYSIS_PLACEHOLDER,
    "utf8",
  );
  await fs.writeFile(
    workspace.deepagentsDetailedSpecPath,
    buildDetailedSpecFallback(spec),
    "utf8",
  );

  const generator =
    options.generator ??
    (() => {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required.");
      }
      return new DeepAgentsTextGenerator();
    })();

  await writeDeepagentsConfig(workspace, {
    sessionId: workspace.sessionId,
    startedAt: new Date().toISOString(),
    appName: spec.appName,
    model: process.env.APP_BUILDER_MODEL || "openai:gpt-4.1-mini",
    artifacts: {
      sourcePrd: ".deepagents/source-prd.md",
      normalizedSpec: ".deepagents/normalized-spec.json",
      analysis: ".deepagents/prd-analysis.md",
      generatedSpec: ".deepagents/generated-spec.md",
      errorLog: ".deepagents/error.log",
    },
    template: templateLock,
  });

  const runtime: TextGeneratorRuntime = {
    sessionId: workspace.sessionId,
    outputDirectory: workspace.outputDirectory,
    deepagentsDirectory: workspace.deepagentsDirectory,
    deepagentsLogPath: workspace.deepagentsLogPath,
    deepagentsErrorLogPath: workspace.deepagentsErrorLogPath,
    deepagentsConfigPath: workspace.deepagentsConfigPath,
    deepagentsPromptSnapshotPath: workspace.deepagentsPromptSnapshotPath,
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    templateDirectory: workspace.deepagentsTemplateDirectory,
    templateSystemPromptPath: path.join(workspace.deepagentsTemplateDirectory, template.systemPromptRelativePath),
    sourcePrdSnapshotPath: workspace.sourcePrdSnapshotPath,
    normalizedSpecSnapshotPath: workspace.normalizedSpecSnapshotPath,
    deepagentsAnalysisPath: workspace.deepagentsAnalysisPath,
    deepagentsDetailedSpecPath: workspace.deepagentsDetailedSpecPath,
  };
  await generator.generateProject(spec, runtime);
  const analysisContents = await fs.readFile(workspace.deepagentsAnalysisPath, "utf8");
  if (isPlaceholderOrInsufficient(analysisContents, ANALYSIS_PLACEHOLDER, ["## 产品目标", "## 用户角色"])) {
    await fs.writeFile(workspace.deepagentsAnalysisPath, buildAnalysisFallback(parsed, spec), "utf8");
  }
  const detailedSpecContents = await fs.readFile(workspace.deepagentsDetailedSpecPath, "utf8");
  if (
    isPlaceholderOrInsufficient(
      detailedSpecContents,
      GENERATED_SPEC_PLACEHOLDER,
      ["## 产品概述", "## 数据模型", "## 页面清单"],
    )
  ) {
    await fs.writeFile(workspace.deepagentsDetailedSpecPath, buildDetailedSpecFallback(spec), "utf8");
  }
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
}
