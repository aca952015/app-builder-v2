import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { validatePlanSpec, type PlanSpec } from "./plan-spec.js";
import { routeToPageFileCandidates } from "./app-router.js";
import { parseDotEnv } from "./env.js";
import {
  parseSanitizedModelRoleConfigs,
  resolveModelRoleConfigs,
  sanitizeModelRoleConfigs,
  validateModelRoleApiKeys,
  type SanitizedModelRoleConfigMap,
} from "./model-config.js";
import { prepareOutputWorkspace, writeDeepagentsConfig } from "./output-workspace.js";
import { parsePrd } from "./prd-parser.js";
import { normalizeSpec } from "./spec-normalizer.js";
import { copyStarterScaffold, loadTemplatePack, stageTemplatePack } from "./template-pack.js";
import { DeepAgentsTextGenerator, materializeSessionPromptSnapshots } from "./text-generator.js";
import {
  closeRuntimeInteractionValidationSession,
  runInteractiveRuntimeValidation,
  type RuntimeInteractionValidationArtifact,
  type RuntimeInteractionValidationSession,
} from "./interactive-runtime-validation.js";
import {
  appendWorkflowLog,
  closeWorkflowBoard,
  createArtifactItemsForStage,
  createStepItemsForLifecycle,
  setWorkflowStdoutMode,
  updateWorkflowBoard,
} from "./terminal-ui.js";
import {
  type GeneratedAppValidator,
  GenerateAppOptions,
  GeneratedProject,
  GenerationValidationStep,
  GenerationReport,
  GenerationResult,
  PlanResult,
  SessionValidationResult,
  type TemplatePhaseMap,
  type TemplateRepairRetries,
  type TemplateInteractiveRuntimeValidation,
  type TemplateRuntimeValidation,
  type TemplateRuntimeValidationStep,
  TextGenerator,
  TextGeneratorRuntime,
  type StdoutMode,
  ValidationPhase,
  WorkflowPhase,
} from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_DEV_SERVER_READY_TIMEOUT_MS = 90_000;
type RetryStage = "计划阶段" | "计划修复阶段" | "生成阶段" | "生成修复阶段";

function defaultTemplateRuntimeValidation(): TemplateRuntimeValidation {
  return {
    copyEnvExample: true,
    steps: [
      { name: "pnpm install", command: "pnpm", args: ["install"] },
      { name: "pnpm db:init", command: "pnpm", args: ["db:init"] },
      { name: "pnpm dev", command: "pnpm", args: ["dev"], kind: "dev-server" },
    ],
  };
}

function defaultTemplateInteractiveRuntimeValidation(): TemplateInteractiveRuntimeValidation {
  return {
    enabled: false,
    coverageThreshold: 0.8,
    idleTimeoutMs: 10_000,
    readyTimeoutMs: 90_000,
  };
}

class PassthroughGeneratedAppValidator implements GeneratedAppValidator {
  async validate(): Promise<{ reasons: string[]; steps: GenerationValidationStep[] }> {
    return {
      reasons: [],
      steps: [],
    };
  }
}

function summarizeCommandOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "没有捕获到额外输出。";
  }

  const excerpt = lines.slice(-8).join(" | ");
  return excerpt.length > 400 ? `${excerpt.slice(0, 397)}...` : excerpt;
}

async function appendRuntimeValidationLog(logPath: string, lines: string[]): Promise<void> {
  await fs.appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
}

function readEnvCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string" && direct !== "") {
    return direct;
  }

  const matchedKey = Object.keys(env).find((entry) => entry.toLowerCase() === key.toLowerCase());
  if (!matchedKey) {
    return undefined;
  }

  const value = env[matchedKey];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function resolveSpawnCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.platform !== "win32") {
    return command;
  }

  if (path.extname(command) !== "") {
    return command;
  }

  const pathExt = readEnvCaseInsensitive(env, "PATHEXT");
  const extensions = (pathExt ? pathExt.split(";") : [".COM", ".EXE", ".BAT", ".CMD"])
    .map((entry) => entry.trim())
    .filter(Boolean);

  const commandHasPathSeparator = /[\\/]/.test(command);
  const searchDirectories = commandHasPathSeparator
    ? [""]
    : (readEnvCaseInsensitive(env, "PATH") ?? "")
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean);

  for (const directory of searchDirectories) {
    const basePath = directory ? path.join(directory, command) : command;
    for (const extension of extensions) {
      const candidate = `${basePath}${extension}`;
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

async function spawnValidationCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ChildProcess> {
  const combinedEnv = {
    ...process.env,
    ...options.env,
  };
  const resolvedCommand = await resolveSpawnCommand(options.command, combinedEnv);

  return spawn(resolvedCommand, options.args, {
    cwd: options.cwd,
    env: combinedEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const exitPromise = once(child, "exit").catch(() => undefined);
  const settled = await Promise.race([
    exitPromise.then(() => true),
    sleep(3_000).then(() => false),
  ]);

  if (settled) {
    return;
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  await exitPromise;
}

async function runCommandStep(options: {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  logPath: string;
}): Promise<{ step: GenerationValidationStep; output: string }> {
  let output = "";
  let timedOut = false;

  await appendRuntimeValidationLog(options.logPath, [
    `=== ${options.name} ===`,
    `$ ${[options.command, ...options.args].join(" ")}`,
    "",
  ]);

  let child: ChildProcess;
  try {
    child = await spawnValidationCommand(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendRuntimeValidationLog(options.logPath, [
      `[error] Failed to start command. ${detail}`,
      "",
    ]);
    return {
      step: {
        name: options.name,
        ok: false,
        detail: `Failed to start command. ${detail}`,
      },
      output,
    };
  }

  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    void fs.appendFile(options.logPath, text, "utf8");
  };

  child.stdout!.on("data", onChunk);
  child.stderr!.on("data", onChunk);

  const timeout = setTimeout(() => {
    timedOut = true;
    void terminateChildProcess(child);
  }, options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);

  const [exitCode, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  clearTimeout(timeout);

  await appendRuntimeValidationLog(options.logPath, [
    "",
    timedOut
      ? `[timeout] ${options.name} 在 ${(options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS) / 1000}s 内未完成。`
      : `[exit] code=${exitCode ?? "null"} signal=${signal ?? "null"}`,
    "",
  ]);

  if (timedOut) {
    return {
      step: {
        name: options.name,
        ok: false,
        detail: `执行超时。摘要：${summarizeCommandOutput(output)}`,
      },
      output,
    };
  }

  if (exitCode !== 0) {
    return {
      step: {
        name: options.name,
        ok: false,
        detail: `退出码 ${exitCode ?? "null"}。摘要：${summarizeCommandOutput(output)}`,
      },
      output,
    };
  }

  return {
    step: {
      name: options.name,
      ok: true,
      detail: "执行成功。",
    },
    output,
  };
}

async function ensureEnvFile(outputDirectory: string, logPath: string): Promise<GenerationValidationStep> {
  const envExamplePath = path.join(outputDirectory, ".env.example");
  const envPath = path.join(outputDirectory, ".env");

  if (await readIfExists(envPath)) {
    await appendRuntimeValidationLog(logPath, [
      "=== mv .env.example .env ===",
      "[skip] .env 已存在，保留当前文件。",
      "",
    ]);
    return {
      name: "mv .env.example .env",
      ok: true,
      detail: ".env 已存在，跳过覆盖。",
    };
  }

  const envExampleContents = await readIfExists(envExamplePath);
  if (!envExampleContents) {
    await appendRuntimeValidationLog(logPath, [
      "=== mv .env.example .env ===",
      "[error] 缺少 .env.example，无法准备运行环境。",
      "",
    ]);
    return {
      name: "mv .env.example .env",
      ok: false,
      detail: "缺少 .env.example，无法生成 .env。",
    };
  }

  await fs.copyFile(envExamplePath, envPath);
  await appendRuntimeValidationLog(logPath, [
    "=== mv .env.example .env ===",
    "[ok] 已按校验要求从 .env.example 生成 .env（保留 example 以支持重复验证）。",
    "",
  ]);
  return {
    name: "mv .env.example .env",
    ok: true,
    detail: "已从 .env.example 生成 .env。",
  };
}

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a free port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function pingDevServer(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        method: "GET",
        timeout: 1_000,
      },
      (response) => {
        response.resume();
        resolve(true);
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function runDevValidationStep(outputDirectory: string, logPath: string): Promise<GenerationValidationStep> {
  const port = await reserveFreePort();
  let output = "";
  let finished = false;

  await appendRuntimeValidationLog(logPath, [
    "=== pnpm dev ===",
    `$ PORT=${port} HOSTNAME=127.0.0.1 pnpm dev`,
    "",
  ]);

  let child: ChildProcess;
  try {
    child = await spawnValidationCommand({
      command: "pnpm",
      args: ["dev"],
      cwd: outputDirectory,
      env: {
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendRuntimeValidationLog(logPath, [
      `[error] Failed to start command. ${detail}`,
      "",
    ]);
    return {
      name: "pnpm dev",
      ok: false,
      detail: `Failed to start command. ${detail}`,
    };
  }

  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    void fs.appendFile(logPath, text, "utf8");
  };

  child.stdout!.on("data", onChunk);
  child.stderr!.on("data", onChunk);

  const finish = async (step: GenerationValidationStep): Promise<GenerationValidationStep> => {
    if (finished) {
      return step;
    }
    finished = true;
    await terminateChildProcess(child);
    await appendRuntimeValidationLog(logPath, [
      "",
      step.ok ? `[ok] ${step.detail}` : `[error] ${step.detail}`,
      "",
    ]);
    return step;
  };

  const timeoutAt = Date.now() + DEFAULT_DEV_SERVER_READY_TIMEOUT_MS;
  while (!finished && Date.now() < timeoutAt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const exitCode = child.exitCode;
      const signal = child.signalCode;
      return await finish({
        name: "pnpm dev",
        ok: false,
        detail: `开发服务器提前退出，exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}。摘要：${summarizeCommandOutput(output)}`,
      });
    }

    if (await pingDevServer(port)) {
      return await finish({
        name: "pnpm dev",
        ok: true,
        detail: `开发服务器已在 http://127.0.0.1:${port} 成功启动并响应请求。`,
      });
    }

    await sleep(1_000);
  }

  return await finish({
    name: "pnpm dev",
    ok: false,
    detail: `等待开发服务器启动超时。摘要：${summarizeCommandOutput(output)}`,
  });
}

async function runConfiguredDevValidationStep(options: {
  outputDirectory: string;
  logPath: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  name: string;
}): Promise<GenerationValidationStep> {
  const port = await reserveFreePort();
  let output = "";
  let finished = false;

  await appendRuntimeValidationLog(options.logPath, [
    `=== ${options.name} ===`,
    `$ PORT=${port} HOSTNAME=127.0.0.1 ${[options.command, ...options.args].join(" ")}`,
    "",
  ]);

  let child: ChildProcess;
  try {
    child = await spawnValidationCommand({
      command: options.command,
      args: options.args,
      cwd: options.outputDirectory,
      env: {
        ...options.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendRuntimeValidationLog(options.logPath, [
      `[error] Failed to start command. ${detail}`,
      "",
    ]);
    return {
      name: options.name,
      ok: false,
      detail: `Failed to start command. ${detail}`,
    };
  }

  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    void fs.appendFile(options.logPath, text, "utf8");
  };

  child.stdout!.on("data", onChunk);
  child.stderr!.on("data", onChunk);

  const finish = async (step: GenerationValidationStep): Promise<GenerationValidationStep> => {
    if (finished) {
      return step;
    }
    finished = true;
    await terminateChildProcess(child);
    await appendRuntimeValidationLog(options.logPath, [
      "",
      step.ok ? `[ok] ${step.detail}` : `[error] ${step.detail}`,
      "",
    ]);
    return step;
  };

  const timeoutAt = Date.now() + DEFAULT_DEV_SERVER_READY_TIMEOUT_MS;
  while (!finished && Date.now() < timeoutAt) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const exitCode = child.exitCode;
      const signal = child.signalCode;
      return await finish({
        name: options.name,
        ok: false,
        detail: `Dev server exited early (exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}). Summary: ${summarizeCommandOutput(output)}`,
      });
    }

    if (await pingDevServer(port)) {
      return await finish({
        name: options.name,
        ok: true,
        detail: `Dev server responded at http://127.0.0.1:${port}.`,
      });
    }

    await sleep(1_000);
  }

  return await finish({
    name: options.name,
    ok: false,
    detail: `Timed out waiting for the dev server. Summary: ${summarizeCommandOutput(output)}`,
  });
}

class ShellGeneratedAppValidator implements GeneratedAppValidator {
  async validate(outputDirectory: string, runtime: TextGeneratorRuntime): Promise<{
    reasons: string[];
    steps: GenerationValidationStep[];
  }> {
    await fs.writeFile(runtime.deepagentsRuntimeValidationLogPath, "", "utf8");

    const steps: GenerationValidationStep[] = [];
    const runtimeValidation = runtime.templateRuntimeValidation ?? defaultTemplateRuntimeValidation();

    if (runtimeValidation.copyEnvExample !== false) {
      const envStep = await ensureEnvFile(outputDirectory, runtime.deepagentsRuntimeValidationLogPath);
      steps.push(envStep);
      if (!envStep.ok) {
        return {
          reasons: [`生成阶段运行验证失败：${envStep.name} 未通过。${envStep.detail} 详见 .deepagents/runtime-validation.log。`],
          steps,
        };
      }
    }

    for (const validationStep of runtimeValidation.steps) {
      const step =
        validationStep.kind === "dev-server"
          ? await runConfiguredDevValidationStep({
              outputDirectory,
              logPath: runtime.deepagentsRuntimeValidationLogPath,
              command: validationStep.command,
              args: validationStep.args,
              name: validationStep.name,
              ...(validationStep.env ? { env: validationStep.env } : {}),
            })
          : (
              await runCommandStep({
                name: validationStep.name,
                command: validationStep.command,
                args: validationStep.args,
                cwd: outputDirectory,
                logPath: runtime.deepagentsRuntimeValidationLogPath,
                ...(validationStep.env ? { env: validationStep.env } : {}),
              })
            ).step;
      steps.push(step);
      if (!step.ok) {
        return {
          reasons: [`生成阶段运行验证失败：${validationStep.name} 未通过。${step.detail} 详见 .deepagents/runtime-validation.log。`],
          steps,
        };
      }
    }

    return {
      reasons: [],
      steps,
    };
  }
}

type PersistedGenerationValidation = {
  valid: boolean;
  reasons: string[];
  steps: GenerationValidationStep[];
};

async function readPersistedGenerationValidation(validationPath: string): Promise<PersistedGenerationValidation | null> {
  const contents = await readIfExists(validationPath);
  if (!contents || contents.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(contents) as Partial<PersistedGenerationValidation>;
    return {
      valid: parsed.valid === true,
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.filter((reason): reason is string => typeof reason === "string")
        : [],
      steps: Array.isArray(parsed.steps)
        ? parsed.steps.flatMap((step): GenerationValidationStep[] => {
            if (!step || typeof step !== "object") {
              return [];
            }
            const candidate = step as Partial<GenerationValidationStep>;
            if (typeof candidate.name !== "string" || typeof candidate.ok !== "boolean" || typeof candidate.detail !== "string") {
              return [];
            }
            return [{
              name: candidate.name,
              ok: candidate.ok,
              detail: candidate.detail,
            }];
          })
        : [],
    };
  } catch {
    return null;
  }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

async function collectGeneratedCoverage(
  outputDirectory: string,
  planSpec: PlanSpec,
): Promise<{
  pageExistsByRoute: Map<string, boolean>;
  apiExistsByPath: Map<string, boolean>;
  missingPageRoutes: string[];
  missingApiPaths: string[];
  indirectResources: string[];
}> {
  const uniquePageRoutes = uniqueValues(planSpec.pages.map((page) => page.route));
  const uniqueApiPaths = uniqueValues(planSpec.apis.map((api) => api.path));
  const pageExistsByRoute = new Map<string, boolean>();
  const apiExistsByPath = new Map<string, boolean>();

  for (const route of uniquePageRoutes) {
    const candidates = routeToPageFileCandidates(route);
    let exists = false;
    for (const candidate of candidates) {
      if (await pathExists(path.join(outputDirectory, normalizeRelativePath(candidate)))) {
        exists = true;
        break;
      }
    }
    pageExistsByRoute.set(route, exists);
  }

  for (const apiPath of uniqueApiPaths) {
    apiExistsByPath.set(
      apiPath,
      await pathExists(path.join(outputDirectory, normalizeRelativePath(apiPath))),
    );
  }

  const missingPageRoutes = uniquePageRoutes.filter((route) => pageExistsByRoute.get(route) !== true);
  const missingApiPaths = uniqueApiPaths.filter((apiPath) => apiExistsByPath.get(apiPath) !== true);
  const indirectResources: string[] = [];

  for (const resource of planSpec.resources) {
    if (resource.usage === "indirect") {
      indirectResources.push(resource.name);
    }
  }

  return {
    pageExistsByRoute,
    apiExistsByPath,
    missingPageRoutes,
    missingApiPaths,
    indirectResources,
  };
}

async function appendIndirectResourceCoverageNotice(resourceNames: string[]): Promise<void> {
  if (resourceNames.length === 0) {
    return;
  }

  await appendWorkflowLog(
    `[host] 检测到标记为 indirect 的资源 ${resourceNames.join(", ")}，已跳过专有页面/API 覆盖校验。`,
  );
}

function collectMissingDeliveryAcceptanceChecks(
  planSpec: PlanSpec,
  coverage: Pick<Awaited<ReturnType<typeof collectGeneratedCoverage>>, "missingPageRoutes" | "missingApiPaths">,
): string[] {
  const missingPages = new Set(coverage.missingPageRoutes);
  const missingApis = new Set(coverage.missingApiPaths);

  return planSpec.acceptanceChecks.flatMap((check) => {
    if (check.type === "page" && missingPages.has(check.target)) {
      return [`${check.id}(${check.target})`];
    }

    if (check.type === "api" && missingApis.has(check.target)) {
      return [`${check.id}(${check.target})`];
    }

    return [];
  });
}

async function collectEnvironmentVariableIssues(
  outputDirectory: string,
  planSpec: PlanSpec,
): Promise<string[]> {
  const declaredVariables = (planSpec.environmentVariables ?? [])
    .filter((variable) => (variable.targetFile ?? ".env.example") === ".env.example");
  if (declaredVariables.length === 0) {
    return [];
  }

  const envExamplePath = path.join(outputDirectory, ".env.example");
  const envExampleContents = await readIfExists(envExamplePath);
  if (!envExampleContents || envExampleContents.trim().length === 0) {
    return ["生成阶段未完成：planSpec.environmentVariables 声明了环境变量，但 .env.example 尚未落盘。"];
  }

  const parsed = parseDotEnv(envExampleContents);
  const missingNames = declaredVariables
    .filter((variable) => parsed[variable.name] === undefined)
    .map((variable) => variable.name);
  const mismatchedNames = declaredVariables
    .filter((variable) => {
      const actual = parsed[variable.name];
      return actual !== undefined && actual !== variable.value;
    })
    .map((variable) => variable.name);
  const issues: string[] = [];

  if (missingNames.length > 0) {
    issues.push(`生成阶段未完成：.env.example 缺少 planSpec.environmentVariables 声明的变量：${missingNames.join(", ")}。`);
  }

  if (mismatchedNames.length > 0) {
    issues.push(`生成阶段未完成：.env.example 中以下变量的值与 planSpec.environmentVariables 不一致：${mismatchedNames.join(", ")}。`);
  }

  return issues;
}

function resolveAppPrefixedPath(outputDirectory: string, filePath: string): string {
  const relativePath = path.relative(outputDirectory, filePath);
  return path.join(outputDirectory, "app", relativePath);
}

async function relocateIfWrittenUnderApp(outputDirectory: string, filePath: string): Promise<string | null> {
  const currentContents = await readIfExists(filePath);
  if (currentContents && currentContents.trim().length > 0) {
    return null;
  }

  const misplacedPath = resolveAppPrefixedPath(outputDirectory, filePath);
  const misplacedContents = await readIfExists(misplacedPath);
  if (!misplacedContents || misplacedContents.trim().length === 0) {
    return null;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, misplacedContents, "utf8");
  await fs.rm(misplacedPath, { force: true });
  return path.relative(outputDirectory, misplacedPath).split(path.sep).join("/");
}

async function reconcileHostManagedArtifacts(runtime: TextGeneratorRuntime, targets: string[]): Promise<void> {
  for (const target of targets) {
    const relocatedFrom = await relocateIfWrittenUnderApp(runtime.outputDirectory, target);
    if (!relocatedFrom) {
      continue;
    }

    const relocatedTo = path.relative(runtime.outputDirectory, target).split(path.sep).join("/");
    await appendWorkflowLog(`[host] 检测到误写路径 ${relocatedFrom}，已归位到 ${relocatedTo}。`);
  }
}

function collectPlanSpecConsistencyIssues(planSpec: PlanSpec): string[] {
  const issues: string[] = [];
  const resourceNames = new Set(planSpec.resources.map((resource) => resource.name));
  const resourceRouteSegments = new Set<string>();
  const pageRoutes = new Set<string>();
  const apiPaths = new Set<string>();
  const apiOperations = new Set<string>();

  for (const resource of planSpec.resources) {
    if (resourceRouteSegments.has(resource.routeSegment)) {
      issues.push(`resources 中存在重复的 routeSegment：${resource.routeSegment}`);
    }
    resourceRouteSegments.add(resource.routeSegment);
  }

  for (const page of planSpec.pages) {
    if (pageRoutes.has(page.route)) {
      issues.push(`pages 中存在重复的 route：${page.route}`);
    }
    pageRoutes.add(page.route);

    if (page.resourceName && !resourceNames.has(page.resourceName)) {
      issues.push(`页面 ${page.route} 引用了未定义资源 ${page.resourceName}`);
    }
  }

  for (const api of planSpec.apis) {
    apiPaths.add(api.path);

    for (const method of api.methods) {
      const operationKey = `${api.path}#${method}`;
      if (apiOperations.has(operationKey)) {
        issues.push(`apis 中存在重复的 path+method：${method} ${api.path}`);
      }
      apiOperations.add(operationKey);
    }

    if (!resourceNames.has(api.resourceName)) {
      issues.push(`接口 ${api.path} 引用了未定义资源 ${api.resourceName}`);
    }
  }

  for (const check of planSpec.acceptanceChecks) {
    if (check.type === "resource" && !resourceNames.has(check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义资源 ${check.target}`);
    }
    if (check.type === "page" && !pageRoutes.has(check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义页面 ${check.target}`);
    }
    if (check.type === "api" && !apiPaths.has(check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义接口 ${check.target}`);
    }
    if (check.type === "flow" && !planSpec.flows.some((flow) => flow.name === check.target)) {
      issues.push(`acceptanceChecks ${check.id} 指向未定义流程 ${check.target}`);
    }
  }

  return issues;
}

function normalizePlanSpecToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function toKebabCase(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function normalizePageRouteToken(route: string): string {
  const trimmed = route.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "dashboard";
  }

  return normalizePlanSpecToken(
    trimmed
      .split("/")
      .map((segment) => segment.replace(/\[(.+?)\]/g, "$1"))
      .join("-"),
  );
}

function buildInferredResource(name: string): PlanSpec["resources"][number] {
  const routeSegmentBase = toKebabCase(name);
  const routeSegment = routeSegmentBase.endsWith("s") ? routeSegmentBase : `${routeSegmentBase}s`;
  const pluralName = name.endsWith("s") ? name : `${name}s`;

  return {
    name,
    pluralName,
    routeSegment,
    description: `由现有 API 定义反推补齐的 ${name} 资源。`,
    fields: [
      {
        name: "id",
        label: "ID",
        type: "string",
        required: true,
        source: "assumption",
        description: "宿主自动补齐的资源主键。",
      },
      {
        name: "name",
        label: "名称",
        type: "string",
        required: true,
        source: "assumption",
        description: "宿主自动补齐的资源展示名称。",
      },
      {
        name: "createdAt",
        label: "创建时间",
        type: "datetime",
        required: false,
        source: "assumption",
        description: "宿主自动补齐的资源创建时间。",
      },
    ],
    relations: [],
  };
}

function resolvePageAcceptanceTarget(
  target: string,
  pages: PlanSpec["pages"],
): string | null {
  if (pages.some((page) => page.route === target)) {
    return target;
  }

  const normalizedTarget = normalizePlanSpecToken(target);
  if (!normalizedTarget) {
    return null;
  }

  if (normalizedTarget === "dashboard") {
    const dashboardPage = pages.find((page) => page.route === "/");
    if (dashboardPage) {
      return dashboardPage.route;
    }
  }

  const byName = pages.filter((page) => normalizePlanSpecToken(page.name) === normalizedTarget);
  if (byName.length === 1) {
    return byName[0]!.route;
  }

  const byRoute = pages.filter((page) => normalizePageRouteToken(page.route) === normalizedTarget);
  if (byRoute.length === 1) {
    return byRoute[0]!.route;
  }

  const byResource = pages.filter(
    (page) => page.resourceName && normalizePlanSpecToken(page.resourceName) === normalizedTarget,
  );
  if (byResource.length === 1) {
    return byResource[0]!.route;
  }

  return null;
}

function normalizeApiPathToken(apiPath: string): string {
  return normalizePlanSpecToken(
    apiPath
      .replace(/^\/app\/api\//, "")
      .replace(/\/route\.ts$/, "")
      .replace(/\//g, "-"),
  );
}

function resolveApiAcceptanceTarget(
  target: string,
  apis: PlanSpec["apis"],
): string | null {
  if (apis.some((api) => api.path === target)) {
    return target;
  }

  const normalizedTarget = normalizePlanSpecToken(target);
  if (!normalizedTarget) {
    return null;
  }

  const byName = apis.filter((api) => normalizePlanSpecToken(api.name) === normalizedTarget);
  if (byName.length === 1) {
    return byName[0]!.path;
  }

  const byPath = apis.filter((api) => normalizeApiPathToken(api.path) === normalizedTarget);
  if (byPath.length === 1) {
    return byPath[0]!.path;
  }

  const byResource = apis.filter((api) => normalizePlanSpecToken(api.resourceName) === normalizedTarget);
  if (byResource.length === 1) {
    return byResource[0]!.path;
  }

  return null;
}

function isCrossCuttingAcceptanceCheck(check: PlanSpec["acceptanceChecks"][number]): boolean {
  const haystack = normalizePlanSpecToken(`${check.target} ${check.description}`);
  return [
    "performance",
    "security",
    "retention",
    "query",
    "permission",
    "encrypt",
    "auth",
    "loadtime",
    "historydata",
  ].some((keyword) => haystack.includes(keyword));
}

function normalizePlanSpecForHostValidation(planSpec: PlanSpec): {
  planSpec: PlanSpec;
  notes: string[];
} {
  const nextPlanSpec = JSON.parse(JSON.stringify(planSpec)) as PlanSpec;
  const notes: string[] = [];

  const existingResourceNames = new Set(nextPlanSpec.resources.map((resource) => resource.name));
  const inferredResourceNames = Array.from(
    new Set(
      nextPlanSpec.apis
        .map((api) => api.resourceName)
        .filter((resourceName) => !existingResourceNames.has(resourceName)),
    ),
  );

  for (const resourceName of inferredResourceNames) {
    nextPlanSpec.resources.push(buildInferredResource(resourceName));
    existingResourceNames.add(resourceName);
    notes.push(`宿主根据 API 定义自动补齐资源 ${resourceName}。`);
  }

  if (inferredResourceNames.length > 0) {
    for (const page of nextPlanSpec.pages) {
      if (page.resourceName) {
        continue;
      }

      const matchingResource = nextPlanSpec.resources.find(
        (resource) => normalizePlanSpecToken(resource.routeSegment) === normalizePageRouteToken(page.route),
      );
      if (!matchingResource) {
        continue;
      }

      page.resourceName = matchingResource.name;
      notes.push(`宿主将页面 ${page.route} 关联到资源 ${matchingResource.name}。`);
    }
  }

  const resourceNames = new Set(nextPlanSpec.resources.map((resource) => resource.name));
  nextPlanSpec.acceptanceChecks = nextPlanSpec.acceptanceChecks.flatMap((check) => {
    if (check.type === "page") {
      const resolvedTarget = resolvePageAcceptanceTarget(check.target, nextPlanSpec.pages);
      if (resolvedTarget && resolvedTarget !== check.target) {
        notes.push(`宿主将验收项 ${check.id} 的页面目标从 ${check.target} 归一化为 ${resolvedTarget}。`);
        return [{ ...check, target: resolvedTarget }];
      }
      return [check];
    }

    if (check.type === "api") {
      const resolvedTarget = resolveApiAcceptanceTarget(check.target, nextPlanSpec.apis);
      if (resolvedTarget && resolvedTarget !== check.target) {
        notes.push(`宿主将验收项 ${check.id} 的接口目标从 ${check.target} 归一化为 ${resolvedTarget}。`);
        return [{ ...check, target: resolvedTarget }];
      }
      return [check];
    }

    if (check.type === "resource") {
      if (resourceNames.has(check.target)) {
        return [check];
      }

      const resolvedResource = nextPlanSpec.resources.find((resource) => {
        const normalizedTarget = normalizePlanSpecToken(check.target);
        return (
          normalizePlanSpecToken(resource.name) === normalizedTarget ||
          normalizePlanSpecToken(resource.pluralName) === normalizedTarget ||
          normalizePlanSpecToken(resource.routeSegment) === normalizedTarget
        );
      });

      if (resolvedResource) {
        notes.push(`宿主将验收项 ${check.id} 的资源目标从 ${check.target} 归一化为 ${resolvedResource.name}。`);
        return [{ ...check, target: resolvedResource.name }];
      }

      if (isCrossCuttingAcceptanceCheck(check)) {
        notes.push(`宿主移除了无法结构化校验的跨领域验收项 ${check.id}（${check.target}）。`);
        return [];
      }
    }

    return [check];
  });

  return {
    planSpec: nextPlanSpec,
    notes,
  };
}

async function writePlanValidationResult(
  validationPath: string,
  payload: {
    valid: boolean;
    reasons: string[];
    planSpecVersion?: number;
  },
): Promise<void> {
  await fs.writeFile(validationPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function normalizePersistedPlanSpec(runtime: TextGeneratorRuntime, planSpec: PlanSpec): Promise<PlanSpec> {
  const normalized = normalizePlanSpecForHostValidation(planSpec);
  if (normalized.notes.length === 0) {
    return planSpec;
  }

  await fs.writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(normalized.planSpec, null, 2)}\n`, "utf8");
  await appendWorkflowLog(`[host] 计划规格已自动归一化：${normalized.notes.join(" ")}`);
  return normalized.planSpec;
}

function isMissingStructuredResponseError(error: unknown): boolean {
  return error instanceof Error && /did not return a valid structured response/.test(error.message);
}

async function synthesizeRecoveredPlanResult(
  runtime: TextGeneratorRuntime,
  error: unknown,
): Promise<PlanResult | null> {
  if (!isMissingStructuredResponseError(error)) {
    return null;
  }

  const artifactsWritten = (
    await Promise.all([
      runtime.deepagentsAnalysisPath,
      runtime.deepagentsDetailedSpecPath,
      runtime.deepagentsPlanSpecPath,
    ].map(async (filePath) => {
      const contents = await readIfExists(filePath);
      if (!contents || contents.trim().length === 0) {
        return null;
      }
      return path.relative(runtime.outputDirectory, filePath).split(path.sep).join("/");
    }))
  ).filter((value): value is string => value !== null);

  if (artifactsWritten.length === 0) {
    return null;
  }

  await appendWorkflowLog("[host] 计划阶段结构化响应缺失，改为基于已落盘 artifact 尝试恢复。");

  return {
    summary: "结构化响应缺失，宿主已基于已落盘计划产物恢复结果。",
    artifactsWritten,
    planSpecVersion: 1,
    notes: ["host-recovered-from-missing-structured-response"],
  };
}

async function synthesizeRecoveredGeneratedResult(
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
  error: unknown,
): Promise<GeneratedProject | null> {
  if (!isMissingStructuredResponseError(error)) {
    return null;
  }

  const [filesWritten, reportContents, coverage] = await Promise.all([
    collectGeneratedFiles(runtime.outputDirectory),
    readIfExists(path.join(runtime.outputDirectory, "app-builder-report.md")),
    collectGeneratedCoverage(runtime.outputDirectory, planSpec),
  ]);

  const hasGeneratedSignal =
    Boolean(reportContents && reportContents.trim().length > 0) ||
    coverage.missingApiPaths.length < planSpec.apis.length ||
    coverage.missingPageRoutes.length < planSpec.pages.length;

  if (!hasGeneratedSignal || filesWritten.length === 0) {
    return null;
  }

  await appendWorkflowLog("[host] 生成阶段结构化响应缺失，改为基于已落盘 artifact 尝试恢复。");

  return {
    summary: "结构化响应缺失，宿主已基于已落盘生成产物恢复结果。",
    filesWritten,
    implementedResources: planSpec.resources.map((resource) => resource.name),
    implementedPages: planSpec.pages
      .filter((page) => !coverage.missingPageRoutes.includes(page.route))
      .map((page) => page.route),
    implementedApis: Array.from(
      new Set(
        planSpec.apis
          .map((api) => api.path)
          .filter((apiPath) => !coverage.missingApiPaths.includes(apiPath)),
      ),
    ),
    notes: ["host-recovered-from-missing-structured-response"],
  };
}

async function writeGenerationValidationResult(
  validationPath: string,
  payload: {
    valid: boolean;
    reasons: string[];
    steps?: GenerationValidationStep[];
  },
): Promise<void> {
  await fs.writeFile(validationPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function updateWorkflowState(
  configPath: string,
  phase: WorkflowPhase,
  completedPhases: Array<"plan" | "generate" | "runtime_validation">,
): Promise<void> {
  const raw = await fs.readFile(configPath, "utf8");
  const config = JSON.parse(raw) as Record<string, unknown>;
  config.workflow = {
    phase,
    completedPhases,
  };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function showCompletedWorkflowBoard(sessionId: string, outputDirectory: string): Promise<void> {
  await updateWorkflowBoard({
    stage: "完成阶段",
    todos: createStepItemsForLifecycle("完成阶段", "verified"),
    artifacts: createArtifactItemsForStage("完成阶段", "verified"),
    narrative: "全部阶段已完成。",
    sessionId,
    outputDirectory,
    runtimeStatus: {
      phase: "complete",
      effort: undefined,
    },
  });
}

async function collectPersistedPlanValidation(runtime: TextGeneratorRuntime): Promise<{
  reasons: string[];
  planSpec: PlanSpec | null;
}> {
  await reconcileHostManagedArtifacts(runtime, [
    runtime.deepagentsAnalysisPath,
    runtime.deepagentsDetailedSpecPath,
    runtime.deepagentsPlanSpecPath,
  ]);

  const reasons: string[] = [];

  const analysisContents = await readIfExists(runtime.deepagentsAnalysisPath);
  if (!analysisContents || analysisContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.analysis 尚未落盘有效内容。");
  }

  const detailedSpecContents = await readIfExists(runtime.deepagentsDetailedSpecPath);
  if (!detailedSpecContents || detailedSpecContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.generatedSpec 尚未落盘有效内容。");
  }

  let planSpec: PlanSpec | null = null;
  const planSpecContents = await readIfExists(runtime.deepagentsPlanSpecPath);
  if (!planSpecContents || planSpecContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.planSpec 尚未落盘有效内容。");
  } else {
    try {
      const parsed = JSON.parse(planSpecContents);
      const validation = validatePlanSpec(parsed);
      if (!validation.success) {
        reasons.push(...validation.issues.map((issue) => `计划阶段未完成：artifacts.planSpec 校验失败：${issue}`));
      } else {
        planSpec = await normalizePersistedPlanSpec(runtime, validation.data);
        reasons.push(...collectPlanSpecConsistencyIssues(planSpec).map(
          (issue) => `计划阶段未完成：artifacts.planSpec 一致性校验失败：${issue}`,
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reasons.push(`计划阶段未完成：artifacts.planSpec 不是合法 JSON：${message}`);
    }
  }

  return {
    reasons,
    planSpec,
  };
}

async function validatePlanArtifacts(runtime: TextGeneratorRuntime, result: PlanResult): Promise<{
  reasons: string[];
  planSpec: PlanSpec | null;
}> {
  const validation = await collectPersistedPlanValidation(runtime);
  const reasons = [...validation.reasons];
  const { planSpec } = validation;

  if (result.planSpecVersion !== 1) {
    reasons.push(`计划阶段未完成：结构化结果返回了不支持的 planSpecVersion=${result.planSpecVersion}。`);
  }

  if (result.artifactsWritten.length === 0) {
    reasons.push("计划阶段未完成：结构化结果中的 artifactsWritten 为空，说明本轮没有明确报告计划产物。");
  }

  await writePlanValidationResult(runtime.deepagentsPlanValidationPath, {
    valid: reasons.length === 0,
    reasons,
    ...(planSpec ? { planSpecVersion: planSpec.version } : {}),
  });

  return {
    reasons,
    planSpec,
  };
}

function getRuntimeValidationForRuntime(runtime: TextGeneratorRuntime): TemplateRuntimeValidation {
  return runtime.templateRuntimeValidation ?? defaultTemplateRuntimeValidation();
}

function createRuntimeWithoutDevServerValidation(runtime: TextGeneratorRuntime): TextGeneratorRuntime {
  const runtimeValidation = getRuntimeValidationForRuntime(runtime);
  return {
    ...runtime,
    templateRuntimeValidation: {
      ...runtimeValidation,
      steps: runtimeValidation.steps.filter((step) => step.kind !== "dev-server"),
    },
  };
}

function createSkippedDevServerValidationSteps(runtime: TextGeneratorRuntime): GenerationValidationStep[] {
  return getRuntimeValidationForRuntime(runtime)
    .steps
    .filter((step) => step.kind === "dev-server")
    .map((step) => ({
      name: step.name,
      ok: true,
      detail: "已跳过：当前 runtime_validation 阶段复用同一个交互式 dev server/proxy 会话，不再单独启动 dev server。",
    }));
}

async function collectPersistedGeneratedValidation(
  outputDirectory: string,
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
  validator: GeneratedAppValidator,
  options: { skipRuntimeDevServerSteps?: boolean } = {},
): Promise<{ reasons: string[]; steps: GenerationValidationStep[] }> {
  await reconcileHostManagedArtifacts(runtime, [path.join(outputDirectory, "app-builder-report.md")]);

  const reasons: string[] = [];
  const reportPath = path.join(outputDirectory, "app-builder-report.md");
  const reportContents = await readIfExists(reportPath);
  if (!reportContents || reportContents.trim().length === 0) {
    reasons.push("生成阶段未完成：app-builder-report.md 尚未落盘。");
  }

  const coverage = await collectGeneratedCoverage(outputDirectory, planSpec);
  await appendIndirectResourceCoverageNotice(coverage.indirectResources);
  const missingAcceptanceChecks = collectMissingDeliveryAcceptanceChecks(planSpec, coverage);
  const environmentIssues = await collectEnvironmentVariableIssues(outputDirectory, planSpec);

  if (coverage.missingApiPaths.length > 0) {
    reasons.push(`生成阶段未完成：以下接口尚未落盘：${coverage.missingApiPaths.join(", ")}。`);
  }

  if (coverage.missingPageRoutes.length > 0) {
    reasons.push(`生成阶段未完成：以下页面尚未落盘：${coverage.missingPageRoutes.join(", ")}。`);
  }

  if (missingAcceptanceChecks.length > 0) {
    reasons.push(`生成阶段未完成：以下验收项对应的页面或接口尚未满足：${missingAcceptanceChecks.join(", ")}。`);
  }
  reasons.push(...environmentIssues);

  let steps: GenerationValidationStep[] = [];
  if (reasons.length === 0) {
    const validationRuntime = options.skipRuntimeDevServerSteps
      ? createRuntimeWithoutDevServerValidation(runtime)
      : runtime;
    const runtimeValidation = await validator.validate(outputDirectory, validationRuntime);
    reasons.push(...runtimeValidation.reasons);
    steps = options.skipRuntimeDevServerSteps
      ? [
          ...runtimeValidation.steps,
          ...createSkippedDevServerValidationSteps(runtime),
        ]
      : runtimeValidation.steps;
    if (options.skipRuntimeDevServerSteps) {
      await appendRuntimeValidationLog(runtime.deepagentsRuntimeValidationLogPath, [
        "[skip] dev-server validation steps are owned by the active interactive runtime validation session.",
        "",
      ]);
    }
  } else {
    await fs.writeFile(
      runtime.deepagentsRuntimeValidationLogPath,
      "未执行运行命令验证：宿主落盘文件校验尚未通过。\n",
      "utf8",
    );
  }

  return {
    reasons,
    steps,
  };
}

async function validateGeneratedArtifacts(
  outputDirectory: string,
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
  result: GeneratedProject,
  validator: GeneratedAppValidator,
  options: { skipRuntimeDevServerSteps?: boolean } = {},
): Promise<{ reasons: string[]; steps: GenerationValidationStep[] }> {
  await reconcileHostManagedArtifacts(runtime, [path.join(outputDirectory, "app-builder-report.md")]);

  const reasons: string[] = [];
  const nonPlanningFiles = result.filesWritten.filter((file) => !file.startsWith(".deepagents/"));

  if (result.filesWritten.length === 0) {
    reasons.push("生成阶段未完成：结构化结果中的 filesWritten 为空，说明本轮没有明确报告已落盘文件。");
  } else if (nonPlanningFiles.length === 0) {
    reasons.push("生成阶段未完成：本轮只报告了计划阶段 artifacts，没有报告任何应用源码或交付文件。");
  }

  const reportPath = path.join(outputDirectory, "app-builder-report.md");
  const reportContents = await readIfExists(reportPath);
  if (nonPlanningFiles.length > 0 && (!reportContents || reportContents.trim().length === 0)) {
    reasons.push("生成阶段未完成：app-builder-report.md 尚未落盘。");
  }

  const coverage = await collectGeneratedCoverage(outputDirectory, planSpec);
  await appendIndirectResourceCoverageNotice(coverage.indirectResources);
  const missingAcceptanceChecks = collectMissingDeliveryAcceptanceChecks(planSpec, coverage);
  const environmentIssues = await collectEnvironmentVariableIssues(outputDirectory, planSpec);
  if (coverage.missingPageRoutes.length > 0) {
    reasons.push(`生成阶段未完成：以下页面尚未落盘：${coverage.missingPageRoutes.join(", ")}。`);
  }
  if (coverage.missingApiPaths.length > 0) {
    reasons.push(`生成阶段未完成：以下接口尚未落盘：${coverage.missingApiPaths.join(", ")}。`);
  }
  if (missingAcceptanceChecks.length > 0) {
    reasons.push(`生成阶段未完成：以下验收项对应的页面或接口尚未满足：${missingAcceptanceChecks.join(", ")}。`);
  }
  reasons.push(...environmentIssues);

  let steps: GenerationValidationStep[] = [];
  if (reasons.length === 0) {
    const validationRuntime = options.skipRuntimeDevServerSteps
      ? createRuntimeWithoutDevServerValidation(runtime)
      : runtime;
    const runtimeValidation = await validator.validate(outputDirectory, validationRuntime);
    reasons.push(...runtimeValidation.reasons);
    steps = options.skipRuntimeDevServerSteps
      ? [
          ...runtimeValidation.steps,
          ...createSkippedDevServerValidationSteps(runtime),
        ]
      : runtimeValidation.steps;
    if (options.skipRuntimeDevServerSteps) {
      await appendRuntimeValidationLog(runtime.deepagentsRuntimeValidationLogPath, [
        "[skip] dev-server validation steps are owned by the active interactive runtime validation session.",
        "",
      ]);
    }
  } else {
    await fs.writeFile(
      runtime.deepagentsRuntimeValidationLogPath,
      "未执行运行命令验证：宿主结构化交付物校验尚未通过。\n",
      "utf8",
    );
  }

  await writeGenerationValidationResult(runtime.deepagentsGenerationValidationPath, {
    valid: reasons.length === 0,
    reasons,
    steps,
  });

  return { reasons, steps };
}

async function appendRetryNote(logPath: string, attempt: number, stage: RetryStage, reasons: string[]): Promise<void> {
  const lines = [
    `[${new Date().toISOString()}]`,
    `Retry attempt ${attempt} triggered for ${stage} because:`,
    ...reasons.map((reason) => `- ${reason}`),
    "",
  ];
  await fs.appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
}

async function appendValidationFailureDetails(reasons: string[]): Promise<void> {
  for (const [index, reason] of reasons.entries()) {
    await appendWorkflowLog(`[host] 待修复错误 ${index + 1}/${reasons.length}: ${reason}`);
  }
}

function extractValidationDetailLines(detail: string, maxLines = 6): string[] {
  return detail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, maxLines);
}

function normalizeValidationDetailText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function filterRedundantValidationDetailLines(
  detail: string,
  reasons: string[],
  maxLines = 6,
): string[] {
  const detailLines = extractValidationDetailLines(detail, maxLines);
  if (detailLines.length === 0 || reasons.length === 0) {
    return detailLines;
  }

  const normalizedReasons = reasons.map((reason) => normalizeValidationDetailText(reason));
  return detailLines.filter((line) => {
    const normalizedLine = normalizeValidationDetailText(line);
    return !normalizedReasons.some((reason) => reason.includes(normalizedLine));
  });
}

async function appendGenerationValidationStepDetails(
  steps: GenerationValidationStep[],
  reasons: string[] = [],
): Promise<void> {
  const failedSteps = steps.filter((step) => !step.ok);

  for (const [index, step] of failedSteps.entries()) {
    await appendWorkflowLog(`[host] 待修复验证步骤 ${index + 1}/${failedSteps.length}: ${step.name} 未通过。`);

    const detailLines = filterRedundantValidationDetailLines(step.detail, reasons);
    for (const [detailIndex, line] of detailLines.entries()) {
      await appendWorkflowLog(
        `[host] 待修复验证内容 ${step.name} ${detailIndex + 1}/${detailLines.length}: ${line}`,
      );
    }
  }
}

async function collectGeneratedFiles(outputDirectory: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      const relativePath = path.relative(outputDirectory, absolutePath).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (relativePath === ".deepagents" || relativePath === ".git") {
          continue;
        }
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (relativePath === "template-lock.json") {
        continue;
      }

      files.push(relativePath);
    }
  }

  await visit(outputDirectory);
  return files.sort();
}

async function resolveSessionIdForLookup(sessionId: string, cwd = process.cwd()): Promise<string> {
  const sessionsRoot = path.resolve(cwd, ".out");
  const exactOutputDirectory = path.join(sessionsRoot, sessionId);

  if (await pathExists(exactOutputDirectory)) {
    return sessionId;
  }

  let entries: string[] = [];
  try {
    entries = await fs.readdir(sessionsRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw new Error(`Session "${sessionId}" was not found under ${sessionsRoot}.`);
    }
    throw error;
  }

  const matches = entries
    .filter((entry) => entry.startsWith(sessionId))
    .sort();

  if (matches.length === 0) {
    throw new Error(`Session "${sessionId}" was not found under ${sessionsRoot}.`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Session id "${sessionId}" is ambiguous under ${sessionsRoot}. Matches: ${matches.join(", ")}.`,
    );
  }

  return matches[0] ?? sessionId;
}

async function createRuntimeForSession(sessionId: string, cwd = process.cwd()): Promise<TextGeneratorRuntime> {
  const resolvedSessionId = await resolveSessionIdForLookup(sessionId, cwd);
  const outputDirectory = path.resolve(cwd, ".out", resolvedSessionId);
  const deepagentsDirectory = path.join(outputDirectory, ".deepagents");
  const configPath = path.join(deepagentsDirectory, "config.json");

  if (!await pathExists(deepagentsDirectory)) {
    throw new Error(`Session "${resolvedSessionId}" is missing the .deepagents workspace.`);
  }

  let templateId = "unknown";
  let templateName = "unknown";
  let templateVersion = "unknown";
  let templateRepairRetries = defaultTemplateRepairRetries();
  let templatePhases: TemplatePhaseMap = {
    plan: {},
    planRepair: {},
    generate: {},
    generateRepair: {},
  };
  let templateRuntimeValidation = defaultTemplateRuntimeValidation();
  let templateInteractiveRuntimeValidation = defaultTemplateInteractiveRuntimeValidation();
  let persistedModelName: string | undefined;
  let persistedModelRoles: Partial<SanitizedModelRoleConfigMap> = {};

  const configContents = await readIfExists(configPath);
  if (configContents) {
    try {
      const parsed = JSON.parse(configContents) as {
        model?: unknown;
        models?: unknown;
        template?: {
          id?: unknown;
          name?: unknown;
          version?: unknown;
          repairRetries?: unknown;
          phases?: unknown;
          runtimeValidation?: unknown;
          interactiveRuntimeValidation?: unknown;
        };
      };
      if (typeof parsed.model === "string" && parsed.model.trim() !== "") {
        persistedModelName = parsed.model.trim();
      }
      persistedModelRoles = parseSanitizedModelRoleConfigs(parsed.models);
      if (typeof parsed.template?.id === "string" && parsed.template.id.trim() !== "") {
        templateId = parsed.template.id;
      }
      if (typeof parsed.template?.name === "string" && parsed.template.name.trim() !== "") {
        templateName = parsed.template.name;
      }
      if (typeof parsed.template?.version === "string" && parsed.template.version.trim() !== "") {
        templateVersion = parsed.template.version;
      }
      if (parsed.template?.repairRetries && typeof parsed.template.repairRetries === "object") {
        const repairRetriesCandidate = parsed.template.repairRetries as Partial<TemplateRepairRetries>;
        if (
          Number.isInteger(repairRetriesCandidate.plan) &&
          Number(repairRetriesCandidate.plan) >= 0 &&
          Number.isInteger(repairRetriesCandidate.generate) &&
          Number(repairRetriesCandidate.generate) >= 0
        ) {
          templateRepairRetries = {
            plan: Number(repairRetriesCandidate.plan),
            generate: Number(repairRetriesCandidate.generate),
          };
        }
      }
      if (parsed.template?.phases && typeof parsed.template.phases === "object") {
        const phasesCandidate = parsed.template.phases as Record<string, unknown>;
        const parsePhaseEffort = (value: unknown): { effort?: "low" | "medium" | "high" } => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return {};
          }

          const candidate = value as { effort?: unknown };
          if (candidate.effort === "low" || candidate.effort === "medium" || candidate.effort === "high") {
            return { effort: candidate.effort };
          }

          return {};
        };

        templatePhases = {
          plan: parsePhaseEffort(phasesCandidate.plan),
          planRepair: parsePhaseEffort(phasesCandidate.planRepair),
          generate: parsePhaseEffort(phasesCandidate.generate),
          generateRepair: parsePhaseEffort(phasesCandidate.generateRepair),
        };
      }
      if (parsed.template?.runtimeValidation && typeof parsed.template.runtimeValidation === "object") {
        const runtimeValidationCandidate = parsed.template.runtimeValidation as Partial<TemplateRuntimeValidation>;
        if (Array.isArray(runtimeValidationCandidate.steps)) {
          const steps = runtimeValidationCandidate.steps.flatMap((step): TemplateRuntimeValidationStep[] => {
            if (!step || typeof step !== "object") {
              return [];
            }

            const candidate = step as Partial<TemplateRuntimeValidationStep>;
            if (
              typeof candidate.name !== "string" ||
              typeof candidate.command !== "string" ||
              !Array.isArray(candidate.args) ||
              candidate.args.some((arg) => typeof arg !== "string")
            ) {
              return [];
            }

            const nextStep: TemplateRuntimeValidationStep = {
              name: candidate.name,
              command: candidate.command,
              args: candidate.args,
            };
            if (candidate.kind === "command" || candidate.kind === "dev-server") {
              nextStep.kind = candidate.kind;
            }
            if (candidate.env && typeof candidate.env === "object" && !Array.isArray(candidate.env)) {
              const envEntries = Object.entries(candidate.env).filter((entry): entry is [string, string] => (
                typeof entry[1] === "string"
              ));
              if (envEntries.length > 0) {
                nextStep.env = Object.fromEntries(envEntries);
              }
            }
            return [nextStep];
          });

          if (steps.length > 0) {
            templateRuntimeValidation = {
              copyEnvExample:
                typeof runtimeValidationCandidate.copyEnvExample === "boolean"
                  ? runtimeValidationCandidate.copyEnvExample
                  : true,
              steps,
            };
          }
        }
      }
      if (
        parsed.template?.interactiveRuntimeValidation &&
        typeof parsed.template.interactiveRuntimeValidation === "object" &&
        !Array.isArray(parsed.template.interactiveRuntimeValidation)
      ) {
        const candidate = parsed.template.interactiveRuntimeValidation as Partial<TemplateInteractiveRuntimeValidation>;
        const devServerStepCandidate = candidate.devServerStep;
        let devServerStep: TemplateRuntimeValidationStep | undefined;
        if (
          devServerStepCandidate &&
          typeof devServerStepCandidate === "object" &&
          typeof devServerStepCandidate.name === "string" &&
          typeof devServerStepCandidate.command === "string" &&
          Array.isArray(devServerStepCandidate.args) &&
          devServerStepCandidate.args.every((arg) => typeof arg === "string")
        ) {
          devServerStep = {
            name: devServerStepCandidate.name,
            command: devServerStepCandidate.command,
            args: devServerStepCandidate.args,
            ...(devServerStepCandidate.kind === "command" || devServerStepCandidate.kind === "dev-server"
              ? { kind: devServerStepCandidate.kind }
              : {}),
            ...(devServerStepCandidate.env && typeof devServerStepCandidate.env === "object" && !Array.isArray(devServerStepCandidate.env)
              ? {
                  env: Object.fromEntries(
                    Object.entries(devServerStepCandidate.env)
                      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
                  ),
                }
              : {}),
          };
        }

        templateInteractiveRuntimeValidation = {
          enabled: candidate.enabled === true,
          coverageThreshold:
            typeof candidate.coverageThreshold === "number" &&
            Number.isFinite(candidate.coverageThreshold) &&
            candidate.coverageThreshold >= 0 &&
            candidate.coverageThreshold <= 1
              ? candidate.coverageThreshold
              : 0.8,
          idleTimeoutMs:
            Number.isInteger(candidate.idleTimeoutMs) && Number(candidate.idleTimeoutMs) > 0
              ? Number(candidate.idleTimeoutMs)
              : 10_000,
          readyTimeoutMs:
            Number.isInteger(candidate.readyTimeoutMs) && Number(candidate.readyTimeoutMs) > 0
              ? Number(candidate.readyTimeoutMs)
              : 90_000,
          ...(devServerStep ? { devServerStep } : {}),
        };
      }
    } catch {
      // Ignore malformed config here; phase validation will report durable artifact failures separately.
    }
  }

  const modelRoles = resolveModelRoleConfigs(process.env, {
    persisted: persistedModelRoles,
    fallbackModelName: persistedModelName,
    requireApiKeys: false,
  });

  return {
    sessionId: resolvedSessionId,
    outputDirectory,
    deepagentsDirectory,
    deepagentsAgentsPath: path.join(deepagentsDirectory, "AGENTS.md"),
    deepagentsLogPath: path.join(deepagentsDirectory, "trace.log"),
    deepagentsErrorLogPath: path.join(deepagentsDirectory, "error.log"),
    deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
    deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
    deepagentsConfigPath: configPath,
    deepagentsPlanPromptSnapshotPath: path.join(deepagentsDirectory, "plan-system-prompt.md"),
    deepagentsPlanRepairPromptSnapshotPath: path.join(deepagentsDirectory, "plan-repair-system-prompt.md"),
    deepagentsGeneratePromptSnapshotPath: path.join(deepagentsDirectory, "generate-system-prompt.md"),
    deepagentsGenerateRepairPromptSnapshotPath: path.join(deepagentsDirectory, "generate-repair-system-prompt.md"),
    templateId,
    templateName,
    templateVersion,
    templateDirectory: deepagentsDirectory,
    templatePlanPromptPath: path.join(deepagentsDirectory, "plan-system-prompt.md"),
    templatePlanRepairPromptPath: path.join(deepagentsDirectory, "plan-repair-system-prompt.md"),
    templateGeneratePromptPath: path.join(deepagentsDirectory, "generate-system-prompt.md"),
    templateGenerateRepairPromptPath: path.join(deepagentsDirectory, "generate-repair-system-prompt.md"),
    sourcePrdSnapshotPath: path.join(deepagentsDirectory, "source-prd.md"),
    deepagentsAnalysisPath: path.join(deepagentsDirectory, "prd-analysis.md"),
    deepagentsDetailedSpecPath: path.join(deepagentsDirectory, "generated-spec.md"),
    deepagentsPlanSpecPath: path.join(deepagentsDirectory, "plan-spec.json"),
    deepagentsPlanValidationPath: path.join(deepagentsDirectory, "plan-validation.json"),
    deepagentsGenerationValidationPath: path.join(deepagentsDirectory, "generation-validation.json"),
    maxPlanRetries: templateRepairRetries.plan,
    maxGenerateRetries: templateRepairRetries.generate,
    templatePhases,
    templateRuntimeValidation,
    templateInteractiveRuntimeValidation,
    modelRoles,
  };
}

function requireSessionGenerator(runtime: TextGeneratorRuntime, generator?: TextGenerator): TextGenerator {
  if (generator) {
    return generator;
  }

  validateModelRoleApiKeys(runtime.modelRoles);

  return new DeepAgentsTextGenerator({ modelRoles: runtime.modelRoles });
}

function createSessionRuntime(
  runtime: TextGeneratorRuntime,
  overrides: Partial<TextGeneratorRuntime> = {},
): TextGeneratorRuntime {
  return {
    ...runtime,
    ...overrides,
  };
}

async function countRetryAttempts(logPath: string, stage: RetryStage): Promise<number> {
  const contents = await readIfExists(logPath);
  if (!contents) {
    return 0;
  }

  return contents
    .split(/\r?\n/)
    .filter((line) => line.includes(`triggered for ${stage}`))
    .length;
}

function formatRuntimeInteractionRequestLines(artifact: RuntimeInteractionValidationArtifact): string[] {
  return artifact.recentRequests.slice(-4).map((requestRecord) => {
    const status = requestRecord.status === undefined ? "ERR" : String(requestRecord.status);
    const target = requestRecord.targetLabel ? ` ${requestRecord.targetLabel}` : "";
    return `${requestRecord.method} ${requestRecord.path} -> ${status}${target}`;
  });
}

async function updateRuntimeValidationWorkflowBoard(options: {
  runtime: TextGeneratorRuntime;
  artifact?: RuntimeInteractionValidationArtifact;
  narrative: string;
  lifecycle: "generating" | "validating" | "verified";
}): Promise<void> {
  const runtimeInteraction = options.artifact
    ? {
        ...(options.artifact.devServerUrl ? { devServerUrl: options.artifact.devServerUrl } : {}),
        ...(options.artifact.browserOpenAttempted !== undefined
          ? { browserOpenAttempted: options.artifact.browserOpenAttempted }
          : {}),
        ...(options.artifact.browserOpened !== undefined ? { browserOpened: options.artifact.browserOpened } : {}),
        ...(options.artifact.browserOpenError ? { browserOpenError: options.artifact.browserOpenError } : {}),
        ...(options.artifact.proxyUrl ? { proxyUrl: options.artifact.proxyUrl } : {}),
        ...(options.artifact.validationUrl ? { validationUrl: options.artifact.validationUrl } : {}),
        ...(options.artifact.manualCompleted ? { manualCompleted: true } : {}),
        ...(options.artifact.devServerOutputSummary ? { devServerOutputSummary: options.artifact.devServerOutputSummary } : {}),
        ...(options.artifact.recentRequests.length > 0
          ? {
              coverageRatio: options.artifact.coverage.ratio,
              coveredTargets: options.artifact.coverage.coveredTargets,
              uncoveredTargets: options.artifact.coverage.uncoveredTargets,
              recentRequests: formatRuntimeInteractionRequestLines(options.artifact),
            }
          : {}),
        ...(options.artifact.recentDevServerOutput ? { recentDevServerOutput: options.artifact.recentDevServerOutput } : {}),
      }
    : undefined;

  await updateWorkflowBoard({
    stage: "运行验证阶段",
    todos: createStepItemsForLifecycle("运行验证阶段", options.lifecycle),
    artifacts: createArtifactItemsForStage("运行验证阶段", options.lifecycle),
    narrative: options.narrative,
    sessionId: options.runtime.sessionId,
    outputDirectory: options.runtime.outputDirectory,
    runtimeStatus: {
      phase: "runtime_validation",
      effort: undefined,
    },
    ...(runtimeInteraction ? { runtimeInteraction } : {}),
  });
}

async function markWorkflowComplete(runtime: TextGeneratorRuntime, completedPhases: Array<"plan" | "generate" | "runtime_validation">): Promise<void> {
  await updateWorkflowState(runtime.deepagentsConfigPath, "complete", completedPhases);
  await showCompletedWorkflowBoard(runtime.sessionId, runtime.outputDirectory);
  await appendWorkflowLog("[host] 全部阶段完成，准备汇总输出。");
}

async function completeAfterGenerateValidation(options: {
  runtime: TextGeneratorRuntime;
  generator: TextGenerator;
  validator: GeneratedAppValidator;
  approvedPlan: PlanSpec;
}): Promise<void> {
  if (!options.runtime.templateInteractiveRuntimeValidation.enabled) {
    await markWorkflowComplete(options.runtime, ["plan", "generate"]);
    return;
  }

  let retryReasons: string[] = [];
  const maxGenerationRepairs = options.runtime.maxGenerateRetries ?? 0;
  const runtimeInteractionSession: RuntimeInteractionValidationSession = {};

  try {
    while (true) {
      if (retryReasons.length === 0) {
        await updateWorkflowState(options.runtime.deepagentsConfigPath, "runtime_validation", ["plan", "generate"]);
        await appendWorkflowLog("[host] 进入运行验证阶段，启动或复用 dev server，并启动本地请求代理，合并监听 HTTP 响应与 stdout/stderr。");
        await updateRuntimeValidationWorkflowBoard({
          runtime: options.runtime,
          narrative: "正在启动交互式运行验证。",
          lifecycle: "generating",
        });

        const validation = await runInteractiveRuntimeValidation({
          runtime: options.runtime,
          planSpec: options.approvedPlan,
          config: options.runtime.templateInteractiveRuntimeValidation,
          session: runtimeInteractionSession,
          onReady: async ({ proxyUrl, validationUrl, devServerUrl, browserOpened, browserOpenReused, browserOpenError }) => {
            const visitUrl = validationUrl ?? proxyUrl ?? devServerUrl;
            if (browserOpenReused && browserOpened) {
              await appendWorkflowLog(`[host] 继续使用已打开的运行验证地址：${visitUrl}`);
              return;
            }
            if (browserOpenReused) {
              if (browserOpenError) {
                await appendWorkflowLog(`[host] 保留上次默认浏览器打开失败结果，不重复启动浏览器：${browserOpenError}`);
              }
              await appendWorkflowLog(`[host] 请继续使用运行验证地址：${visitUrl}`);
              return;
            }
            if (browserOpened) {
              await appendWorkflowLog(`[host] 已使用默认浏览器打开运行验证地址：${visitUrl}`);
              return;
            }
            if (browserOpenError) {
              await appendWorkflowLog(`[host] 默认浏览器打开失败：${browserOpenError}`);
            }
            await appendWorkflowLog(`[host] 请在浏览器访问运行验证地址：${visitUrl}`);
          },
          onUpdate: async (update) => {
            const recentRequests = update.recentRequests.slice(-4).map((requestRecord) => {
              const status = requestRecord.status === undefined ? "ERR" : String(requestRecord.status);
              const target = requestRecord.targetLabel ? ` ${requestRecord.targetLabel}` : "";
              const source = requestRecord.source === "proxy" ? "proxy " : "";
              const error = requestRecord.errorSummary ? ` ${requestRecord.errorSummary}` : "";
              return `${source}${requestRecord.method} ${requestRecord.rawPath ?? requestRecord.path} -> ${status}${target}${error}`;
            });
            await updateWorkflowBoard({
              stage: "运行验证阶段",
              todos: createStepItemsForLifecycle("运行验证阶段", "validating"),
              artifacts: createArtifactItemsForStage("运行验证阶段", "validating"),
              narrative: "正在监听代理请求、HTTP 响应和 dev server 输出，并等待静默窗口。",
              sessionId: options.runtime.sessionId,
              outputDirectory: options.runtime.outputDirectory,
              runtimeStatus: {
                phase: "runtime_validation",
                effort: undefined,
              },
              runtimeInteraction: {
                devServerUrl: update.devServerUrl,
                ...(update.browserOpenAttempted !== undefined
                  ? { browserOpenAttempted: update.browserOpenAttempted }
                  : {}),
                ...(update.browserOpened !== undefined ? { browserOpened: update.browserOpened } : {}),
                ...(update.browserOpenError ? { browserOpenError: update.browserOpenError } : {}),
                ...(update.proxyUrl ? { proxyUrl: update.proxyUrl } : {}),
                ...(update.validationUrl ? { validationUrl: update.validationUrl } : {}),
                ...(recentRequests.length > 0
                  ? {
                      coverageRatio: update.coverage.ratio,
                      coveredTargets: update.coverage.coveredTargets,
                      uncoveredTargets: update.coverage.uncoveredTargets,
                      recentRequests,
                    }
                  : {}),
                recentDevServerOutput: update.recentDevServerOutput,
              },
            });
          },
        });

        if (validation.reasons.length === 0) {
          await appendWorkflowLog("[host] 运行验证阶段通过。");
          await updateRuntimeValidationWorkflowBoard({
            runtime: options.runtime,
            artifact: validation.artifact,
            narrative: "运行验证阶段已通过。",
            lifecycle: "verified",
          });
          await markWorkflowComplete(options.runtime, ["plan", "generate", "runtime_validation"]);
          return;
        }

        retryReasons = validation.reasons;
        await appendWorkflowLog(`[host] 运行验证阶段失败，待修复问题 ${retryReasons.length} 条。`);
        await appendValidationFailureDetails(retryReasons);
        await appendGenerationValidationStepDetails(validation.steps, retryReasons);
        await updateRuntimeValidationWorkflowBoard({
          runtime: options.runtime,
          artifact: validation.artifact,
          narrative: "运行验证阶段失败，准备调用生成修复。",
          lifecycle: "validating",
        });
      }

      const existingRepairAttempts = await countRetryAttempts(options.runtime.deepagentsErrorLogPath, "生成修复阶段");
      if (existingRepairAttempts >= maxGenerationRepairs) {
        throw new Error(`Runtime interaction validation failed: ${retryReasons.join(" | ")}`);
      }

      await updateWorkflowState(options.runtime.deepagentsConfigPath, "runtime_validation", ["plan", "generate"]);
      await appendRetryNote(
        options.runtime.deepagentsErrorLogPath,
        existingRepairAttempts + 1,
        "生成修复阶段",
        retryReasons,
      );
      await appendWorkflowLog(`[host] 运行验证触发生成修复轮次 ${existingRepairAttempts + 1}。`);

      const repairRuntime = createSessionRuntime(options.runtime, {
        generateAttempt: existingRepairAttempts + 2,
        retryReasons,
      });
      let repairedProject: GeneratedProject;
      try {
        repairedProject = await options.generator.generateRepairProject(options.approvedPlan, repairRuntime);
      } catch (error) {
        const recovered = await synthesizeRecoveredGeneratedResult(repairRuntime, options.approvedPlan, error);
        if (!recovered) {
          throw error;
        }
        repairedProject = recovered;
      }

      await appendWorkflowLog("[host] 运行验证修复输出完成，重新执行生成门禁。");
      await updateWorkflowBoard({
        stage: "生成阶段",
        todos: createStepItemsForLifecycle("生成阶段", "validating"),
        artifacts: createArtifactItemsForStage("生成阶段", "validating"),
        narrative: "正在复核运行验证修复后的生成交付物。",
        sessionId: options.runtime.sessionId,
        outputDirectory: options.runtime.outputDirectory,
      });
      const generationValidation = await validateGeneratedArtifacts(
        options.runtime.outputDirectory,
        repairRuntime,
        options.approvedPlan,
        repairedProject,
        options.validator,
        { skipRuntimeDevServerSteps: true },
      );

      if (generationValidation.reasons.length === 0) {
        await appendWorkflowLog("[host] 运行验证修复后的生成门禁通过，继续交互式监听。");
        retryReasons = [];
        continue;
      }

      retryReasons = generationValidation.reasons;
      await appendWorkflowLog(
        `[host] 运行验证修复后的生成门禁仍未通过，剩余问题 ${generationValidation.reasons.length} 条。`,
      );
      await appendValidationFailureDetails(generationValidation.reasons);
      await appendGenerationValidationStepDetails(generationValidation.steps, generationValidation.reasons);
    }
  } finally {
    await closeRuntimeInteractionValidationSession(runtimeInteractionSession);
  }
}

async function continueGenerateFlow(options: {
  runtime: TextGeneratorRuntime;
  generator: TextGenerator;
  validator: GeneratedAppValidator;
  approvedPlan: PlanSpec;
  initialRetryReasons: string[];
}): Promise<void> {
  let generationRetryReasons = [...options.initialRetryReasons];
  const maxGenerationRepairs = options.runtime.maxGenerateRetries ?? 0;

  if (generationRetryReasons.length === 0) {
    await updateWorkflowState(options.runtime.deepagentsConfigPath, "generate", ["plan"]);

    const initialRuntime = createSessionRuntime(options.runtime, {
      generateAttempt: 1,
      retryReasons: [],
    });
    let generatedProject: GeneratedProject;
    try {
      generatedProject = await options.generator.generateProject(options.approvedPlan, initialRuntime);
    } catch (error) {
      const recovered = await synthesizeRecoveredGeneratedResult(initialRuntime, options.approvedPlan, error);
      if (!recovered) {
        throw error;
      }
      generatedProject = recovered;
    }
    await appendWorkflowLog("[host] 生成阶段流式输出完成，开始宿主校验。");
    await updateWorkflowBoard({
      stage: "生成阶段",
      todos: createStepItemsForLifecycle("生成阶段", "validating"),
      artifacts: createArtifactItemsForStage("生成阶段", "validating"),
      narrative: "正在验证生成阶段交付物。",
      sessionId: options.runtime.sessionId,
      outputDirectory: options.runtime.outputDirectory,
    });
    const validation = await validateGeneratedArtifacts(
      options.runtime.outputDirectory,
      initialRuntime,
      options.approvedPlan,
      generatedProject,
      options.validator,
    );
    if (validation.reasons.length === 0) {
      await appendWorkflowLog("[host] 生成阶段交付物通过校验。");
      await updateWorkflowBoard({
        stage: "生成阶段",
        todos: createStepItemsForLifecycle("生成阶段", "verified"),
        artifacts: createArtifactItemsForStage("生成阶段", "verified"),
        narrative: "生成阶段交付物已验证，全部通过。",
        sessionId: options.runtime.sessionId,
        outputDirectory: options.runtime.outputDirectory,
      });
      await completeAfterGenerateValidation({
        runtime: options.runtime,
        generator: options.generator,
        validator: options.validator,
        approvedPlan: options.approvedPlan,
      });
      return;
    }

    generationRetryReasons = validation.reasons;
    await appendWorkflowLog(`[host] 生成阶段校验失败，待修复问题 ${validation.reasons.length} 条。`);
    await appendValidationFailureDetails(validation.reasons);
    await appendGenerationValidationStepDetails(validation.steps, validation.reasons);
  }

  const existingRepairAttempts = await countRetryAttempts(options.runtime.deepagentsErrorLogPath, "生成修复阶段");

  for (let repairIndex = 0; generationRetryReasons.length > 0 && repairIndex < maxGenerationRepairs; repairIndex += 1) {
    await updateWorkflowState(options.runtime.deepagentsConfigPath, "generate_repair", ["plan"]);
    await appendRetryNote(
      options.runtime.deepagentsErrorLogPath,
      existingRepairAttempts + repairIndex + 1,
      "生成修复阶段",
      generationRetryReasons,
    );
    await appendWorkflowLog(`[host] 启动生成修复轮次 ${existingRepairAttempts + repairIndex + 1}。`);

    const repairRuntime = createSessionRuntime(options.runtime, {
      generateAttempt: existingRepairAttempts + repairIndex + 2,
      retryReasons: generationRetryReasons,
    });
    let repairedProject: GeneratedProject;
    try {
      repairedProject = await options.generator.generateRepairProject(options.approvedPlan, repairRuntime);
    } catch (error) {
      const recovered = await synthesizeRecoveredGeneratedResult(repairRuntime, options.approvedPlan, error);
      if (!recovered) {
        throw error;
      }
      repairedProject = recovered;
    }
    await appendWorkflowLog("[host] 生成修复输出完成，开始复核。");
    await updateWorkflowBoard({
      stage: "生成阶段",
      todos: createStepItemsForLifecycle("生成阶段", "validating"),
      artifacts: createArtifactItemsForStage("生成阶段", "validating"),
      narrative: "正在复核修复后的生成交付物。",
      sessionId: options.runtime.sessionId,
      outputDirectory: options.runtime.outputDirectory,
    });
    const validation = await validateGeneratedArtifacts(
      options.runtime.outputDirectory,
      repairRuntime,
      options.approvedPlan,
      repairedProject,
      options.validator,
    );
    if (validation.reasons.length === 0) {
      await appendWorkflowLog("[host] 修复后的生成交付物通过校验。");
      await updateWorkflowBoard({
        stage: "生成阶段",
        todos: createStepItemsForLifecycle("生成阶段", "verified"),
        artifacts: createArtifactItemsForStage("生成阶段", "verified"),
        narrative: "生成阶段交付物已验证，全部通过。",
        sessionId: options.runtime.sessionId,
        outputDirectory: options.runtime.outputDirectory,
      });
      await completeAfterGenerateValidation({
        runtime: options.runtime,
        generator: options.generator,
        validator: options.validator,
        approvedPlan: options.approvedPlan,
      });
      return;
    }

    generationRetryReasons = validation.reasons;
    await appendWorkflowLog(
      `[host] 生成修复轮次 ${existingRepairAttempts + repairIndex + 1} 仍未通过，剩余问题 ${validation.reasons.length} 条。`,
    );
    await appendValidationFailureDetails(validation.reasons);
    await appendGenerationValidationStepDetails(validation.steps, validation.reasons);
  }

  throw new Error(`Generation validation failed: ${generationRetryReasons.join(" | ")}`);
}

async function continuePlanRepairFlow(options: {
  runtime: TextGeneratorRuntime;
  generator: TextGenerator;
  validator: GeneratedAppValidator;
  initialRetryReasons: string[];
}): Promise<void> {
  let approvedPlan: PlanSpec | null = null;
  let planRetryReasons = [...options.initialRetryReasons];
  const maxPlanRepairs = options.runtime.maxPlanRetries ?? 0;
  const existingRepairAttempts = await countRetryAttempts(options.runtime.deepagentsErrorLogPath, "计划修复阶段");

  for (let repairIndex = 0; !approvedPlan && repairIndex < maxPlanRepairs; repairIndex += 1) {
    await updateWorkflowState(options.runtime.deepagentsConfigPath, "plan_repair", []);
    await appendRetryNote(
      options.runtime.deepagentsErrorLogPath,
      existingRepairAttempts + repairIndex + 1,
      "计划修复阶段",
      planRetryReasons,
    );
    await appendWorkflowLog(`[host] 启动计划修复轮次 ${existingRepairAttempts + repairIndex + 1}。`);

    const repairRuntime = createSessionRuntime(options.runtime, {
      planAttempt: existingRepairAttempts + repairIndex + 2,
      retryReasons: planRetryReasons,
    });
    const repairResult = await options.generator.planRepairProject(repairRuntime);
    await appendWorkflowLog("[host] 计划修复输出完成，开始复核。");
    await updateWorkflowBoard({
      stage: "计划阶段",
      todos: createStepItemsForLifecycle("计划阶段", "validating"),
      artifacts: createArtifactItemsForStage("计划阶段", "validating"),
      narrative: "正在复核修复后的计划产出物。",
      sessionId: options.runtime.sessionId,
      outputDirectory: options.runtime.outputDirectory,
    });
    const validation = await validatePlanArtifacts(repairRuntime, repairResult);
    if (validation.reasons.length === 0) {
      approvedPlan = validation.planSpec;
      await appendWorkflowLog("[host] 修复后的计划阶段产出物通过校验。");
      await updateWorkflowBoard({
        stage: "计划阶段",
        todos: createStepItemsForLifecycle("计划阶段", "verified"),
        artifacts: createArtifactItemsForStage("计划阶段", "verified"),
        narrative: "计划阶段产出物已验证，通过生成门禁。",
        sessionId: options.runtime.sessionId,
        outputDirectory: options.runtime.outputDirectory,
      });
      break;
    }

    planRetryReasons = validation.reasons;
    await appendWorkflowLog(
      `[host] 计划修复轮次 ${existingRepairAttempts + repairIndex + 1} 仍未通过，剩余问题 ${validation.reasons.length} 条。`,
    );
    await appendValidationFailureDetails(validation.reasons);
  }

  if (!approvedPlan) {
    throw new Error(`Plan validation failed: ${planRetryReasons.join(" | ")}`);
  }

  await continueGenerateFlow({
    runtime: options.runtime,
    generator: options.generator,
    validator: options.validator,
    approvedPlan,
    initialRetryReasons: [],
  });
}

export async function validateSessionPhase(options: {
  sessionId: string;
  phase?: ValidationPhase;
  cwd?: string;
  stdoutMode?: StdoutMode;
  generator?: TextGenerator;
  validator?: GeneratedAppValidator;
}): Promise<SessionValidationResult> {
  setWorkflowStdoutMode(options.stdoutMode);
  try {
    const runtime = await createRuntimeForSession(options.sessionId, options.cwd);
    const persistedWorkflowPhase = await readPersistedWorkflowPhase(runtime.deepagentsConfigPath);
    const phase = await resolveValidationPhase(runtime, options.phase);
    const validator = options.validator ?? new ShellGeneratedAppValidator();

    if (phase === "plan") {
      const validation = await collectPersistedPlanValidation(runtime);
      await writePlanValidationResult(runtime.deepagentsPlanValidationPath, {
        valid: validation.reasons.length === 0,
        reasons: validation.reasons,
        ...(validation.planSpec ? { planSpecVersion: validation.planSpec.version } : {}),
      });

      if (validation.reasons.length > 0) {
        const generator = requireSessionGenerator(runtime, options.generator);
        await appendWorkflowLog("[host] validate 检测到计划阶段失败，恢复到计划修复阶段。");
        try {
          await continuePlanRepairFlow({
            runtime,
            generator,
            validator,
            initialRetryReasons: validation.reasons,
          });
        } finally {
          await closeWorkflowBoard();
        }

        return {
          sessionId: runtime.sessionId,
          phase,
          outputDirectory: runtime.outputDirectory,
          valid: true,
          reasons: [],
          steps: [],
          validationPath: runtime.deepagentsPlanValidationPath,
          runtimeValidationLogPath: runtime.deepagentsRuntimeValidationLogPath,
          runtimeInteractionValidationPath: runtime.deepagentsRuntimeInteractionValidationPath,
          workflowPhase: "complete",
          resumedFromPhase: "plan_repair",
        };
      }

      return {
        sessionId: runtime.sessionId,
        phase,
        outputDirectory: runtime.outputDirectory,
        valid: true,
        reasons: [],
        steps: [],
        validationPath: runtime.deepagentsPlanValidationPath,
        runtimeValidationLogPath: runtime.deepagentsRuntimeValidationLogPath,
        runtimeInteractionValidationPath: runtime.deepagentsRuntimeInteractionValidationPath,
        workflowPhase: "plan",
      };
    }

    const planValidation = await collectPersistedPlanValidation(runtime);
    const reasons = [...planValidation.reasons];
    let steps: GenerationValidationStep[] = [];

    if (!planValidation.planSpec) {
      reasons.push("生成阶段校验前置失败：artifacts.planSpec 不可用，无法继续验证生成交付物。");
    }

    if (reasons.length === 0 && planValidation.planSpec) {
      const generationValidation = await collectPersistedGeneratedValidation(
        runtime.outputDirectory,
        runtime,
        planValidation.planSpec,
        validator,
      );
      reasons.push(...generationValidation.reasons);
      steps = generationValidation.steps;
    } else {
      await fs.writeFile(
        runtime.deepagentsRuntimeValidationLogPath,
        "未执行运行命令验证：生成阶段前置计划产物校验未通过。\n",
        "utf8",
      );
    }

    await writeGenerationValidationResult(runtime.deepagentsGenerationValidationPath, {
      valid: reasons.length === 0,
      reasons,
      steps,
    });

    if (reasons.length > 0) {
      const generator = requireSessionGenerator(runtime, options.generator);
      if (!planValidation.planSpec) {
        throw new Error(`Generation validation failed: ${reasons.join(" | ")}`);
      }

      await appendWorkflowLog("[host] validate 检测到生成阶段失败，恢复到生成修复阶段。");
      await appendValidationFailureDetails(reasons);
      await appendGenerationValidationStepDetails(steps, reasons);
      try {
        await continueGenerateFlow({
          runtime,
          generator,
          validator,
          approvedPlan: planValidation.planSpec,
          initialRetryReasons: reasons,
        });
      } finally {
        await closeWorkflowBoard();
      }

      return {
        sessionId: runtime.sessionId,
        phase,
        outputDirectory: runtime.outputDirectory,
        valid: true,
        reasons: [],
        steps: (await readPersistedGenerationValidation(runtime.deepagentsGenerationValidationPath))?.steps ?? steps,
        validationPath: runtime.deepagentsGenerationValidationPath,
        runtimeValidationLogPath: runtime.deepagentsRuntimeValidationLogPath,
        runtimeInteractionValidationPath: runtime.deepagentsRuntimeInteractionValidationPath,
        workflowPhase: "complete",
        resumedFromPhase: "generate_repair",
      };
    }

    if (
      runtime.templateInteractiveRuntimeValidation.enabled &&
      planValidation.planSpec &&
      persistedWorkflowPhase !== "complete"
    ) {
      const generator = requireSessionGenerator(runtime, options.generator);
      try {
        await completeAfterGenerateValidation({
          runtime,
          generator,
          validator,
          approvedPlan: planValidation.planSpec,
        });
      } finally {
        await closeWorkflowBoard();
      }
    } else {
      await updateWorkflowState(runtime.deepagentsConfigPath, "complete", ["plan", "generate"]);
    }

    return {
      sessionId: runtime.sessionId,
      phase,
      outputDirectory: runtime.outputDirectory,
      valid: true,
      reasons: [],
      steps,
      validationPath: runtime.deepagentsGenerationValidationPath,
      runtimeValidationLogPath: runtime.deepagentsRuntimeValidationLogPath,
      runtimeInteractionValidationPath: runtime.deepagentsRuntimeInteractionValidationPath,
      workflowPhase: "complete",
    };
  } finally {
    setWorkflowStdoutMode(undefined);
  }
}

async function summarizeResumedGenerationSession(
  runtime: TextGeneratorRuntime,
  resumedFromPhase?: WorkflowPhase,
): Promise<SessionValidationResult> {
  const generationValidation = await readPersistedGenerationValidation(runtime.deepagentsGenerationValidationPath);
  const workflowPhase = await readPersistedWorkflowPhase(runtime.deepagentsConfigPath) ?? "complete";
  const valid = generationValidation?.valid ?? workflowPhase === "complete";
  const result: SessionValidationResult = {
    sessionId: runtime.sessionId,
    phase: "generate",
    outputDirectory: runtime.outputDirectory,
    valid,
    reasons: generationValidation?.reasons ?? (valid ? [] : [`恢复会话未完成：当前 workflow phase 为 ${workflowPhase}。`]),
    steps: generationValidation?.steps ?? [],
    validationPath: runtime.deepagentsGenerationValidationPath,
    runtimeValidationLogPath: runtime.deepagentsRuntimeValidationLogPath,
    runtimeInteractionValidationPath: runtime.deepagentsRuntimeInteractionValidationPath,
    workflowPhase,
  };

  if (resumedFromPhase) {
    result.resumedFromPhase = resumedFromPhase;
  }

  return result;
}

export async function resumeSession(options: {
  sessionId: string;
  cwd?: string;
  stdoutMode?: StdoutMode;
  generator?: TextGenerator;
  validator?: GeneratedAppValidator;
}): Promise<SessionValidationResult> {
  setWorkflowStdoutMode(options.stdoutMode);
  try {
    const runtime = await createRuntimeForSession(options.sessionId, options.cwd);
    const persistedWorkflowPhase = await readPersistedWorkflowPhase(runtime.deepagentsConfigPath);

    if (persistedWorkflowPhase === "complete") {
      return await summarizeResumedGenerationSession(runtime);
    }

    const phase = await resolveValidationPhase(runtime);
    if (phase === "plan") {
      const validation = await collectPersistedPlanValidation(runtime);
      await writePlanValidationResult(runtime.deepagentsPlanValidationPath, {
        valid: validation.reasons.length === 0,
        reasons: validation.reasons,
        ...(validation.planSpec ? { planSpecVersion: validation.planSpec.version } : {}),
      });

      const generator = requireSessionGenerator(runtime, options.generator);
      const validator = options.validator ?? new ShellGeneratedAppValidator();

      if (validation.reasons.length > 0) {
        await appendWorkflowLog("[host] resume 检测到计划阶段失败，恢复到计划修复阶段。");
        try {
          await continuePlanRepairFlow({
            runtime,
            generator,
            validator,
            initialRetryReasons: validation.reasons,
          });
        } finally {
          await closeWorkflowBoard();
        }

        return await summarizeResumedGenerationSession(runtime, "plan_repair");
      }

      if (!validation.planSpec) {
        throw new Error("Plan validation passed without a usable artifacts.planSpec.");
      }

      await appendWorkflowLog("[host] resume 检测到计划阶段已通过，继续生成阶段。");
      try {
        await continueGenerateFlow({
          runtime,
          generator,
          validator,
          approvedPlan: validation.planSpec,
          initialRetryReasons: [],
        });
      } finally {
        await closeWorkflowBoard();
      }

      return await summarizeResumedGenerationSession(
        runtime,
        persistedWorkflowPhase === "plan_repair" ? "plan_repair" : "plan",
      );
    }

    const result = await validateSessionPhase({
      sessionId: runtime.sessionId,
      phase: "generate",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.stdoutMode ? { stdoutMode: options.stdoutMode } : {}),
      ...(options.generator ? { generator: options.generator } : {}),
      ...(options.validator ? { validator: options.validator } : {}),
    });

    return {
      ...result,
      resumedFromPhase: result.resumedFromPhase ?? persistedWorkflowPhase ?? "generate",
    };
  } finally {
    setWorkflowStdoutMode(undefined);
  }
}

async function resolveValidationPhase(
  runtime: TextGeneratorRuntime,
  requestedPhase?: ValidationPhase,
): Promise<ValidationPhase> {
  if (requestedPhase) {
    return requestedPhase;
  }

  const persistedPhase = await readPersistedWorkflowPhase(runtime.deepagentsConfigPath);
  if (persistedPhase === "plan" || persistedPhase === "plan_repair") {
    return "plan";
  }

  if (
    persistedPhase === "generate" ||
    persistedPhase === "generate_repair" ||
    persistedPhase === "runtime_validation" ||
    persistedPhase === "complete"
  ) {
    return "generate";
  }

  const planValidation = await readPersistedPlanValidation(runtime.deepagentsPlanValidationPath);
  if (!planValidation?.valid) {
    return "plan";
  }

  const generationValidation = await readPersistedGenerationValidation(runtime.deepagentsGenerationValidationPath);
  if (generationValidation) {
    return "generate";
  }

  const reportContents = await readIfExists(path.join(runtime.outputDirectory, "app-builder-report.md"));
  if (reportContents && reportContents.trim().length > 0) {
    return "generate";
  }

  return "plan";
}

async function readPersistedWorkflowPhase(configPath: string): Promise<WorkflowPhase | null> {
  const contents = await readIfExists(configPath);
  if (!contents) {
    return null;
  }

  try {
    const parsed = JSON.parse(contents) as {
      workflow?: {
        phase?: unknown;
      };
    };
    const phase = parsed.workflow?.phase;
    return phase === "plan" ||
      phase === "plan_repair" ||
      phase === "generate" ||
      phase === "generate_repair" ||
      phase === "runtime_validation" ||
      phase === "complete"
      ? phase
      : null;
  } catch {
    return null;
  }
}

async function readPersistedPlanValidation(
  validationPath: string,
): Promise<{ valid: boolean; reasons: string[]; planSpecVersion?: number } | null> {
  const contents = await readIfExists(validationPath);
  if (!contents) {
    return null;
  }

  try {
    const parsed = JSON.parse(contents) as {
      valid?: unknown;
      reasons?: unknown;
      planSpecVersion?: unknown;
    };
    return {
      valid: parsed.valid === true,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.filter((value): value is string => typeof value === "string") : [],
      ...(typeof parsed.planSpecVersion === "number" ? { planSpecVersion: parsed.planSpecVersion } : {}),
    };
  } catch {
    return null;
  }
}

function defaultTemplateRepairRetries(): TemplateRepairRetries {
  return {
    plan: 2,
    generate: 2,
  };
}

export async function generateApplication(options: GenerateAppOptions): Promise<GenerationResult> {
  setWorkflowStdoutMode(options.stdoutMode);
  try {
    const workspaceOptions: {
      outputDirectory?: string;
      force?: boolean;
    } = {};

    if (options.outputDirectory) {
      workspaceOptions.outputDirectory = options.outputDirectory;
    }

    if (options.force !== undefined) {
      workspaceOptions.force = options.force;
    }

    const workspace = await prepareOutputWorkspace(workspaceOptions);
    const template = await loadTemplatePack(options.templateId);
    const templateLock = await stageTemplatePack(template, workspace);

    const sourceMarkdown = await fs.readFile(options.specPath, "utf8");
    const parsed = parsePrd(sourceMarkdown);
    const spec = normalizeSpec(parsed, sourceMarkdown, options.appNameOverride);
    await fs.writeFile(workspace.sourcePrdSnapshotPath, sourceMarkdown, "utf8");

    const modelRoles = resolveModelRoleConfigs(process.env, {
      requireApiKeys: options.generator ? false : true,
    });
    const generator =
      options.generator ??
      new DeepAgentsTextGenerator({ modelRoles });
    const validator =
      options.validator ??
      (options.generator ? new PassthroughGeneratedAppValidator() : new ShellGeneratedAppValidator());
    await copyStarterScaffold(template, workspace.outputDirectory);

    await writeDeepagentsConfig(workspace, {
      sessionId: workspace.sessionId,
      startedAt: new Date().toISOString(),
      appName: spec.appName,
      model: modelRoles.plan.modelName,
      models: sanitizeModelRoleConfigs(modelRoles),
      workflow: {
        phase: "plan",
        completedPhases: [],
      },
      artifacts: {
        sourcePrd: ".deepagents/source-prd.md",
        analysis: ".deepagents/prd-analysis.md",
        generatedSpec: ".deepagents/generated-spec.md",
        planSpec: ".deepagents/plan-spec.json",
        planValidation: ".deepagents/plan-validation.json",
        generationValidation: ".deepagents/generation-validation.json",
        runtimeValidationLog: ".deepagents/runtime-validation.log",
        runtimeInteractionValidation: ".deepagents/runtime-interaction-validation.json",
        errorLog: ".deepagents/error.log",
      },
      prompts: {
        plan: ".deepagents/plan-system-prompt.md",
        planRepair: ".deepagents/plan-repair-system-prompt.md",
        generate: ".deepagents/generate-system-prompt.md",
        generateRepair: ".deepagents/generate-repair-system-prompt.md",
      },
      template: templateLock,
    });

    const createRuntime = (overrides: Partial<TextGeneratorRuntime> = {}): TextGeneratorRuntime => ({
      sessionId: workspace.sessionId,
      outputDirectory: workspace.outputDirectory,
      deepagentsDirectory: workspace.deepagentsDirectory,
      deepagentsAgentsPath: workspace.deepagentsAgentsPath,
      deepagentsLogPath: workspace.deepagentsLogPath,
      deepagentsErrorLogPath: workspace.deepagentsErrorLogPath,
      deepagentsRuntimeValidationLogPath: workspace.deepagentsRuntimeValidationLogPath,
      deepagentsRuntimeInteractionValidationPath: workspace.deepagentsRuntimeInteractionValidationPath,
      deepagentsConfigPath: workspace.deepagentsConfigPath,
      deepagentsPlanPromptSnapshotPath: workspace.deepagentsPlanPromptSnapshotPath,
      deepagentsPlanRepairPromptSnapshotPath: workspace.deepagentsPlanRepairPromptSnapshotPath,
      deepagentsGeneratePromptSnapshotPath: workspace.deepagentsGeneratePromptSnapshotPath,
      deepagentsGenerateRepairPromptSnapshotPath: workspace.deepagentsGenerateRepairPromptSnapshotPath,
      templateId: template.id,
      templateName: template.name,
      templateVersion: template.version,
      templateDirectory: workspace.deepagentsTemplateDirectory,
      templatePlanPromptPath: template.planPromptPath,
      templatePlanRepairPromptPath: template.planRepairPromptPath,
      templateGeneratePromptPath: template.generatePromptPath,
      templateGenerateRepairPromptPath: template.generateRepairPromptPath,
      sourcePrdSnapshotPath: workspace.sourcePrdSnapshotPath,
      deepagentsAnalysisPath: workspace.deepagentsAnalysisPath,
      deepagentsDetailedSpecPath: workspace.deepagentsDetailedSpecPath,
      deepagentsPlanSpecPath: workspace.deepagentsPlanSpecPath,
      deepagentsPlanValidationPath: workspace.deepagentsPlanValidationPath,
      deepagentsGenerationValidationPath: workspace.deepagentsGenerationValidationPath,
      maxPlanRetries: template.repairRetries.plan,
      maxGenerateRetries: template.repairRetries.generate,
      templatePhases: template.phases,
      templateRuntimeValidation: template.runtimeValidation,
      templateInteractiveRuntimeValidation: template.interactiveRuntimeValidation,
      modelRoles,
      ...overrides,
    });
    const maxPlanRepairs = template.repairRetries.plan;
    const maxGenerationRepairs = template.repairRetries.generate;

    await materializeSessionPromptSnapshots(createRuntime());

    let approvedPlan: PlanSpec | null = null;
    let planRetryReasons: string[] = [];

    {
      const initialRuntime = createRuntime({
        planAttempt: 1,
        retryReasons: [],
      });
      let planResult: PlanResult;
      try {
        planResult = await generator.planProject(spec, initialRuntime);
      } catch (error) {
        const recovered = await synthesizeRecoveredPlanResult(initialRuntime, error);
        if (!recovered) {
          throw error;
        }
        planResult = recovered;
      }
      await appendWorkflowLog("[host] 计划阶段流式输出完成，开始宿主校验。");
      await updateWorkflowBoard({
        stage: "计划阶段",
        todos: createStepItemsForLifecycle("计划阶段", "validating"),
        artifacts: createArtifactItemsForStage("计划阶段", "validating"),
        narrative: "正在验证计划阶段产出物。",
        sessionId: workspace.sessionId,
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validatePlanArtifacts(initialRuntime, planResult);
      if (validation.reasons.length === 0) {
        approvedPlan = validation.planSpec;
        await appendWorkflowLog("[host] 计划阶段产出物通过校验。");
        await updateWorkflowBoard({
          stage: "计划阶段",
          todos: createStepItemsForLifecycle("计划阶段", "verified"),
          artifacts: createArtifactItemsForStage("计划阶段", "verified"),
          narrative: "计划阶段产出物已验证，通过生成门禁。",
          sessionId: workspace.sessionId,
          outputDirectory: workspace.outputDirectory,
        });
      } else {
        planRetryReasons = validation.reasons;
        await appendWorkflowLog(`[host] 计划阶段校验失败，待修复问题 ${validation.reasons.length} 条。`);
        await appendValidationFailureDetails(validation.reasons);
      }
    }

    for (let repairIndex = 0; !approvedPlan && repairIndex < maxPlanRepairs; repairIndex += 1) {
      await updateWorkflowState(workspace.deepagentsConfigPath, "plan_repair", []);
      await appendRetryNote(workspace.deepagentsErrorLogPath, repairIndex + 1, "计划修复阶段", planRetryReasons);
      await appendWorkflowLog(`[host] 启动计划修复轮次 ${repairIndex + 1}。`);

      const repairRuntime = createRuntime({
        planAttempt: repairIndex + 2,
        retryReasons: planRetryReasons,
      });
      let repairResult: PlanResult;
      try {
        repairResult = await generator.planRepairProject(repairRuntime);
      } catch (error) {
        const recovered = await synthesizeRecoveredPlanResult(repairRuntime, error);
        if (!recovered) {
          throw error;
        }
        repairResult = recovered;
      }
      await appendWorkflowLog("[host] 计划修复输出完成，开始复核。");
      await updateWorkflowBoard({
        stage: "计划阶段",
        todos: createStepItemsForLifecycle("计划阶段", "validating"),
        artifacts: createArtifactItemsForStage("计划阶段", "validating"),
        narrative: "正在复核修复后的计划产出物。",
        sessionId: workspace.sessionId,
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validatePlanArtifacts(repairRuntime, repairResult);
      if (validation.reasons.length === 0) {
        approvedPlan = validation.planSpec;
        await appendWorkflowLog("[host] 修复后的计划阶段产出物通过校验。");
        await updateWorkflowBoard({
          stage: "计划阶段",
          todos: createStepItemsForLifecycle("计划阶段", "verified"),
          artifacts: createArtifactItemsForStage("计划阶段", "verified"),
          narrative: "计划阶段产出物已验证，通过生成门禁。",
          sessionId: workspace.sessionId,
          outputDirectory: workspace.outputDirectory,
        });
        break;
      }

      planRetryReasons = validation.reasons;
      await appendWorkflowLog(`[host] 计划修复轮次 ${repairIndex + 1} 仍未通过，剩余问题 ${validation.reasons.length} 条。`);
      await appendValidationFailureDetails(validation.reasons);
    }

    if (!approvedPlan) {
      throw new Error(`Plan validation failed: ${planRetryReasons.join(" | ")}`);
    }

    await updateWorkflowState(workspace.deepagentsConfigPath, "generate", ["plan"]);

    let generationRetryReasons: string[] = [];

    {
      const initialRuntime = createRuntime({
        generateAttempt: 1,
        retryReasons: [],
      });
      let generatedProject: GeneratedProject;
      try {
        generatedProject = await generator.generateProject(approvedPlan, initialRuntime);
      } catch (error) {
        const recovered = await synthesizeRecoveredGeneratedResult(initialRuntime, approvedPlan, error);
        if (!recovered) {
          throw error;
        }
        generatedProject = recovered;
      }
      await appendWorkflowLog("[host] 生成阶段流式输出完成，开始宿主校验。");
      await updateWorkflowBoard({
        stage: "生成阶段",
        todos: createStepItemsForLifecycle("生成阶段", "validating"),
        artifacts: createArtifactItemsForStage("生成阶段", "validating"),
        narrative: "正在验证生成阶段交付物。",
        sessionId: workspace.sessionId,
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validateGeneratedArtifacts(
        workspace.outputDirectory,
        initialRuntime,
        approvedPlan,
        generatedProject,
        validator,
      );
      if (validation.reasons.length === 0) {
        generationRetryReasons = [];
        await appendWorkflowLog("[host] 生成阶段交付物通过校验。");
        await updateWorkflowBoard({
          stage: "生成阶段",
          todos: createStepItemsForLifecycle("生成阶段", "verified"),
          artifacts: createArtifactItemsForStage("生成阶段", "verified"),
          narrative: "生成阶段交付物已验证，全部通过。",
          sessionId: workspace.sessionId,
          outputDirectory: workspace.outputDirectory,
        });
      } else {
        generationRetryReasons = validation.reasons;
        await appendWorkflowLog(`[host] 生成阶段校验失败，待修复问题 ${validation.reasons.length} 条。`);
        await appendValidationFailureDetails(validation.reasons);
        await appendGenerationValidationStepDetails(validation.steps, validation.reasons);
      }
    }

    for (let repairIndex = 0; generationRetryReasons.length > 0 && repairIndex < maxGenerationRepairs; repairIndex += 1) {
      await updateWorkflowState(workspace.deepagentsConfigPath, "generate_repair", ["plan"]);
      await appendRetryNote(workspace.deepagentsErrorLogPath, repairIndex + 1, "生成修复阶段", generationRetryReasons);
      await appendWorkflowLog(`[host] 启动生成修复轮次 ${repairIndex + 1}。`);

      const repairRuntime = createRuntime({
        generateAttempt: repairIndex + 2,
        retryReasons: generationRetryReasons,
      });
      let repairedProject: GeneratedProject;
      try {
        repairedProject = await generator.generateRepairProject(approvedPlan, repairRuntime);
      } catch (error) {
        const recovered = await synthesizeRecoveredGeneratedResult(repairRuntime, approvedPlan, error);
        if (!recovered) {
          throw error;
        }
        repairedProject = recovered;
      }
      await appendWorkflowLog("[host] 生成修复输出完成，开始复核。");
      await updateWorkflowBoard({
        stage: "生成阶段",
        todos: createStepItemsForLifecycle("生成阶段", "validating"),
        artifacts: createArtifactItemsForStage("生成阶段", "validating"),
        narrative: "正在复核修复后的生成交付物。",
        sessionId: workspace.sessionId,
        outputDirectory: workspace.outputDirectory,
      });
      const validation = await validateGeneratedArtifacts(
        workspace.outputDirectory,
        repairRuntime,
        approvedPlan,
        repairedProject,
        validator,
      );
      if (validation.reasons.length === 0) {
        generationRetryReasons = [];
        await appendWorkflowLog("[host] 修复后的生成交付物通过校验。");
        await updateWorkflowBoard({
          stage: "生成阶段",
          todos: createStepItemsForLifecycle("生成阶段", "verified"),
          artifacts: createArtifactItemsForStage("生成阶段", "verified"),
          narrative: "生成阶段交付物已验证，全部通过。",
          sessionId: workspace.sessionId,
          outputDirectory: workspace.outputDirectory,
        });
        break;
      }

      generationRetryReasons = validation.reasons;
      await appendWorkflowLog(`[host] 生成修复轮次 ${repairIndex + 1} 仍未通过，剩余问题 ${validation.reasons.length} 条。`);
      await appendValidationFailureDetails(validation.reasons);
      await appendGenerationValidationStepDetails(validation.steps, validation.reasons);
    }

    if (generationRetryReasons.length > 0) {
      throw new Error(`Generation validation failed: ${generationRetryReasons.join(" | ")}`);
    }

    await completeAfterGenerateValidation({
      runtime: createRuntime(),
      generator,
      validator,
      approvedPlan,
    });

    const outputDirectory = workspace.outputDirectory;
    const writtenFiles = await collectGeneratedFiles(outputDirectory);

    const report: GenerationReport = {
      appName: spec.appName,
      templateId: template.id,
      outputDirectory,
      entities: spec.entities.map((entity) => entity.name),
      screens: spec.screens.map((screen) => `${screen.name} (${screen.route})`),
      warnings: spec.warnings,
      defaultsApplied: spec.defaultsApplied,
    };

    return {
      spec,
      sessionId: workspace.sessionId,
      templateId: template.id,
      outputDirectory,
      files: writtenFiles,
      report,
    };
  } finally {
    try {
      await closeWorkflowBoard();
    } finally {
      setWorkflowStdoutMode(undefined);
    }
  }
}
