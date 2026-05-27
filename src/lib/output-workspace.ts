import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ensureEmptyOutputDirectory } from "./project-writer.js";
import { buildSessionPolicyDocument } from "./session-policy.js";
import { OutputWorkspace } from "./types.js";
import { createWorkspaceArtifactPaths } from "./workspace-artifacts.js";

const execFileAsync = promisify(execFile);

function createSessionId(): string {
  return randomUUID();
}

async function initializeGitRepository(outputDirectory: string): Promise<void> {
  try {
    await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: outputDirectory,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to initialize git repository in ${outputDirectory}: ${message}`);
  }
}

export async function prepareOutputWorkspace(options: {
  outputDirectory?: string;
  force?: boolean;
} = {}): Promise<OutputWorkspace> {
  const sessionId = createSessionId();
  const outputDirectory =
    options.outputDirectory
      ? path.resolve(options.outputDirectory)
      : path.resolve(process.cwd(), ".out", sessionId);

  await ensureEmptyOutputDirectory(outputDirectory, options.force ?? false);
  await initializeGitRepository(outputDirectory);

  const artifacts = createWorkspaceArtifactPaths(outputDirectory);
  await fs.mkdir(artifacts.workspaceDirectory, { recursive: true });
  await fs.mkdir(artifacts.referencesDirectory, { recursive: true });
  await fs.writeFile(artifacts.agentsPath, `${buildSessionPolicyDocument()}\n`, "utf8");

  return {
    sessionId,
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
    deepagentsTemplateDirectory: artifacts.templateDirectory,
    templateLockPath: artifacts.templateLockPath,
    sourcePrdSnapshotPath: artifacts.sourcePrdSnapshotPath,
    deepagentsAnalysisPath: artifacts.analysisPath,
    deepagentsDetailedSpecPath: artifacts.detailedSpecPath,
    deepagentsPlanSpecPath: artifacts.planSpecPath,
    deepagentsPlanValidationPath: artifacts.planValidationPath,
    deepagentsGenerationValidationPath: artifacts.generationValidationPath,
  };
}

export async function writeWorkspaceConfig(
  workspace: OutputWorkspace,
  config: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    workspace.deepagentsConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

export const writeDeepagentsConfig = writeWorkspaceConfig;
