import { promises as fs } from "node:fs";
import path from "node:path";

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseDotEnv(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const value = stripMatchingQuotes(line.slice(separatorIndex + 1).trim());
    parsed[key] = value;
  }

  return parsed;
}

export async function loadProjectEnv(cwd: string = process.cwd()): Promise<void> {
  const envPath = path.join(cwd, ".env");

  let contents: string;
  try {
    contents = await fs.readFile(envPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return;
    }
    throw error;
  }

  const parsed = parseDotEnv(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
