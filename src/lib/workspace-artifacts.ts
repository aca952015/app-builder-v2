import path from "node:path";

export const WORKSPACE_DIR_NAME = ".workspace";
export const LEGACY_WORKSPACE_DIR_NAME = ".deepagents";
export const WORKSPACE_TODO_FILE_NAME = "todo.md";

export type WorkspaceArtifactPaths = {
  workspaceDirectory: string;
  legacyWorkspaceDirectory: string;
  agentsPath: string;
  logPath: string;
  errorLogPath: string;
  metricsLogPath: string;
  runtimeValidationLogPath: string;
  runtimeInteractionValidationPath: string;
  todoPath: string;
  interactionContractPath: string;
  referenceManifestPath: string;
  referencesDirectory: string;
  configPath: string;
  planPromptSnapshotPath: string;
  planRepairPromptSnapshotPath: string;
  generatePromptSnapshotPath: string;
  generateRepairPromptSnapshotPath: string;
  templateDirectory: string;
  templateLockPath: string;
  sourcePrdSnapshotPath: string;
  analysisPath: string;
  detailedSpecPath: string;
  planSpecPath: string;
  planValidationPath: string;
  generationValidationPath: string;
};

export function workspaceRelativePath(relativePath: string): string {
  return `${WORKSPACE_DIR_NAME}/${relativePath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

export function createWorkspaceArtifactPaths(outputDirectory: string): WorkspaceArtifactPaths {
  const workspaceDirectory = path.join(outputDirectory, WORKSPACE_DIR_NAME);
  const referencesDirectory = path.join(workspaceDirectory, "references");

  return {
    workspaceDirectory,
    legacyWorkspaceDirectory: path.join(outputDirectory, LEGACY_WORKSPACE_DIR_NAME),
    agentsPath: path.join(workspaceDirectory, "AGENTS.md"),
    logPath: path.join(workspaceDirectory, "trace.log"),
    errorLogPath: path.join(workspaceDirectory, "error.log"),
    metricsLogPath: path.join(workspaceDirectory, "metrics.jsonl"),
    runtimeValidationLogPath: path.join(workspaceDirectory, "runtime-validation.log"),
    runtimeInteractionValidationPath: path.join(workspaceDirectory, "runtime-interaction-validation.json"),
    todoPath: path.join(workspaceDirectory, WORKSPACE_TODO_FILE_NAME),
    interactionContractPath: path.join(workspaceDirectory, "interaction-contract.json"),
    referenceManifestPath: path.join(referencesDirectory, "reference-manifest.json"),
    referencesDirectory,
    configPath: path.join(workspaceDirectory, "config.json"),
    planPromptSnapshotPath: path.join(workspaceDirectory, "plan-system-prompt.md"),
    planRepairPromptSnapshotPath: path.join(workspaceDirectory, "plan-repair-system-prompt.md"),
    generatePromptSnapshotPath: path.join(workspaceDirectory, "generate-system-prompt.md"),
    generateRepairPromptSnapshotPath: path.join(workspaceDirectory, "generate-repair-system-prompt.md"),
    templateDirectory: workspaceDirectory,
    templateLockPath: path.join(outputDirectory, "template-lock.json"),
    sourcePrdSnapshotPath: path.join(workspaceDirectory, "source-prd.md"),
    analysisPath: path.join(workspaceDirectory, "prd-analysis.md"),
    detailedSpecPath: path.join(workspaceDirectory, "generated-spec.md"),
    planSpecPath: path.join(workspaceDirectory, "plan-spec.json"),
    planValidationPath: path.join(workspaceDirectory, "plan-validation.json"),
    generationValidationPath: path.join(workspaceDirectory, "generation-validation.json"),
  };
}

export function formatLegacyWorkspaceError(sessionId: string, legacyWorkspaceDirectory: string): string {
  return [
    `Session "${sessionId}" uses the legacy ${LEGACY_WORKSPACE_DIR_NAME} workspace at ${legacyWorkspaceDirectory}.`,
    `This version requires ${WORKSPACE_DIR_NAME}; automatic legacy workspace migration is not supported.`,
  ].join(" ");
}
