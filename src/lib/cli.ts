import path from "node:path";
import { parseArgs } from "node:util";

import { generateApplication, validateSessionPhase } from "./generator.js";
import { GenerateAppOptions, GeneratedAppValidator, TextGenerator, ValidationPhase } from "./types.js";

function formatValidationStepLine(step: { name: string; ok: boolean; detail: string }): string {
  return `- ${step.ok ? "OK" : "FAIL"} ${step.name}: ${step.detail}`;
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
  app-builder generate <spec.md> [--app-name <name>] [--template <id>] [--force]
  app-builder validate <session-id> --phase <plan|generate>

Environment:
  OPENAI_API_KEY    Required unless a custom generator is injected
  OPENAI_BASE_URL   Optional API base URL override
  APP_BUILDER_MODEL Optional deepagents model override
  APP_BUILDER_STREAM_MODES Optional comma-separated deepagents stream modes
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

  const command = argv[0];
  if (command !== "generate" && command !== "validate") {
    throw new Error(`Unknown command "${command}".\n\n${helpText()}`);
  }

  if (command === "validate") {
    const parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        phase: { type: "string" },
      },
    });

    const sessionId = parsed.positionals[0];
    if (!sessionId) {
      throw new Error("A session id is required.");
    }

    const phaseValue = parsed.values.phase;
    if (phaseValue !== "plan" && phaseValue !== "generate") {
      throw new Error('The --phase option is required and must be either "plan" or "generate".');
    }

    const result = await validateSessionPhase({
      sessionId,
      phase: phaseValue satisfies ValidationPhase,
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
    },
  });

  const specPath = parsed.positionals[0];
  if (!specPath) {
    throw new Error("A Markdown spec path is required.");
  }

  const options: GenerateAppOptions = {
    specPath: path.resolve(cwd, specPath),
    force: parsed.values.force ?? false,
  };

  if (parsed.values["app-name"]) {
    options.appNameOverride = parsed.values["app-name"];
  }

  if (parsed.values.template) {
    options.templateId = parsed.values.template;
  }

  if (deps.generator) {
    options.generator = deps.generator;
  }

  if (deps.validator) {
    options.validator = deps.validator;
  }

  const result = await generateApplication(options);
  stdout.log(`Session: ${result.sessionId}`);
  stdout.log(`Template: ${result.templateId}`);
  stdout.log(`Generated ${result.report.appName} at ${result.outputDirectory}`);
  if (result.report.entities.length > 0) {
    stdout.log(`Entities: ${result.report.entities.join(", ")}`);
  }
}
