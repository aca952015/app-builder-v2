import path from "node:path";
import { promises as fs } from "node:fs";

import { prepareOutputWorkspace, writeDeepagentsConfig } from "./output-workspace.js";
import { parsePrd } from "./prd-parser.js";
import { normalizeSpec } from "./spec-normalizer.js";
import { copyStarterScaffold, loadTemplatePack, stageTemplatePack } from "./template-pack.js";
import { DeepAgentsTextGenerator } from "./text-generator.js";
import { GenerateAppOptions, GeneratedProject, GenerationReport, GenerationResult, TextGeneratorRuntime } from "./types.js";

const MAX_AGENT_COMPLETION_RETRIES = 2;
type RetryStage = "计划阶段" | "生成阶段";

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

async function validateRequiredArtifacts(outputDirectory: string, runtime: TextGeneratorRuntime, result: GeneratedProject): Promise<{
  reasons: string[];
  retryStage: RetryStage;
}> {
  const reasons: string[] = [];
  const nonPlanningFiles = result.filesWritten.filter(
    (file) => !file.startsWith(".deepagents/"),
  );

  const analysisContents = await readIfExists(runtime.deepagentsAnalysisPath);
  if (!analysisContents || analysisContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.analysis 尚未落盘有效内容。");
  }

  const detailedSpecContents = await readIfExists(runtime.deepagentsDetailedSpecPath);
  if (!detailedSpecContents || detailedSpecContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.generatedSpec 尚未落盘有效内容。");
  }

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

  const retryStage: RetryStage =
    reasons.some((reason) => reason.startsWith("计划阶段")) ? "计划阶段" : "生成阶段";

  return {
    reasons,
    retryStage,
  };
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
    artifacts: {
      sourcePrd: ".deepagents/source-prd.md",
      analysis: ".deepagents/prd-analysis.md",
      generatedSpec: ".deepagents/generated-spec.md",
      errorLog: ".deepagents/error.log",
    },
    template: templateLock,
  });

  let generatedProject: GeneratedProject | null = null;
  let retryReasons: string[] = [];
  let retryStage: RetryStage = "计划阶段";
  const maxAttempts = MAX_AGENT_COMPLETION_RETRIES + 1;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    if (attemptIndex > 0) {
      await appendRetryNote(workspace.deepagentsErrorLogPath, attemptIndex, retryStage, retryReasons);
    }

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
      templateSystemPromptPath: template.systemPromptPath,
      sourcePrdSnapshotPath: workspace.sourcePrdSnapshotPath,
      deepagentsAnalysisPath: workspace.deepagentsAnalysisPath,
      deepagentsDetailedSpecPath: workspace.deepagentsDetailedSpecPath,
      analysisAttempt: attemptIndex + 1,
      maxAnalysisRetries: MAX_AGENT_COMPLETION_RETRIES,
      retryStage,
      ...(retryReasons.length > 0 ? { retryReasons } : {}),
    };

    generatedProject = await generator.generateProject(spec, runtime);
    const validation = await validateRequiredArtifacts(workspace.outputDirectory, runtime, generatedProject);
    if (validation.reasons.length === 0) {
      break;
    }

    retryReasons = validation.reasons;
    retryStage = validation.retryStage;

    if (attemptIndex === maxAttempts - 1) {
      throw new Error(`Agent completion validation failed: ${validation.reasons.join(" | ")}`);
    }
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
