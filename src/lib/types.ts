import type { PlanSpec } from "./plan-spec.js";

export type ParsedSection = {
  heading: string;
  depth: number;
  path: string[];
  content: string;
};

export type EntityDraft = {
  name: string;
  fields: string[];
  description?: string;
};

export type ParsedPrd = {
  title: string;
  summary: string;
  sections: ParsedSection[];
  entities: EntityDraft[];
  roles: string[];
  screens: string[];
  flows: string[];
  businessRules: string[];
  openQuestions: string[];
};

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "email";

export type EntityField = {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  description?: string;
};

export type AppEntity = {
  name: string;
  pluralName: string;
  routeSegment: string;
  description: string;
  fields: EntityField[];
};

export type AppScreen = {
  name: string;
  route: string;
  purpose: string;
};

export type NormalizedSpec = {
  appName: string;
  slug: string;
  summary: string;
  roles: string[];
  entities: AppEntity[];
  screens: AppScreen[];
  flows: string[];
  businessRules: string[];
  warnings: string[];
  defaultsApplied: string[];
  sourceMarkdown: string;
};

export type GeneratedProject = {
  summary: string;
  filesWritten: string[];
  implementedResources: string[];
  implementedPages: string[];
  implementedApis: string[];
  notes: string[];
};

export type GenerationValidationStep = {
  name: string;
  ok: boolean;
  detail: string;
};

export type TemplateRuntimeValidationStep = {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  kind?: "command" | "dev-server";
};

export type TemplateRuntimeValidation = {
  copyEnvExample?: boolean;
  steps: TemplateRuntimeValidationStep[];
};

export type GeneratedAppValidator = {
  validate(outputDirectory: string, runtime: TextGeneratorRuntime): Promise<{
    reasons: string[];
    steps: GenerationValidationStep[];
  }>;
};

export type WorkflowPhase = "plan" | "plan_repair" | "generate" | "generate_repair" | "complete";
export type ValidationPhase = "plan" | "generate";

export type SessionValidationResult = {
  sessionId: string;
  phase: ValidationPhase;
  outputDirectory: string;
  valid: boolean;
  reasons: string[];
  validationPath: string;
  runtimeValidationLogPath?: string;
  workflowPhase: WorkflowPhase;
  resumedFromPhase?: Extract<WorkflowPhase, "plan_repair" | "generate_repair">;
};

export type PlanResult = {
  summary: string;
  artifactsWritten: string[];
  planSpecVersion: number;
  notes: string[];
};

export type GenerationReport = {
  appName: string;
  templateId: string;
  outputDirectory: string;
  entities: string[];
  screens: string[];
  warnings: string[];
  defaultsApplied: string[];
};

export type GenerationResult = {
  spec: NormalizedSpec;
  sessionId: string;
  templateId: string;
  outputDirectory: string;
  files: string[];
  report: GenerationReport;
};

export type TemplatePack = {
  id: string;
  name: string;
  version: string;
  description?: string;
  directory: string;
  manifestPath: string;
  projectRenderer: string;
  planPromptPath: string;
  planPromptRelativePath: string;
  planRepairPromptPath: string;
  planRepairPromptRelativePath: string;
  generatePromptPath: string;
  generatePromptRelativePath: string;
  generateRepairPromptPath: string;
  generateRepairPromptRelativePath: string;
  referencesDirectory?: string;
  skillsDirectory?: string;
  starterDirectory?: string;
  runtimeValidation: TemplateRuntimeValidation;
  hash: string;
};

export type TemplateLock = {
  id: string;
  name: string;
  version: string;
  description?: string;
  projectRenderer: string;
  runtimeValidation: TemplateRuntimeValidation;
  hash: string;
  stagedAt: string;
  workspaceTemplateDirectory: string;
  prompts: {
    plan: string;
    planRepair: string;
    generate: string;
    generateRepair: string;
  };
};

export type OutputWorkspace = {
  sessionId: string;
  outputDirectory: string;
  deepagentsDirectory: string;
  deepagentsAgentsPath: string;
  deepagentsLogPath: string;
  deepagentsErrorLogPath: string;
  deepagentsRuntimeValidationLogPath: string;
  deepagentsConfigPath: string;
  deepagentsPlanPromptSnapshotPath: string;
  deepagentsPlanRepairPromptSnapshotPath: string;
  deepagentsGeneratePromptSnapshotPath: string;
  deepagentsGenerateRepairPromptSnapshotPath: string;
  deepagentsTemplateDirectory: string;
  templateLockPath: string;
  sourcePrdSnapshotPath: string;
  deepagentsAnalysisPath: string;
  deepagentsDetailedSpecPath: string;
  deepagentsPlanSpecPath: string;
  deepagentsPlanValidationPath: string;
  deepagentsGenerationValidationPath: string;
};

export type TextGeneratorRuntime = {
  sessionId: string;
  outputDirectory: string;
  deepagentsDirectory: string;
  deepagentsAgentsPath: string;
  deepagentsLogPath: string;
  deepagentsErrorLogPath: string;
  deepagentsRuntimeValidationLogPath: string;
  deepagentsConfigPath: string;
  deepagentsPlanPromptSnapshotPath: string;
  deepagentsPlanRepairPromptSnapshotPath: string;
  deepagentsGeneratePromptSnapshotPath: string;
  deepagentsGenerateRepairPromptSnapshotPath: string;
  templateId: string;
  templateName: string;
  templateVersion: string;
  templateDirectory: string;
  templatePlanPromptPath: string;
  templatePlanRepairPromptPath: string;
  templateGeneratePromptPath: string;
  templateGenerateRepairPromptPath: string;
  sourcePrdSnapshotPath: string;
  deepagentsAnalysisPath: string;
  deepagentsDetailedSpecPath: string;
  deepagentsPlanSpecPath: string;
  deepagentsPlanValidationPath: string;
  deepagentsGenerationValidationPath: string;
  planAttempt?: number;
  maxPlanRetries?: number;
  generateAttempt?: number;
  maxGenerateRetries?: number;
  retryReasons?: string[];
  templateRuntimeValidation: TemplateRuntimeValidation;
};

export type TextGenerator = {
  planProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult>;
  planRepairProject(runtime: TextGeneratorRuntime): Promise<PlanResult>;
  generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject>;
  generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject>;
};

export type GenerateAppOptions = {
  specPath: string;
  outputDirectory?: string;
  appNameOverride?: string;
  templateId?: string;
  force?: boolean;
  generator?: TextGenerator;
  validator?: GeneratedAppValidator;
};
