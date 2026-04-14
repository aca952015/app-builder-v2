import path from "node:path";
import { parseArgs } from "node:util";

import { generateApplication } from "./generator.js";
import { GenerateAppOptions, TextGenerator } from "./types.js";

type CliDeps = {
  generator?: TextGenerator;
  stdout?: Pick<typeof console, "log">;
  stderr?: Pick<typeof console, "error">;
};

function helpText(): string {
  return `Usage:
  app-builder generate <spec.md> [--app-name <name>] [--template <id>] [--force]

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

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    stdout.log(helpText());
    return;
  }

  const command = argv[0];
  if (command !== "generate") {
    throw new Error(`Unknown command "${command}".\n\n${helpText()}`);
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
    specPath: path.resolve(specPath),
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

  const result = await generateApplication(options);
  stdout.log(`Session: ${result.sessionId}`);
  stdout.log(`Template: ${result.templateId}`);
  stdout.log(`Generated ${result.report.appName} at ${result.outputDirectory}`);
  stdout.log(`Entities: ${result.report.entities.join(", ")}`);
  if (result.report.defaultsApplied.length > 0) {
    stdout.log(`Defaults: ${result.report.defaultsApplied.join(" | ")}`);
  }
  if (result.report.warnings.length > 0) {
    stderr.error(`Warnings: ${result.report.warnings.join(" | ")}`);
  }
}
