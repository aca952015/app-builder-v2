import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TemplatePhaseConfig,
  TemplatePhaseEffort,
  TemplatePhaseMap,
  OutputWorkspace,
  TemplateInteractiveRuntimeValidation,
  TemplateLock,
  TemplatePack,
  TemplateRepairRetries,
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

const defaultRepairRetries: TemplateRepairRetries = {
  plan: 2,
  generate: 2,
};

const defaultInteractiveRuntimeValidation: Omit<TemplateInteractiveRuntimeValidation, "devServerStep"> = {
  enabled: false,
  coverageThreshold: 0.8,
  idleTimeoutMs: 10_000,
  readyTimeoutMs: 90_000,
};

export const DEFAULT_TEMPLATE_ID = "full-stack";

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
  phases: TemplatePhaseMap;
  referencesDir?: string;
  skillsDir?: string;
  starterDir?: string;
  repairRetries?: TemplateRepairRetries;
  runtimeValidation?: TemplateRuntimeValidation;
  interactiveRuntimeValidation?: TemplateInteractiveRuntimeValidation;
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

function parsePositiveIntegerField(
  value: unknown,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`Template manifest field "${fieldName}" must be a positive integer.`);
  }

  return Number(value);
}

function parseCoverageThreshold(value: unknown): number {
  if (value === undefined) {
    return defaultInteractiveRuntimeValidation.coverageThreshold;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Template manifest field "interactiveRuntimeValidation.coverageThreshold" must be a number between 0 and 1.');
  }

  return value;
}

function parseInteractiveRuntimeValidation(
  raw: unknown,
  runtimeValidation: TemplateRuntimeValidation,
): TemplateInteractiveRuntimeValidation {
  if (raw === undefined) {
    return { ...defaultInteractiveRuntimeValidation };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('Template manifest field "interactiveRuntimeValidation" must be an object.');
  }

  const validation = raw as Record<string, unknown>;
  const enabled = validation.enabled === true;
  const coverageThreshold = parseCoverageThreshold(validation.coverageThreshold);
  const idleTimeoutMs = parsePositiveIntegerField(
    validation.idleTimeoutMs,
    "interactiveRuntimeValidation.idleTimeoutMs",
    defaultInteractiveRuntimeValidation.idleTimeoutMs,
  );
  const readyTimeoutMs = parsePositiveIntegerField(
    validation.readyTimeoutMs,
    "interactiveRuntimeValidation.readyTimeoutMs",
    defaultInteractiveRuntimeValidation.readyTimeoutMs,
  );

  if (!enabled) {
    return {
      enabled,
      coverageThreshold,
      idleTimeoutMs,
      readyTimeoutMs,
    };
  }

  const devServerStep = runtimeValidation.steps.find((step) => step.kind === "dev-server");
  if (!devServerStep) {
    throw new Error(
      'Template manifest field "interactiveRuntimeValidation.enabled" requires runtimeValidation.steps to include a step with kind "dev-server".',
    );
  }

  return {
    enabled,
    coverageThreshold,
    idleTimeoutMs,
    readyTimeoutMs,
    devServerStep: JSON.parse(JSON.stringify(devServerStep)) as TemplateRuntimeValidationStep,
  };
}

function parseRepairRetries(raw: unknown): TemplateRepairRetries {
  if (raw === undefined) {
    return { ...defaultRepairRetries };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('Template manifest field "repairRetries" must be an object.');
  }

  const candidate = raw as Record<string, unknown>;
  if (!Number.isInteger(candidate.plan) || Number(candidate.plan) < 0) {
    throw new Error('Template manifest field "repairRetries.plan" must be a non-negative integer.');
  }
  if (!Number.isInteger(candidate.generate) || Number(candidate.generate) < 0) {
    throw new Error('Template manifest field "repairRetries.generate" must be a non-negative integer.');
  }

  return {
    plan: Number(candidate.plan),
    generate: Number(candidate.generate),
  };
}

