import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OutputWorkspace, TemplateLock, TemplatePack } from "./types.js";

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveTemplateRoot(templateId?: string): Promise<string> {
  const candidates = [process.cwd(), moduleDirectory()];

  for (const candidate of candidates) {
    let current = path.resolve(candidate);

    while (true) {
      const templateRoot = path.join(current, "templates");
      if (await pathExists(templateRoot)) {
        if (!templateId) {
          return templateRoot;
        }

        const manifestPath = path.join(templateRoot, templateId, "template.json");
        if (await pathExists(manifestPath)) {
          return templateRoot;
        }
      }

      const distTemplateRoot = path.join(current, "dist", "templates");
      if (await pathExists(distTemplateRoot)) {
        if (!templateId) {
          return distTemplateRoot;
        }

        const manifestPath = path.join(distTemplateRoot, templateId, "template.json");
        if (await pathExists(manifestPath)) {
          return distTemplateRoot;
        }
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  throw new Error('Could not locate the "templates" directory.');
}

type TemplateManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  projectRenderer: string;
  prompts: {
    system: string;
  };
  referencesDir?: string;
  skillsDir?: string;
  starterDir?: string;
};

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid template manifest field "${fieldName}".`);
  }
}

function parseTemplateManifest(raw: unknown): TemplateManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Template manifest must be an object.");
  }

  const manifest = raw as Record<string, unknown>;
  assertNonEmptyString(manifest.id, "id");
  assertNonEmptyString(manifest.name, "name");
  assertNonEmptyString(manifest.version, "version");
  assertNonEmptyString(manifest.projectRenderer, "projectRenderer");

  if (!manifest.prompts || typeof manifest.prompts !== "object") {
    throw new Error('Template manifest field "prompts" is required.');
  }

  const prompts = manifest.prompts as Record<string, unknown>;
  assertNonEmptyString(prompts.system, "prompts.system");

  const parsed: TemplateManifest = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    projectRenderer: manifest.projectRenderer,
    prompts: {
      system: prompts.system,
    },
  };

  if (typeof manifest.description === "string" && manifest.description.trim() !== "") {
    parsed.description = manifest.description;
  }

  for (const optionalField of ["referencesDir", "skillsDir", "starterDir"] as const) {
    const value = manifest[optionalField];
    if (typeof value === "string" && value.trim() !== "") {
      parsed[optionalField] = value;
    }
  }

  return parsed;
}

async function collectFiles(directory: string, rootDirectory = directory): Promise<Array<{ relativePath: string; absolutePath: string }>> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: Array<{ relativePath: string; absolutePath: string }> = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, rootDirectory));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    files.push({
      relativePath: path.relative(rootDirectory, absolutePath).split(path.sep).join("/"),
      absolutePath,
    });
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function hashDirectory(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await collectFiles(directory);

  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\n");
    hash.update(await fs.readFile(file.absolutePath));
    hash.update("\n");
  }

  return `sha256:${hash.digest("hex")}`;
}

async function ensureFileExists(filePath: string, fieldName: string): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      throw new Error(`${fieldName} must reference a file.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Template file for "${fieldName}" was not found at ${filePath}. ${message}`);
  }
}

export async function loadTemplatePack(templateId = "full-stack"): Promise<TemplatePack> {
  const templateRoot = await resolveTemplateRoot(templateId);
  const directory = path.join(templateRoot, templateId);
  const manifestPath = path.join(directory, "template.json");

  const manifestContents = await fs.readFile(manifestPath, "utf8");
  const manifest = parseTemplateManifest(JSON.parse(manifestContents));
  const systemPromptPath = path.join(directory, manifest.prompts.system);
  await ensureFileExists(systemPromptPath, "prompts.system");

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    directory,
    manifestPath,
    projectRenderer: manifest.projectRenderer,
    systemPromptPath,
    systemPromptRelativePath: manifest.prompts.system,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.referencesDir ? { referencesDirectory: path.join(directory, manifest.referencesDir) } : {}),
    ...(manifest.skillsDir ? { skillsDirectory: path.join(directory, manifest.skillsDir) } : {}),
    ...(manifest.starterDir ? { starterDirectory: path.join(directory, manifest.starterDir) } : {}),
    hash: await hashDirectory(directory),
  };
}

export async function resolveTemplateFilePath(templateId: string, relativePath: string): Promise<string> {
  const templateRoot = await resolveTemplateRoot(templateId);
  return path.join(templateRoot, templateId, relativePath);
}

export async function stageTemplatePack(
  template: TemplatePack,
  workspace: OutputWorkspace,
): Promise<TemplateLock> {
  await fs.copyFile(
    template.systemPromptPath,
    workspace.deepagentsPromptSnapshotPath,
  );

  await fs.copyFile(
    template.manifestPath,
    path.join(workspace.deepagentsTemplateDirectory, path.basename(template.manifestPath)),
  );

  if (template.referencesDirectory && await pathExists(template.referencesDirectory)) {
    await fs.cp(
      template.referencesDirectory,
      path.join(workspace.deepagentsTemplateDirectory, "references"),
      { recursive: true },
    );
  }

  if (template.skillsDirectory && await pathExists(template.skillsDirectory)) {
    await fs.cp(
      template.skillsDirectory,
      path.join(workspace.deepagentsTemplateDirectory, "skills"),
      { recursive: true },
    );
  }

  const lock: TemplateLock = {
    id: template.id,
    name: template.name,
    version: template.version,
    projectRenderer: template.projectRenderer,
    hash: template.hash,
    stagedAt: new Date().toISOString(),
    workspaceTemplateDirectory: path.relative(workspace.outputDirectory, workspace.deepagentsDirectory).split(path.sep).join("/"),
    systemPromptPath: template.systemPromptRelativePath,
    ...(template.description ? { description: template.description } : {}),
  };

  await fs.writeFile(workspace.templateLockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return lock;
}

export async function copyStarterScaffold(
  template: TemplatePack,
  outputDirectory: string,
): Promise<string[]> {
  if (!template.starterDirectory || !await pathExists(template.starterDirectory)) {
    return [];
  }

  const files = await collectFiles(template.starterDirectory);

  for (const file of files) {
    const destinationPath = path.join(outputDirectory, file.relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(file.absolutePath, destinationPath);
  }

  return files.map((file) => file.relativePath);
}
