import path from "node:path";
import { parseArgs } from "node:util";

import { generateApplication, validateSessionPhase } from "./generator.js";
import { DEFAULT_TEMPLATE_ID } from "./template-pack.js";
import { resolveWorkflowStdoutMode } from "./terminal-ui.js";
import { GenerateAppOptions, GeneratedAppValidator, StdoutMode, TextGenerator, ValidationPhase } from "./types.js";

function formatValidationStepLine(step: { name: string; ok: boolean; detail: string }): string {
  return `- ${step.ok ? "OK" : "FAIL"} ${step.name}: ${step.detail}`;
}

type CliExecutionParameterValue = string | boolean;

const DEFAULT_DEEPAGENTS_MODEL = "openai:gpt-4.1-mini";

function resolveCliModelName(): string {
  return process.env.APP_BUILDER_MODEL || DEFAULT_DEEPAGENTS_MODEL;
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

type CliDeps = {
  generator?: TextGenerator;
  validator?: GeneratedAppValidator;
  stdout?: Pick<typeof console, "log">;
  stderr?: Pick<typeof console, "error">;
  cwd?: string;
};

function helpText(): string {
  return `Usage:
  app-builder generate <spec.md> [--app-name <name>] [--template <id>] [--force] [--stdout <log|dashboard>]
  app-builder -g <spec.md> [--app-name <name>] [--template <id>] [--force] [--stdout <log|dashboard>]
  app-builder validate <session-id> [--phase <plan|generate|auto>] [--stdout <log|dashboard>]
  app-builder -v <session-id> [--phase <plan|generate|auto>] [--stdout <log|dashboard>]

Environment:
  OPENAI_API_KEY    Required unless a custom generator is injected
  OPENAI_BASE_URL   Optional API base URL override
  APP_BUILDER_MODEL Optional deepagents model override
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
        stdout: { type: "string" },
      },
    });

    const sessionId = parsed.positionals[0];
    if (!sessionId) {
      throw new Error("A session id is required.");
    }

    const phaseValue = parsed.values.phase;
    if (phaseValue !== undefined && phaseValue !== "plan" && phaseValue !== "generate" && phaseValue !== "auto") {
      throw new Error('The --phase option must be one of "plan", "generate", or "auto".');
    }
    const stdoutModeValue = parsed.values.stdout;
    const stdoutMode = resolveWorkflowStdoutMode(stdoutModeValue);
    const phase = phaseValue === "plan" || phaseValue === "generate" ? phaseValue : "auto";

    logCliExecutionParameters(stdoutMode, stdout, {
      command: "validate",
      sessionId,
      phase,
      model: resolveCliModelName(),
      stdout: stdoutMode,
      cwd,
    });

    const result = await validateSessionPhase({
      sessionId,
      ...(phaseValue === "plan" || phaseValue === "generate"
        ? { phase: phaseValue satisfies ValidationPhase }
        : {}),
      stdoutMode,
      cwd,
      ...(deps.generator ? { generator: deps.generator } : {}),
      ...(deps.validator ? { validator: deps.validator } : {}),
    });

    stdout.log(`Session: ${result.sessionId}`);
    stdout.log(`Phase: ${result.phase}`);
    stdout.log(`Output: ${result.outputDirectory}`);
    stdout.log(`Validation artifact: ${result.validationPath}`);
    if (result.runtimeValidationLogPath) {
      stdout.log(`Runtime log: ${result.runtimeValidationLogPath}`);
    }
    stdout.log(`Workflow: ${result.workflowPhase}`);
    if (result.resumedFromPhase) {
      stdout.log(`Resumed from: ${result.resumedFromPhase}`);
    }
    if (result.phase === "generate" && result.steps && result.steps.length > 0) {
      stdout.log("Validation steps:");
      for (const step of result.steps) {
        stdout.log(formatValidationStepLine(step));
      }
    }

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
      force: { type: "boolean" },
      stdout: { type: "string" },
    },
  });

  const specPath = parsed.positionals[0];
  if (!specPath) {
    throw new Error("A Markdown spec path is required.");
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
  const stdoutMode: StdoutMode = resolveWorkflowStdoutMode(parsed.values.stdout);

  const options: GenerateAppOptions = {
    specPath: resolvedSpecPath,
    force: parsed.values.force ?? false,
    templateId,
    stdoutMode,
  };

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
    force: options.force ?? false,
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
