import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { ensureEmptyOutputDirectory } from "./project-writer.js";
import { OutputWorkspace } from "./types.js";

function createSessionId(): string {
  return randomUUID();
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

  const deepagentsDirectory = path.join(outputDirectory, ".deepagents");
  await fs.mkdir(deepagentsDirectory, { recursive: true });

  return {
    sessionId,
    outputDirectory,
    deepagentsDirectory,
    deepagentsLogPath: path.join(deepagentsDirectory, "trace.log"),
    deepagentsErrorLogPath: path.join(deepagentsDirectory, "error.log"),
    deepagentsConfigPath: path.join(deepagentsDirectory, "config.json"),
    deepagentsPromptSnapshotPath: path.join(deepagentsDirectory, "system-prompt.md"),
    deepagentsTemplateDirectory: deepagentsDirectory,
    templateLockPath: path.join(outputDirectory, "template-lock.json"),
    sourcePrdSnapshotPath: path.join(deepagentsDirectory, "source-prd.md"),
    normalizedSpecSnapshotPath: path.join(deepagentsDirectory, "normalized-spec.json"),
    deepagentsAnalysisPath: path.join(deepagentsDirectory, "prd-analysis.md"),
    deepagentsDetailedSpecPath: path.join(deepagentsDirectory, "generated-spec.md"),
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
