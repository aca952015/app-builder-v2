import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OutputWorkspace,
  TemplateLock,
  TemplatePack,
  TemplateRuntimeValidation,
  TemplateRuntimeValidationStep,
} from "./types.js";

const defaultRuntimeValidation: TemplateRuntimeValidation = {
  copyEnvExample: true,
  steps: [
    { name: "pnpm install", command: "pnpm", args: ["install"] },
    { name: "pnpm db:init", command: "pnpm", args: ["db:init"] },
    { name: "pnpm dev", command: "pnpm", args: ["dev"], kind: "dev-server" },
  ],
};

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
    plan: string;
    planRepair: string;
    generate: string;
    generateRepair: string;
  };
  referencesDir?: string;
  skillsDir?: string;
  starterDir?: string;
  runtimeValidation?: TemplateRuntimeValidation;
};

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid template manifest field "${fieldName}".`);
  }
}

function parseRuntimeValidationStep(raw: unknown, index: number): TemplateRuntimeValidationStep {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Template runtimeValidation.steps[${index}] must be an object.`);
  }

  const step = raw as Record<string, unknown>;
  assertNonEmptyString(step.name, `runtimeValidation.steps[${index}].name`);
  assertNonEmptyString(step.command, `runtimeValidation.steps[${index}].command`);

  if (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Template runtimeValidation.steps[${index}].args must be an array of strings.`);
  }

  let env: Record<string, string> | undefined;
  if (step.env !== undefined) {
    if (!step.env || typeof step.env !== "object" || Array.isArray(step.env)) {
      throw new Error(`Template runtimeValidation.steps[${index}].env must be an object.`);
    }

    env = {};
    for (const [key, value] of Object.entries(step.env as Record<string, unknown>)) {
      if (typeof value !== "string") {
        throw new Error(`Template runtimeValidation.steps[${index}].env.${key} must be a string.`);
      }
      env[key] = value;
    }
  }

  if (step.kind !== undefined && step.kind !== "command" && step.kind !== "dev-server") {
    throw new Error(
      `Template runtimeValidation.steps[${index}].kind must be "command" or "dev-server".`,
    );
  }

  return {
    name: step.name,
    command: step.command,
    args: step.args,
    ...(env ? { env } : {}),
    ...(step.kind ? { kind: step.kind } : {}),
  };
}

function parseRuntimeValidation(raw: unknown): TemplateRuntimeValidation {
  if (raw === undefined) {
    return JSON.parse(JSON.stringify(defaultRuntimeValidation)) as TemplateRuntimeValidation;
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('Template manifest field "runtimeValidation" must be an object.');
  }

  const validation = raw as Record<string, unknown>;
  if (!Array.isArray(validation.steps) || validation.steps.length === 0) {
    throw new Error('Template manifest field "runtimeValidation.steps" must be a non-empty array.');
  }

  return {
    ...(typeof validation.copyEnvExample === "boolean" ? { copyEnvExample: validation.copyEnvExample } : {}),
    steps: validation.steps.map((step, index) => parseRuntimeValidationStep(step, index)),
  };
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
  assertNonEmptyString(prompts.plan, "prompts.plan");
  assertNonEmptyString(prompts.planRepair, "prompts.planRepair");
  assertNonEmptyString(prompts.generate, "prompts.generate");
  assertNonEmptyString(prompts.generateRepair, "prompts.generateRepair");

  const parsed: TemplateManifest = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    projectRenderer: manifest.projectRenderer,
    prompts: {
      plan: prompts.plan,
      planRepair: prompts.planRepair,
      generate: prompts.generate,
      generateRepair: prompts.generateRepair,
    },
    runtimeValidation: parseRuntimeValidation(manifest.runtimeValidation),
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
  const planPromptPath = path.join(directory, manifest.prompts.plan);
  const planRepairPromptPath = path.join(directory, manifest.prompts.planRepair);
  const generatePromptPath = path.join(directory, manifest.prompts.generate);
  const generateRepairPromptPath = path.join(directory, manifest.prompts.generateRepair);
  await ensureFileExists(planPromptPath, "prompts.plan");
  await ensureFileExists(planRepairPromptPath, "prompts.planRepair");
  await ensureFileExists(generatePromptPath, "prompts.generate");
  await ensureFileExists(generateRepairPromptPath, "prompts.generateRepair");

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    directory,
    manifestPath,
    projectRenderer: manifest.projectRenderer,
    planPromptPath,
    planPromptRelativePath: manifest.prompts.plan,
    planRepairPromptPath,
    planRepairPromptRelativePath: manifest.prompts.planRepair,
    generatePromptPath,
    generatePromptRelativePath: manifest.prompts.generate,
    generateRepairPromptPath,
    generateRepairPromptRelativePath: manifest.prompts.generateRepair,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.referencesDir ? { referencesDirectory: path.join(directory, manifest.referencesDir) } : {}),
    ...(manifest.skillsDir ? { skillsDirectory: path.join(directory, manifest.skillsDir) } : {}),
    ...(manifest.starterDir ? { starterDirectory: path.join(directory, manifest.starterDir) } : {}),
    runtimeValidation: manifest.runtimeValidation ?? defaultRuntimeValidation,
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
    template.planPromptPath,
    workspace.deepagentsPlanPromptSnapshotPath,
  );

  await fs.copyFile(
    template.planRepairPromptPath,
    workspace.deepagentsPlanRepairPromptSnapshotPath,
  );

  await fs.copyFile(
    template.generatePromptPath,
    workspace.deepagentsGeneratePromptSnapshotPath,
  );

  await fs.copyFile(
    template.generateRepairPromptPath,
    workspace.deepagentsGenerateRepairPromptSnapshotPath,
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
    runtimeValidation: template.runtimeValidation,
    hash: template.hash,
    stagedAt: new Date().toISOString(),
    workspaceTemplateDirectory: path.relative(workspace.outputDirectory, workspace.deepagentsDirectory).split(path.sep).join("/"),
    prompts: {
      plan: template.planPromptRelativePath,
      planRepair: template.planRepairPromptRelativePath,
      generate: template.generatePromptRelativePath,
      generateRepair: template.generateRepairPromptRelativePath,
    },
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