function parseTemplatePhaseConfig(raw: unknown, fieldName: string): TemplatePhaseConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Template manifest field "${fieldName}" must be an object.`);
  }

  const candidate = raw as Record<string, unknown>;
  assertNonEmptyString(candidate.prompt, `${fieldName}.prompt`);
  if (
    candidate.effort !== undefined &&
    candidate.effort !== "low" &&
    candidate.effort !== "medium" &&
    candidate.effort !== "high"
  ) {
    throw new Error(`Template manifest field "${fieldName}.effort" must be "low", "medium", or "high".`);
  }

  return {
    prompt: candidate.prompt,
    ...(candidate.effort ? { effort: candidate.effort as TemplatePhaseEffort } : {}),
  };
}

function parseTemplatePhases(raw: unknown): TemplatePhaseMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error('Template manifest field "phases" must be an object.');
  }

  const phases = raw as Record<string, unknown>;
  return {
    plan: parseTemplatePhaseConfig(phases.plan, "phases.plan"),
    planRepair: parseTemplatePhaseConfig(phases.planRepair, "phases.planRepair"),
    generate: parseTemplatePhaseConfig(phases.generate, "phases.generate"),
    generateRepair: parseTemplatePhaseConfig(phases.generateRepair, "phases.generateRepair"),
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

  const runtimeValidation = parseRuntimeValidation(manifest.runtimeValidation);
  const parsed: TemplateManifest = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    projectRenderer: manifest.projectRenderer,
    phases: parseTemplatePhases(manifest.phases),
    repairRetries: parseRepairRetries(manifest.repairRetries),
    runtimeValidation,
    interactiveRuntimeValidation: parseInteractiveRuntimeValidation(
      manifest.interactiveRuntimeValidation,
      runtimeValidation,
    ),
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

export async function loadTemplatePack(templateId = DEFAULT_TEMPLATE_ID): Promise<TemplatePack> {
  const templateRoot = await resolveTemplateRoot(templateId);
  const directory = path.join(templateRoot, templateId);
  const manifestPath = path.join(directory, "template.json");

  const manifestContents = await fs.readFile(manifestPath, "utf8");
  const manifest = parseTemplateManifest(JSON.parse(manifestContents));
  const planPromptPath = path.join(directory, manifest.phases.plan.prompt!);
  const planRepairPromptPath = path.join(directory, manifest.phases.planRepair.prompt!);
  const generatePromptPath = path.join(directory, manifest.phases.generate.prompt!);
  const generateRepairPromptPath = path.join(directory, manifest.phases.generateRepair.prompt!);
  await ensureFileExists(planPromptPath, "phases.plan.prompt");
  await ensureFileExists(planRepairPromptPath, "phases.planRepair.prompt");
  await ensureFileExists(generatePromptPath, "phases.generate.prompt");
  await ensureFileExists(generateRepairPromptPath, "phases.generateRepair.prompt");

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    directory,
    manifestPath,
    projectRenderer: manifest.projectRenderer,
    planPromptPath,
    planPromptRelativePath: manifest.phases.plan.prompt!,
    planRepairPromptPath,
    planRepairPromptRelativePath: manifest.phases.planRepair.prompt!,
    generatePromptPath,
    generatePromptRelativePath: manifest.phases.generate.prompt!,
    generateRepairPromptPath,
    generateRepairPromptRelativePath: manifest.phases.generateRepair.prompt!,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.referencesDir ? { referencesDirectory: path.join(directory, manifest.referencesDir) } : {}),
    ...(manifest.skillsDir ? { skillsDirectory: path.join(directory, manifest.skillsDir) } : {}),
    ...(manifest.starterDir ? { starterDirectory: path.join(directory, manifest.starterDir) } : {}),
    repairRetries: manifest.repairRetries ?? { ...defaultRepairRetries },
    phases: manifest.phases,
    runtimeValidation: manifest.runtimeValidation ?? defaultRuntimeValidation,
    interactiveRuntimeValidation: manifest.interactiveRuntimeValidation ?? { ...defaultInteractiveRuntimeValidation },
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
    repairRetries: template.repairRetries,
    phases: template.phases,
    runtimeValidation: template.runtimeValidation,
    interactiveRuntimeValidation: template.interactiveRuntimeValidation,
    hash: template.hash,
    stagedAt: new Date().toISOString(),
    workspaceTemplateDirectory: path.relative(workspace.outputDirectory, workspace.deepagentsDirectory).split(path.sep).join("/"),
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
