import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensureEmptyOutputDirectory(outputDirectory: string, force = false): Promise<void> {
  try {
    const stats = await fs.stat(outputDirectory);
    if (!stats.isDirectory()) {
      throw new Error(`${outputDirectory} exists and is not a directory.`);
    }

    const entries = await fs.readdir(outputDirectory);
    if (entries.length > 0 && !force) {
      throw new Error(`${outputDirectory} is not empty. Use --force to overwrite.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT")) {
      throw error;
    }
  }

  await fs.mkdir(outputDirectory, { recursive: true });
}

export async function writeProjectFiles(outputDirectory: string, files: Record<string, string>): Promise<string[]> {
  const writtenFiles: string[] = [];

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(outputDirectory, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, contents, "utf8");
    writtenFiles.push(relativePath);
  }

  return writtenFiles.sort();
}
