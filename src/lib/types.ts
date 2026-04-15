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
  systemPromptPath: string;
  systemPromptRelativePath: string;
  referencesDirectory?: string;
  skillsDirectory?: string;
  starterDirectory?: string;
  hash: string;
};

export type TemplateLock = {
  id: string;
  name: string;
  version: string;
  description?: string;
  projectRenderer: string;
  hash: string;
  stagedAt: string;
  workspaceTemplateDirectory: string;
  systemPromptPath: string;
};

export type OutputWorkspace = {
  sessionId: string;
  outputDirectory: string;
  deepagentsDirectory: string;
  deepagentsLogPath: string;
  deepagentsErrorLogPath: string;
  deepagentsConfigPath: string;
  deepagentsPromptSnapshotPath: string;
  deepagentsTemplateDirectory: string;
  templateLockPath: string;
  sourcePrdSnapshotPath: string;
  deepagentsAnalysisPath: string;
  deepagentsDetailedSpecPath: string;
};

export type TextGeneratorRuntime = {
  sessionId: string;
  outputDirectory: string;
  deepagentsDirectory: string;
  deepagentsLogPath: string;
  deepagentsErrorLogPath: string;
  deepagentsConfigPath: string;
  deepagentsPromptSnapshotPath: string;
  templateId: string;
  templateName: string;
  templateVersion: string;
  templateDirectory: string;
  templateSystemPromptPath: string;
  sourcePrdSnapshotPath: string;
  deepagentsAnalysisPath: string;
  deepagentsDetailedSpecPath: string;
  analysisAttempt?: number;
  maxAnalysisRetries?: number;
  retryReasons?: string[];
  retryStage?: "计划阶段" | "生成阶段";
};

export type TextGenerator = {
  generateProject(spec: NormalizedSpec, runtime: TextGeneratorRuntime): Promise<GeneratedProject>;
};

export type GenerateAppOptions = {
  specPath: string;
  outputDirectory?: string;
  appNameOverride?: string;
  templateId?: string;
  force?: boolean;
  generator?: TextGenerator;
};
