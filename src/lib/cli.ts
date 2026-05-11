import path from "node:path";
import { parseArgs } from "node:util";

import { generateApplication, resumeSession, validateSessionPhase } from "./generator.js";
import { resolveModelRoleConfigs } from "./model-config.js";
import { DEFAULT_TEMPLATE_ID } from "./template-pack.js";
import { resolveWorkflowStdoutMode } from "./terminal-ui.js";
import type {
  GenerateAppOptions,
  GeneratedAppValidator,
  SessionValidationResult,
  StdoutMode,
  TextGenerator,
  ValidationPhase,
} from "./types.js";

function formatValidationStepLine(step: { name: string; ok: boolean; detail: string }): string {
  return `- ${step.ok ? "OK" : "FAIL"} ${step.name}: ${step.detail}`;
}

type CliExecutionParameterValue = string | boolean;

function resolveCliModelName(): string {
  return resolveModelRoleConfigs(process.env, { requireApiKeys: false }).plan.modelName;
}

function logCliExecutionParameters(
  stdoutMode: StdoutMode,
  stdout: Pick<typeof console, "log">,
  parameters: Record<string, CliExecutionParameterValue>,
): void {
  if (stdoutMode !== "log") {
    return;
  }

  stdout.log("CLI execution parameters:");
  for (const [name, value] of Object.entries(parameters)) {
    stdout.log(`- ${name}: ${String(value)}`);
  }
}

function printSessionValidationResult(
  result: SessionValidationResult,
  stdout: Pick<typeof console, "log">,
): void {
  stdout.log(`Session: ${result.sessionId}`);
  stdout.log(`Phase: ${result.phase}`);
  stdout.log(`Output: ${result.outputDirectory}`);
  stdout.log(`Validation artifact: ${result.validationPath}`);
  if (result.runtimeValidationLogPath) {
    stdout.log(`Runtime log: ${result.runtimeValidationLogPath}`);
  }
  if (result.runtimeInteractionValidationPath) {
    stdout.log(`Runtime interaction: ${result.runtimeInteractionValidationPath}`);
  }
  stdout.log(`Workflow: ${result.workflowPhase}`);
  if (result.resumedFromPhase) {
    stdout.log(`Resumed from: ${result.resumedFromPhase}`);
  }
  if ((result.phase === "generate" || result.phase === "runtimeValidation") && result.steps && result.steps.length > 0) {
    stdout.log("Validation steps:");
    for (const step of result.steps) {
      stdout.log(formatValidationStepLine(step));
    }
  }
}

type CliDeps = {
  generator?: TextGenerator;
  validator?: GeneratedAppValidator;
  stdout?: Pick<typeof console, "log">;
  stderr?: Pick<typeof console, "error">;
  cwd?: string;
};

type CliValidationPhase = ValidationPhase | "auto";

function hasRuntimeValidationFlag(values: Record<string, unknown>): boolean {
  return values.runtimeValidation === true || values["runtime-validation"] === true;
}

function normalizeValidationPhase(value: string | undefined): CliValidationPhase {
  if (value === undefined || value === "auto") {
    return "auto";
  }

  if (value === "plan" || value === "generate" || value === "runtimeValidation") {
    return value;
  }

  if (value === "runtime-validation" || value === "runtime_validation" || value === "validation") {
    return "runtimeValidation";
  }

  throw new Error('The --phase option must be one of "plan", "generate", "runtimeValidation", or "auto".');
}

function resolveValidationPhaseOption(
  phaseValue: string | undefined,
  runtimeValidationFlag: boolean,
): CliValidationPhase {
  const phase = normalizeValidationPhase(phaseValue);
  if (!runtimeValidationFlag) {
    return phase;
  }

  if (phase !== "auto" && phase !== "runtimeValidation") {
    throw new Error('The runtimeValidation flag cannot be combined with --phase values other than "runtimeValidation" or "auto".');
  }

  return "runtimeValidation";
}

