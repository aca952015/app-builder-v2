import type { PlanSpec } from "./plan-spec.js";
import type { ModelRoleConfigMap } from "./model-config.js";

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

export type ReferenceType = "external_api" | "documentation" | "external_service" | "other";

export type ExternalReferenceDraft = {
  url: string;
  name: string;
  type: ReferenceType;
  required: boolean;
  context?: string;
  sourcePath?: string[];
  localPath?: string;
  retrievedAt?: string;
  contentType?: string;
  retrievalStatus?: "downloaded" | "failed" | "skipped";
  error?: string;
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
  externalReferences: ExternalReferenceDraft[];
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

export type TemplateInteractiveRuntimeValidation = {
  enabled: boolean;
  coverageThreshold: number;
  idleTimeoutMs: number;
  readyTimeoutMs: number;
  devServerStep?: TemplateRuntimeValidationStep;
};

export const TEMPLATE_PHASE_EFFORTS = ["low", "medium", "high", "max"] as const;

export type TemplatePhaseEffort = typeof TEMPLATE_PHASE_EFFORTS[number];

export type TemplatePhaseName = "plan" | "planRepair" | "generate" | "generateRepair";

export type TemplatePhaseConfig = {
  prompt?: string;
  effort?: TemplatePhaseEffort;
};

export type TemplatePhaseMap = Record<TemplatePhaseName, TemplatePhaseConfig>;

export type TemplateRepairRetries = {
  plan: number;
  generate: number;
};

export type GeneratedAppValidator = {
  validate(outputDirectory: string, runtime: TextGeneratorRuntime): Promise<{
    reasons: string[];
    steps: GenerationValidationStep[];
  }>;
};

export type WorkflowPhase =
  | "plan"
  | "plan_repair"
  | "generate"
  | "generate_repair"
  | "validation"
  | "complete";
export type ValidationPhase = "plan" | "generate";

export type RuntimeUsageSummary = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
};

export type RuntimeStatusPhase = TemplatePhaseName | WorkflowPhase;

export type RuntimeStatus = {
  modelName?: string | undefined;
  effort?: TemplatePhaseEffort | undefined;
  usage?: RuntimeUsageSummary | undefined;
  contextWindowUsedTokens?: number | undefined;
  sessionId?: string | undefined;
  phase?: RuntimeStatusPhase | undefined;
};

export type StdoutMode = "dashboard" | "log";

export type SessionValidationResult = {
  sessionId: string;
  phase: ValidationPhase;
  outputDirectory: string;
  valid: boolean;
  reasons: string[];
  steps?: GenerationValidationStep[];
  validationPath: string;
  runtimeValidationLogPath?: string;
  runtimeInteractionValidationPath?: string;
  workflowPhase: WorkflowPhase;
  resumedFromPhase?: WorkflowPhase;
};

export type LocalReference = {
  url: string;
  name: string;
  type: ReferenceType;
  required: boolean;
  retrievalStatus: "downloaded" | "failed" | "skipped";
  localPath?: string;
  retrievedAt?: string;
  contentType?: string;
  error?: string;
};

export type ReferenceManifest = {
  version: 1;
  generatedAt: string;
  entries: LocalReference[];
};

export type ReferenceMarkdownConversionInput = {
  url: string;
  name: string;
  type: LocalReference["type"];
  contentType: string;
  body: string;
};

export type ReferenceMarkdownConversionResult = {
  markdown: string;
  notes: string[];
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
  repairRetries: TemplateRepairRetries;
  phases: TemplatePhaseMap;
  runtimeValidation: TemplateRuntimeValidation;
  interactiveRuntimeValidation: TemplateInteractiveRuntimeValidation;
  hash: string;
};

export type TemplateLock = {
  id: string;
  name: string;
  version: string;
  description?: string;
  projectRenderer: string;
  repairRetries: TemplateRepairRetries;
  phases: TemplatePhaseMap;
  runtimeValidation: TemplateRuntimeValidation;
  interactiveRuntimeValidation: TemplateInteractiveRuntimeValidation;
  hash: string;
  stagedAt: string;
  workspaceTemplateDirectory: string;
};

export type OutputWorkspace = {
  sessionId: string;
  outputDirectory: string;
  deepagentsDirectory: string;
  deepagentsAgentsPath: string;
  deepagentsLogPath: string;
  deepagentsErrorLogPath: string;
  deepagentsMetricsLogPath: string;
  deepagentsRuntimeValidationLogPath: string;
  deepagentsRuntimeInteractionValidationPath: string;
  deepagentsInteractionContractPath: string;
  deepagentsReferenceManifestPath: string;
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
  deepagentsMetricsLogPath: string;
  deepagentsRuntimeValidationLogPath: string;
  deepagentsRuntimeInteractionValidationPath: string;
  deepagentsInteractionContractPath: string;
  deepagentsReferenceManifestPath: string;
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
  localReferences?: LocalReference[];
  planAttempt?: number;
  maxPlanRetries?: number;
  generateAttempt?: number;
  maxGenerateRetries?: number;
  retryReasons?: string[];
  templatePhases: TemplatePhaseMap;
  templateRuntimeValidation: TemplateRuntimeValidation;
  templateInteractiveRuntimeValidation: TemplateInteractiveRuntimeValidation;
  modelRoles: ModelRoleConfigMap;
};

export type TextGenerator = {
  planProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<PlanResult>;
  planRepairProject(runtime: TextGeneratorRuntime): Promise<PlanResult>;
  generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject>;
  generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject>;
  convertReferenceToMarkdown?(
    input: ReferenceMarkdownConversionInput,
    runtime: TextGeneratorRuntime,
  ): Promise<ReferenceMarkdownConversionResult>;
};

export type GenerateAppOptions = {
  specPath: string;
  outputDirectory?: string;
  appNameOverride?: string;
  templateId?: string;
  force?: boolean;
  skipValidation?: boolean;
  stdoutMode?: StdoutMode;
  generator?: TextGenerator;
  validator?: GeneratedAppValidator;
};
