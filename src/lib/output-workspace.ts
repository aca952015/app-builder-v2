import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ensureEmptyOutputDirectory } from "./project-writer.js";
import { buildSessionPolicyDocument } from "./session-policy.js";
import { OutputWorkspace } from "./types.js";

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

  const deepagentsDirectory = path.join(outputDirectory, ".deepagents");
  await fs.mkdir(deepagentsDirectory, { recursive: true });
  const deepagentsAgentsPath = path.join(deepagentsDirectory, "AGENTS.md");
  await fs.writeFile(deepagentsAgentsPath, `${buildSessionPolicyDocument()}\n`, "utf8");

  return {
    sessionId,
    outputDirectory,
    deepagentsDirectory,
    deepagentsAgentsPath,
    deepagentsLogPath: path.join(deepagentsDirectory, "trace.log"),
    deepagentsErrorLogPath: path.join(deepagentsDirectory, "error.log"),
    deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
    deepagentsConfigPath: path.join(deepagentsDirectory, "config.json"),
    deepagentsPlanPromptSnapshotPath: path.join(deepagentsDirectory, "plan-system-prompt.md"),
    deepagentsPlanRepairPromptSnapshotPath: path.join(deepagentsDirectory, "plan-repair-system-prompt.md"),
    deepagentsGeneratePromptSnapshotPath: path.join(deepagentsDirectory, "generate-system-prompt.md"),
    deepagentsGenerateRepairPromptSnapshotPath: path.join(deepagentsDirectory, "generate-repair-system-prompt.md"),
    deepagentsTemplateDirectory: deepagentsDirectory,
    templateLockPath: path.join(outputDirectory, "template-lock.json"),
    sourcePrdSnapshotPath: path.join(deepagentsDirectory, "source-prd.md"),
    deepagentsAnalysisPath: path.join(deepagentsDirectory, "prd-analysis.md"),
    deepagentsDetailedSpecPath: path.join(deepagentsDirectory, "generated-spec.md"),
    deepagentsPlanSpecPath: path.join(deepagentsDirectory, "plan-spec.json"),
    deepagentsPlanValidationPath: path.join(deepagentsDirectory, "plan-validation.json"),
    deepagentsGenerationValidationPath: path.join(deepagentsDirectory, "generation-validation.json"),
  };
}

export async function writeDeepagentsConfig(
  workspace: OutputWorkspace,
  config: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    workspace.deepagentsConfigPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}