function helpText(): string {
  return `Usage:
  app-builder generate <spec.md> [--app-name <name>] [--template <id>] [--design <design.md>] [--force] [--skip-validation] [--stdout <log|dashboard>]
  app-builder generate --resume <session-id> [--skip-validation] [--runtimeValidation] [--stdout <log|dashboard>]
  app-builder -g <spec.md> [--app-name <name>] [--template <id>] [--design <design.md>] [--force] [--skip-validation] [--stdout <log|dashboard>]
  app-builder -g --resume <session-id> [--skip-validation] [--runtimeValidation] [--stdout <log|dashboard>]
  app-builder validate <session-id> [--phase <plan|generate|runtimeValidation|auto>] [--runtimeValidation] [--stdout <log|dashboard>]
  app-builder -v <session-id> [--phase <plan|generate|runtimeValidation|auto>] [--runtimeValidation] [--stdout <log|dashboard>]

Environment:
  APP_BUILDER_API_KEY Required unless role-specific API keys or a custom generator are used
  APP_BUILDER_BASE_URL Optional API base URL fallback for all model roles
  APP_BUILDER_MODEL Optional model fallback for all roles
  APP_BUILDER_PLAN_MODEL / APP_BUILDER_GENERATE_MODEL / APP_BUILDER_REPAIR_MODEL Optional role model overrides
  APP_BUILDER_PLAN_BASE_URL / APP_BUILDER_GENERATE_BASE_URL / APP_BUILDER_REPAIR_BASE_URL Optional role base URLs
  APP_BUILDER_PLAN_API_KEY / APP_BUILDER_GENERATE_API_KEY / APP_BUILDER_REPAIR_API_KEY Optional role API keys
  APP_BUILDER_STREAM_MODES Optional comma-separated deepagents stream modes
  APP_BUILDER_STDOUT  Optional TTY stdout renderer override: dashboard or log
`;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? console;
  const stderr = deps.stderr ?? console;
  const cwd = deps.cwd ?? process.cwd();

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    stdout.log(helpText());
    return;
  }

  const commandToken = argv[0];
  const command =
    commandToken === "-g" ? "generate"
      : commandToken === "-v" ? "validate"
      : commandToken;

  if (command !== "generate" && command !== "validate") {
    throw new Error(`Unknown command "${command}".\n\n${helpText()}`);
  }

  if (command === "validate") {
    const parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        phase: { type: "string" },
        runtimeValidation: { type: "boolean" },
        "runtime-validation": { type: "boolean" },
        stdout: { type: "string" },
      },
    });

    const sessionId = parsed.positionals[0];
    if (!sessionId) {
      throw new Error("A session id is required.");
    }

    const stdoutModeValue = parsed.values.stdout;
    const stdoutMode = resolveWorkflowStdoutMode(stdoutModeValue);
    const phase = resolveValidationPhaseOption(parsed.values.phase, hasRuntimeValidationFlag(parsed.values));

    logCliExecutionParameters(stdoutMode, stdout, {
      command: "validate",
      sessionId,
      phase,
      runtimeValidation: phase === "runtimeValidation",
      model: resolveCliModelName(),
      stdout: stdoutMode,
      cwd,
    });

    const result = await validateSessionPhase({
      sessionId,
      ...(phase !== "auto"
        ? { phase }
        : {}),
      stdoutMode,
      cwd,
      ...(deps.generator ? { generator: deps.generator } : {}),
      ...(deps.validator ? { validator: deps.validator } : {}),
    });

    printSessionValidationResult(result, stdout);

    if (!result.valid) {
      for (const reason of result.reasons) {
        stderr.error(`- ${reason}`);
      }
      throw new Error(`Validation failed for session "${result.sessionId}" phase "${result.phase}".`);
    }

    stdout.log(result.resumedFromPhase ? "Validation recovered and workflow resumed." : "Validation passed.");
    return;
  }

  const parsed = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      "app-name": { type: "string" },
      template: { type: "string" },
      design: { type: "string" },
      force: { type: "boolean" },
      "skip-validation": { type: "boolean" },
      runtimeValidation: { type: "boolean" },
      "runtime-validation": { type: "boolean" },
      resume: { type: "string" },
      stdout: { type: "string" },
    },
  });

  const resumeSessionId =
    parsed.values.resume && parsed.values.resume.trim() !== ""
      ? parsed.values.resume.trim()
      : undefined;
  const stdoutMode: StdoutMode = resolveWorkflowStdoutMode(parsed.values.stdout);
  const runtimeValidationFlag = hasRuntimeValidationFlag(parsed.values);

  if (parsed.values.resume !== undefined) {
    if (!resumeSessionId) {
      throw new Error("A session id is required when using --resume.");
    }

    if (parsed.positionals.length > 0) {
      throw new Error("Do not pass a Markdown spec path when using --resume; pass only --resume <session-id>.");
    }

    if (parsed.values["app-name"] || parsed.values.template || parsed.values.design || parsed.values.force === true) {
      throw new Error("The --app-name, --template, --design, and --force options cannot be used with --resume.");
    }

    logCliExecutionParameters(stdoutMode, stdout, {
      command: "generate",
      resume: resumeSessionId,
      skipValidation: parsed.values["skip-validation"] === true,
      runtimeValidation: runtimeValidationFlag,
      model: resolveCliModelName(),
      stdout: stdoutMode,
      cwd,
    });

    const result = runtimeValidationFlag
      ? await validateSessionPhase({
          sessionId: resumeSessionId,
          phase: "runtimeValidation",
          stdoutMode,
          cwd,
          ...(parsed.values["skip-validation"] === true ? { skipValidation: true } : {}),
          ...(deps.generator ? { generator: deps.generator } : {}),
          ...(deps.validator ? { validator: deps.validator } : {}),
        })
      : await resumeSession({
          sessionId: resumeSessionId,
          stdoutMode,
          cwd,
          ...(parsed.values["skip-validation"] === true ? { skipValidation: true } : {}),
          ...(deps.generator ? { generator: deps.generator } : {}),
          ...(deps.validator ? { validator: deps.validator } : {}),
        });

    printSessionValidationResult(result, stdout);

    if (!result.valid) {
      for (const reason of result.reasons) {
        stderr.error(`- ${reason}`);
      }
      throw new Error(`Resume failed for session "${result.sessionId}" phase "${result.phase}".`);
    }

    if (runtimeValidationFlag) {
      stdout.log(result.resumedFromPhase ? "Runtime validation recovered and workflow resumed." : "Runtime validation passed.");
    } else {
      stdout.log(result.resumedFromPhase ? "Session resumed." : "Session already complete.");
    }
    return;
  }

  const specPath = parsed.positionals[0];
  if (!specPath) {
    throw new Error("A Markdown spec path is required.");
  }

  if (runtimeValidationFlag) {
    throw new Error("The runtimeValidation flag can only be used with validate or generate --resume.");
  }

  const resolvedSpecPath = path.resolve(cwd, specPath);
  const appNameOverride =
    parsed.values["app-name"] && parsed.values["app-name"].trim() !== ""
      ? parsed.values["app-name"]
      : undefined;
  const templateId =
    parsed.values.template && parsed.values.template.trim() !== ""
      ? parsed.values.template
      : DEFAULT_TEMPLATE_ID;
  const resolvedDesignPath =
    parsed.values.design && parsed.values.design.trim() !== ""
      ? path.resolve(cwd, parsed.values.design)
      : undefined;

  const options: GenerateAppOptions = {
    specPath: resolvedSpecPath,
    force: parsed.values.force ?? false,
    templateId,
    skipValidation: parsed.values["skip-validation"] === true,
    stdoutMode,
  };

  if (resolvedDesignPath) {
    options.designPath = resolvedDesignPath;
  }

  if (appNameOverride) {
    options.appNameOverride = appNameOverride;
  }

  if (deps.generator) {
    options.generator = deps.generator;
  }

  if (deps.validator) {
    options.validator = deps.validator;
  }

  logCliExecutionParameters(stdoutMode, stdout, {
    command: "generate",
    specPath: resolvedSpecPath,
    appName: appNameOverride ?? "auto",
    template: templateId,
    ...(resolvedDesignPath ? { design: resolvedDesignPath } : {}),
    force: options.force ?? false,
    skipValidation: options.skipValidation ?? false,
    model: resolveCliModelName(),
    stdout: stdoutMode,
    cwd,
  });

  const result = await generateApplication(options);
  stdout.log(`Session: ${result.sessionId}`);
  stdout.log(`Template: ${result.templateId}`);
  stdout.log(`Generated ${result.report.appName} at ${result.outputDirectory}`);
  if (result.report.entities.length > 0) {
    stdout.log(`Entities: ${result.report.entities.join(", ")}`);
  }
}
