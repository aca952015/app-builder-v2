import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import path from "node:path";
import { promises as fs } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import {
  resolveWindowsCommandScriptSpawn,
  spawnManagedDevServerProcess,
  terminateManagedDevServerProcess,
  type ManagedDevServerProcess,
} from "./dev-server-process.js";
import { validatePlanSpec, type PlanSpec } from "./plan-spec.js";
import { validateInteractionContract } from "./interaction-contract.js";
import { collectPageRoutePatterns, normalizeRoutePattern } from "./app-router.js";
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
import { extractExternalReferenceDrafts, normalizeSpec } from "./spec-normalizer.js";
import { copyStarterScaffold, loadTemplatePack, stageTemplatePack } from "./template-pack.js";
import {
  DeepAgentsTextGenerator,
  materializeGenerationPromptSnapshot,
  materializeSessionPromptSnapshots,
} from "./text-generator.js";
import {
  closeRuntimeInteractionValidationSession,
  runInteractiveRuntimeValidation,
  runNonInteractiveRuntimeValidation,
  runSmokeRuntimeValidation,
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
  appendWorkflowMetricRecord,
  buildWorkflowMetricRecord,
  measureRuntimeStep,
  measureWorkflowStep,
} from "./workflow-metrics.js";
import {
  TEMPLATE_PHASE_EFFORTS,
  type ExternalReferenceDraft,
  type GeneratedAppValidator,
  GenerateAppOptions,
  GeneratedProject,
  GenerationValidationStep,
  GenerationReport,
  GenerationResult,
  type NormalizedSpec,
  PlanResult,
  SessionValidationResult,
  type TemplatePhaseMap,
  type TemplateRepairRetries,
  type TemplateInteractiveRuntimeValidation,
  type TemplateEnvironmentPolicy,
  type TemplateProjectConfigPolicy,
  type TemplatePhaseEffort,
  type TemplateRuntimeValidation,
  type TemplateRuntimeValidationStep,
  type RuntimeValidationMode,
  TextGenerator,
  TextGeneratorRuntime,
  type LocalReference,
  type ReferenceMarkdownConversionInput,
  type ReferenceManifest,
  type StdoutMode,
  ValidationPhase,
  WorkflowPhase,
} from "./types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_DEV_SERVER_READY_TIMEOUT_MS = 90_000;
const DEFAULT_EXTERNAL_REFERENCE_CONCURRENCY = 8;
const DESIGN_ARTIFACT_RELATIVE_PATH = "DESIGN.md";
const STARTER_ENV_EXAMPLE_SNAPSHOT_FILE = "starter.env.example";
const STARTER_PROJECT_CONFIG_SNAPSHOT_FILE = "starter.project-config.json";
type RetryStage = "计划阶段" | "计划修复阶段" | "生成阶段" | "生成修复阶段" | "运行验证修复阶段";

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

function defaultTemplateEnvironmentPolicy(): TemplateEnvironmentPolicy {
  return { lockedKeys: [] };
}

function defaultTemplateProjectConfigPolicy(): TemplateProjectConfigPolicy {
  return { guardedFiles: [] };
}

function slugifyReferenceUrl(url: string): string {
  const parsed = new URL(url);
  const source = `${parsed.hostname}${parsed.pathname}`;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "reference";
}

function toReferenceVirtualPath(outputDirectory: string, filePath: string): string {
  return `/${path.relative(outputDirectory, filePath).split(path.sep).join("/")}`;
}

function extensionForContentType(contentType?: string | null): "md" | "html" {
  return contentType?.toLowerCase().includes("html") ? "html" : "md";
}

function reserveReferencePath(
  directory: string,
  baseSlug: string,
  extension: "md" | "html",
  usedPaths: Set<string>,
): string {
  let localPath = path.join(directory, `${baseSlug}.${extension}`);
  let counter = 2;
  while (usedPaths.has(localPath)) {
    localPath = path.join(directory, `${baseSlug}-${counter}.${extension}`);
    counter += 1;
  }
  usedPaths.add(localPath);
  return localPath;
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index] as T, index);
    }
  }));

  return results;
}

function isLikelyHtmlDocument(input: ReferenceMarkdownConversionInput): boolean {
  return input.contentType.toLowerCase().includes("html") || /<\/?[a-z][\s\S]*>/i.test(input.body);
}

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  const decodeCodePoint = (value: number, fallback: string) => (
    Number.isInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : fallback
  );

  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    const normalized = code.toLowerCase();
    if (normalized.startsWith("#x")) {
      const value = Number.parseInt(normalized.slice(2), 16);
      return decodeCodePoint(value, entity);
    }

    if (normalized.startsWith("#")) {
      const value = Number.parseInt(normalized.slice(1), 10);
      return decodeCodePoint(value, entity);
    }

    return namedEntities[normalized] ?? entity;
  });
}

function compactReadableText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function stripHtmlToReadableMarkdown(html: string): string {
  return compactReadableText(decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(?:nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/(?:nav|footer|header|aside)>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|table|pre|blockquote|ul|ol)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ));
}

function fallbackReferenceMarkdown(input: ReferenceMarkdownConversionInput): string {
  if (isLikelyHtmlDocument(input)) {
    return stripHtmlToReadableMarkdown(input.body) || compactReadableText(input.body);
  }

  return compactReadableText(input.body);
}

async function convertReferenceToMarkdown(
  generator: TextGenerator,
  runtime: TextGeneratorRuntime,
  input: ReferenceMarkdownConversionInput,
): Promise<string> {
  if (generator.convertReferenceToMarkdown) {
    try {
      const result = await generator.convertReferenceToMarkdown(input, runtime);
      if (result.markdown.trim().length > 0) {
        return result.markdown;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendWorkflowLog(`[host] 参考资料 Markdown 转换失败，改用宿主兜底转换：${input.url}（${message}）`);
    }
  }

  return fallbackReferenceMarkdown(input);
}

async function writeReferenceManifest(runtime: TextGeneratorRuntime, entries: LocalReference[]): Promise<void> {
  const manifest: ReferenceManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries,
  };
  await fs.mkdir(path.dirname(runtime.deepagentsReferenceManifestPath), { recursive: true });
  await fs.writeFile(runtime.deepagentsReferenceManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function resolveExternalReferences(
  runtime: TextGeneratorRuntime,
  candidates: ExternalReferenceDraft[],
  generator: TextGenerator,
): Promise<LocalReference[]> {
  const usedPaths = new Set<string>();
  const externalDirectory = path.join(runtime.deepagentsDirectory, "references", "external");
  await fs.mkdir(externalDirectory, { recursive: true });

  const reservations = candidates.map((candidate) => {
    const baseSlug = slugifyReferenceUrl(candidate.url);
    return {
      rawHtmlPath: reserveReferencePath(externalDirectory, baseSlug, "html", usedPaths),
      markdownPath: reserveReferencePath(externalDirectory, baseSlug, "md", usedPaths),
    };
  });

  const entries = await mapWithConcurrency(
    candidates,
    DEFAULT_EXTERNAL_REFERENCE_CONCURRENCY,
    async (candidate, index): Promise<LocalReference> => {
      const reservation = reservations[index];
      if (!reservation) {
        throw new Error(`Missing reference path reservation for ${candidate.url}`);
      }

      const retrievedAt = new Date().toISOString();
      try {
        const response = await fetch(candidate.url, {
          headers: { "user-agent": "app-builder-v2-reference-resolver/1.0" },
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
        }

        const contentType = response.headers.get("content-type") ?? "text/plain";
        const body = await response.text();
        const rawExtension = extensionForContentType(contentType);
        const rawPath = rawExtension === "html" ? reservation.rawHtmlPath : reservation.markdownPath;
        await fs.writeFile(rawPath, body, "utf8");

        const convertedMarkdown = await convertReferenceToMarkdown(generator, runtime, {
          url: candidate.url,
          name: candidate.name,
          type: candidate.type,
          contentType,
          body,
        });
        await fs.writeFile(reservation.markdownPath, convertedMarkdown, "utf8");

        return {
          url: candidate.url,
          name: candidate.name,
          type: candidate.type,
          required: candidate.required,
          retrievalStatus: "downloaded",
          localPath: toReferenceVirtualPath(runtime.outputDirectory, reservation.markdownPath),
          retrievedAt,
          contentType,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          url: candidate.url,
          name: candidate.name,
          type: candidate.type,
          required: candidate.required,
          retrievalStatus: "failed",
          retrievedAt,
          error: message,
        };
      }
    },
  );

  await writeReferenceManifest(runtime, entries);
  return entries;
}

async function readReferenceManifest(runtime: TextGeneratorRuntime): Promise<ReferenceManifest | null> {
  const contents = await readIfExists(runtime.deepagentsReferenceManifestPath);
  if (!contents) {
    return null;
  }
  try {
    const parsed = JSON.parse(contents) as ReferenceManifest;
    return parsed && parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveVirtualReferencePath(runtime: TextGeneratorRuntime, localPath: string): string | null {
  const normalized = localPath.replace(/\\/g, "/");
  const relative = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  if (!relative.startsWith(".deepagents/references/")) {
    return null;
  }
  const absolutePath = path.resolve(runtime.outputDirectory, relative);
  const referencesRoot = path.resolve(runtime.deepagentsDirectory, "references");
  return absolutePath === referencesRoot || absolutePath.startsWith(`${referencesRoot}${path.sep}`) ? absolutePath : null;
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
  const spawnCommand = resolveWindowsCommandScriptSpawn(resolvedCommand, options.args);

  return spawn(spawnCommand.command, spawnCommand.args, {
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

  const DASHBOARD_LOG_INTERVAL_MS = 3_000;
  let lastDashboardLogAt = 0;
  let pendingOutputLine = "";

  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    void fs.appendFile(options.logPath, text, "utf8");

    const outputWithPending = `${pendingOutputLine}${text}`;
    const outputLines = outputWithPending.split(/\r?\n/);
    pendingOutputLine = outputLines.pop() ?? "";

    const now = Date.now();
    if (now - lastDashboardLogAt > DASHBOARD_LOG_INTERVAL_MS && outputLines.length > 0) {
      lastDashboardLogAt = now;
      const recentLines = outputLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-3);
      for (const line of recentLines) {
        const truncated = line.length > 200 ? `${line.slice(0, 200)}...` : line;
        void appendWorkflowLog(`[host] ${options.name}: ${truncated}`);
      }
    }
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

  const hadExistingEnv = await readIfExists(envPath) !== null;
  await fs.copyFile(envExamplePath, envPath);
  await appendRuntimeValidationLog(logPath, [
    "=== mv .env.example .env ===",
    hadExistingEnv
      ? "[ok] 已按宿主托管的 .env.example 重新生成 .env（覆盖旧文件以保持一致）。"
      : "[ok] 已按校验要求从 .env.example 生成 .env（保留 example 以支持重复验证）。",
    "",
  ]);
  return {
    name: "mv .env.example .env",
    ok: true,
    detail: hadExistingEnv
      ? "已从 .env.example 重新生成 .env。"
      : "已从 .env.example 生成 .env。",
  };
}

const REQUIRED_BUILT_DEPENDENCIES = ["better-sqlite3", "prisma"];

async function ensurePackageJsonPnpmConfig(outputDirectory: string, logPath: string): Promise<GenerationValidationStep> {
  const packageJsonPath = path.join(outputDirectory, "package.json");
  const contents = await readIfExists(packageJsonPath);
  if (!contents) {
    await appendRuntimeValidationLog(logPath, [
      "=== ensure package.json pnpm config ===",
      "[error] 缺少 package.json，无法确保 pnpm 构建配置。",
      "",
    ]);
    return {
      name: "ensure package.json pnpm config",
      ok: false,
      detail: "缺少 package.json。",
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(contents) as Record<string, unknown>;
  } catch {
    await appendRuntimeValidationLog(logPath, [
      "=== ensure package.json pnpm config ===",
      "[error] package.json 解析失败。",
      "",
    ]);
    return {
      name: "ensure package.json pnpm config",
      ok: false,
      detail: "package.json 解析失败。",
    };
  }

  const pnpm = (parsed.pnpm as Record<string, unknown> | undefined) ?? {};
  const existing = Array.isArray(pnpm.onlyBuiltDependencies)
    ? (pnpm.onlyBuiltDependencies as string[])
    : [];
  const missing = REQUIRED_BUILT_DEPENDENCIES.filter((dep) => !existing.includes(dep));

  if (missing.length > 0) {
    pnpm.onlyBuiltDependencies = [...existing, ...missing];
    parsed.pnpm = pnpm;
    await fs.writeFile(packageJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
    await appendRuntimeValidationLog(logPath, [
      "=== ensure package.json pnpm config ===",
      `[ok] 已注入缺失的 onlyBuiltDependencies：${missing.join(", ")}。`,
      "",
    ]);
    return {
      name: "ensure package.json pnpm config",
      ok: true,
      detail: `已注入缺失的 onlyBuiltDependencies：${missing.join(", ")}。`,
    };
  }

  await appendRuntimeValidationLog(logPath, [
    "=== ensure package.json pnpm config ===",
    "[ok] onlyBuiltDependencies 已包含所需依赖。",
    "",
  ]);
  return {
    name: "ensure package.json pnpm config",
    ok: true,
    detail: "onlyBuiltDependencies 已包含所需依赖。",
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

  let managedDevServer: ManagedDevServerProcess;
  let child: ChildProcess;
  try {
    const env = {
      ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
    };
    const resolvedCommand = await resolveSpawnCommand("pnpm", env);
    managedDevServer = spawnManagedDevServerProcess({
      command: resolvedCommand,
      args: ["dev"],
      cwd: outputDirectory,
      env,
    });
    child = managedDevServer.child;
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

  const DASHBOARD_LOG_INTERVAL_MS = 3_000;
  let lastDashboardLogAt = 0;
  let pendingOutputLine = "";

  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    void fs.appendFile(logPath, text, "utf8");

    const outputWithPending = `${pendingOutputLine}${text}`;
    const outputLines = outputWithPending.split(/\r?\n/);
    pendingOutputLine = outputLines.pop() ?? "";

    const now = Date.now();
    if (now - lastDashboardLogAt > DASHBOARD_LOG_INTERVAL_MS && outputLines.length > 0) {
      lastDashboardLogAt = now;
      const recentLines = outputLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-3);
      for (const line of recentLines) {
        const truncated = line.length > 200 ? `${line.slice(0, 200)}...` : line;
        void appendWorkflowLog(`[host] pnpm dev: ${truncated}`);
      }
    }
  };

  child.stdout!.on("data", onChunk);
  child.stderr!.on("data", onChunk);

  const finish = async (step: GenerationValidationStep): Promise<GenerationValidationStep> => {
    if (finished) {
      return step;
    }
    finished = true;
    await terminateManagedDevServerProcess(managedDevServer);
    await appendRuntimeValidationLog(logPath, [
      "",
      step.ok ? `[ok] ${step.detail}` : `[error] ${step.detail}`,
      "",
    ]);
    return step;
  };

  const timeoutAt = Date.now() + DEFAULT_DEV_SERVER_READY_TIMEOUT_MS;
  let lastWaitLogAt = 0;
  while (!finished && Date.now() < timeoutAt) {
    if (Date.now() - lastWaitLogAt > 5_000) {
      lastWaitLogAt = Date.now();
      void appendWorkflowLog("[host] pnpm dev: 等待开发服务器就绪...");
    }

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

  let managedDevServer: ManagedDevServerProcess;
  let child: ChildProcess;
  try {
    const env = {
      ...process.env,
      ...options.env,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    };
    const resolvedCommand = await resolveSpawnCommand(options.command, env);
    managedDevServer = spawnManagedDevServerProcess({
      command: resolvedCommand,
      args: options.args,
      cwd: options.outputDirectory,
      env,
    });
    child = managedDevServer.child;
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

  const DASHBOARD_LOG_INTERVAL_MS = 3_000;
  let lastDashboardLogAt = 0;
  let pendingOutputLine = "";

  const onChunk = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output += text;
    void fs.appendFile(options.logPath, text, "utf8");

    const outputWithPending = `${pendingOutputLine}${text}`;
    const outputLines = outputWithPending.split(/\r?\n/);
    pendingOutputLine = outputLines.pop() ?? "";

    const now = Date.now();
    if (now - lastDashboardLogAt > DASHBOARD_LOG_INTERVAL_MS && outputLines.length > 0) {
      lastDashboardLogAt = now;
      const recentLines = outputLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-3);
      for (const line of recentLines) {
        const truncated = line.length > 200 ? `${line.slice(0, 200)}...` : line;
        void appendWorkflowLog(`[host] ${options.name}: ${truncated}`);
      }
    }
  };

  child.stdout!.on("data", onChunk);
  child.stderr!.on("data", onChunk);

  const finish = async (step: GenerationValidationStep): Promise<GenerationValidationStep> => {
    if (finished) {
      return step;
    }
    finished = true;
    await terminateManagedDevServerProcess(managedDevServer);
    await appendRuntimeValidationLog(options.logPath, [
      "",
      step.ok ? `[ok] ${step.detail}` : `[error] ${step.detail}`,
      "",
    ]);
    return step;
  };

  const timeoutAt = Date.now() + DEFAULT_DEV_SERVER_READY_TIMEOUT_MS;
  let lastWaitLogAt = 0;
  while (!finished && Date.now() < timeoutAt) {
    if (Date.now() - lastWaitLogAt > 5_000) {
      lastWaitLogAt = Date.now();
      void appendWorkflowLog(`[host] ${options.name}: 等待开发服务器就绪...`);
    }

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
  async validate(outputDirectory: string, runtime: TextGeneratorRuntime, planSpec?: PlanSpec): Promise<{
    reasons: string[];
    steps: GenerationValidationStep[];
  }> {
    await fs.writeFile(runtime.deepagentsRuntimeValidationLogPath, "", "utf8");

    const steps: GenerationValidationStep[] = [];
    const runtimeValidation = runtime.templateRuntimeValidation ?? defaultTemplateRuntimeValidation();

    if (runtimeValidation.copyEnvExample !== false) {
      await appendWorkflowLog("[host] 正在运行 mv .env.example .env...");
      const envStep = await measureRuntimeStep(
        runtime,
        {
          name: "runtime_validation.env_file",
          phase: (runtime.generateAttempt ?? 1) > 1 ? "generate_repair" : "generate",
          metadata: { stepName: "mv .env.example .env" },
        },
        async () => await ensureEnvFile(outputDirectory, runtime.deepagentsRuntimeValidationLogPath),
      );
      steps.push(envStep);
      if (!envStep.ok) {
        return {
          reasons: [`生成阶段运行验证失败：${envStep.name} 未通过。${envStep.detail} 详见 .deepagents/runtime-validation.log。`],
          steps,
        };
      }
      await appendWorkflowLog("[host] mv .env.example .env 通过。");

      await appendWorkflowLog("[host] 正在确保 package.json pnpm 构建配置...");
      const pnpmStep = await measureRuntimeStep(
        runtime,
        {
          name: "runtime_validation.package_json_pnpm",
          phase: (runtime.generateAttempt ?? 1) > 1 ? "generate_repair" : "generate",
          metadata: { stepName: "ensure package.json pnpm config" },
        },
        async () => await ensurePackageJsonPnpmConfig(outputDirectory, runtime.deepagentsRuntimeValidationLogPath),
      );
      steps.push(pnpmStep);
      if (!pnpmStep.ok) {
        return {
          reasons: [`生成阶段运行验证失败：${pnpmStep.name} 未通过。${pnpmStep.detail} 详见 .deepagents/runtime-validation.log。`],
          steps,
        };
      }
      await appendWorkflowLog("[host] package.json pnpm 配置通过。");
    }

    for (const validationStep of runtimeValidation.steps) {
      await appendWorkflowLog(`[host] 正在运行 ${validationStep.name}...`);
      const step = await measureRuntimeStep(
        runtime,
        {
          name: "runtime_validation.step",
          phase: (runtime.generateAttempt ?? 1) > 1 ? "generate_repair" : "generate",
          metadata: {
            stepName: validationStep.name,
            kind: validationStep.kind ?? "command",
            command: validationStep.command,
            args: validationStep.args,
          },
        },
        async () => validationStep.kind === "dev-server"
          ? (
              planSpec
                ? (await runNonInteractiveRuntimeValidation({
                    runtime,
                    planSpec,
                    devServerStep: validationStep,
                    readyTimeoutMs: runtime.templateInteractiveRuntimeValidation.readyTimeoutMs,
                  })).steps[0] ?? {
                    name: validationStep.name,
                    ok: false,
                    detail: "非交互式运行验证没有返回步骤结果。",
                  }
                : await runConfiguredDevValidationStep({
                    outputDirectory,
                    logPath: runtime.deepagentsRuntimeValidationLogPath,
                    command: validationStep.command,
                    args: validationStep.args,
                    name: validationStep.name,
                    ...(validationStep.env ? { env: validationStep.env } : {}),
                  })
            )
          : (
              await runCommandStep({
                name: validationStep.name,
                command: validationStep.command,
                args: validationStep.args,
                cwd: outputDirectory,
                logPath: runtime.deepagentsRuntimeValidationLogPath,
                ...(validationStep.env ? { env: validationStep.env } : {}),
              })
            ).step,
      );
      steps.push(step);
      if (!step.ok) {
        return {
          reasons: [`生成阶段运行验证失败：${validationStep.name} 未通过。${step.detail} 详见 .deepagents/runtime-validation.log。`],
          steps,
        };
      }
      await appendWorkflowLog(`[host] ${validationStep.name} 通过。${step.detail}`);
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

type EnvExampleVariable = NonNullable<PlanSpec["environmentVariables"]>[number];
type ProjectConfigChange = NonNullable<PlanSpec["projectConfigChanges"]>[number];
type StarterProjectConfigSnapshot = {
  version: 1;
  files: Array<{
    path: string;
    exists: boolean;
    contents?: string;
  }>;
};

function starterEnvExampleSnapshotPath(runtime: Pick<TextGeneratorRuntime, "deepagentsDirectory">): string {
  return path.join(runtime.deepagentsDirectory, STARTER_ENV_EXAMPLE_SNAPSHOT_FILE);
}

function starterProjectConfigSnapshotPath(runtime: Pick<TextGeneratorRuntime, "deepagentsDirectory">): string {
  return path.join(runtime.deepagentsDirectory, STARTER_PROJECT_CONFIG_SNAPSHOT_FILE);
}

async function snapshotStarterEnvExample(outputDirectory: string, deepagentsDirectory: string): Promise<void> {
  const envExampleContents = await readIfExists(path.join(outputDirectory, ".env.example"));
  if (envExampleContents === null) {
    return;
  }

  await fs.writeFile(
    path.join(deepagentsDirectory, STARTER_ENV_EXAMPLE_SNAPSHOT_FILE),
    envExampleContents,
    "utf8",
  );
}

function normalizeProjectConfigPath(filePath: string): string {
  return normalizeRelativePath(filePath).replace(/^\.\//, "");
}

function collectGuardedProjectConfigFiles(policy: TemplateProjectConfigPolicy): string[] {
  return uniqueValues(policy.guardedFiles.map((filePath) => normalizeProjectConfigPath(filePath)));
}

async function snapshotStarterProjectConfigFiles(
  outputDirectory: string,
  deepagentsDirectory: string,
  policy: TemplateProjectConfigPolicy,
): Promise<void> {
  const guardedFiles = collectGuardedProjectConfigFiles(policy);
  if (guardedFiles.length === 0) {
    return;
  }

  const snapshot: StarterProjectConfigSnapshot = {
    version: 1,
    files: [],
  };

  for (const guardedFile of guardedFiles) {
    const contents = await readIfExists(path.join(outputDirectory, guardedFile));
    snapshot.files.push({
      path: guardedFile,
      exists: contents !== null,
      ...(contents !== null ? { contents } : {}),
    });
  }

  await fs.writeFile(
    path.join(deepagentsDirectory, STARTER_PROJECT_CONFIG_SNAPSHOT_FILE),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
}

function collectEnvExampleVariables(planSpec: PlanSpec): EnvExampleVariable[] {
  return (planSpec.environmentVariables ?? [])
    .filter((variable) => (variable.targetFile ?? ".env.example") === ".env.example");
}

function collectPlanEnvironmentPolicyIssues(
  runtime: Pick<TextGeneratorRuntime, "templateEnvironmentPolicy">,
  planSpec: PlanSpec,
): string[] {
  const lockedKeys = new Set((runtime.templateEnvironmentPolicy ?? defaultTemplateEnvironmentPolicy()).lockedKeys);
  if (lockedKeys.size === 0) {
    return [];
  }

  const lockedDeclarations = uniqueValues(
    (planSpec.environmentVariables ?? [])
      .filter((variable) => lockedKeys.has(variable.name))
      .map((variable) => variable.name),
  );

  if (lockedDeclarations.length === 0) {
    return [];
  }

  return [
    `planSpec.environmentVariables 不允许声明模板锁定的 .env.example 变量：${lockedDeclarations.join(", ")}。`,
  ];
}

function collectProjectConfigChanges(planSpec: PlanSpec): ProjectConfigChange[] {
  return planSpec.projectConfigChanges ?? [];
}

function parseEnvAssignmentLine(rawLine: string): { key: string } | null {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) {
    return null;
  }

  const separatorIndex = line.indexOf("=");
  if (separatorIndex <= 0) {
    return null;
  }

  const key = line.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  return { key };
}

function formatEnvAssignment(variable: EnvExampleVariable): string {
  return `${variable.name}=${variable.value}`;
}

function mergeEnvExampleContents(
  starterContents: string,
  variables: EnvExampleVariable[],
  lockedKeys: Set<string>,
): string {
  const lines = starterContents.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const keyToLineIndex = new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    const assignment = parseEnvAssignmentLine(line);
    if (assignment) {
      keyToLineIndex.set(assignment.key, index);
    }
  }

  for (const variable of variables) {
    if (lockedKeys.has(variable.name)) {
      continue;
    }

    const nextLine = formatEnvAssignment(variable);
    const existingIndex = keyToLineIndex.get(variable.name);
    if (existingIndex === undefined) {
      keyToLineIndex.set(variable.name, lines.length);
      lines.push(nextLine);
      continue;
    }

    lines[existingIndex] = nextLine;
  }

  return `${lines.join("\n")}\n`;
}

async function reconcileHostManagedEnvironment(
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
): Promise<string[]> {
  const lockedKeys = new Set((runtime.templateEnvironmentPolicy ?? defaultTemplateEnvironmentPolicy()).lockedKeys);
  const declaredVariables = collectEnvExampleVariables(planSpec);
  const envExamplePath = path.join(runtime.outputDirectory, ".env.example");
  const starterContents =
    await readIfExists(starterEnvExampleSnapshotPath(runtime)) ??
    await readIfExists(envExamplePath);

  if (starterContents === null && declaredVariables.length === 0) {
    return [];
  }

  const starterBaseContents = starterContents ?? "";
  const starterValues = parseDotEnv(starterBaseContents);
  const lockedConflicts = declaredVariables
    .filter((variable) => lockedKeys.has(variable.name) && starterValues[variable.name] !== variable.value)
    .map((variable) => variable.name);

  const mergedContents = mergeEnvExampleContents(starterBaseContents, declaredVariables, lockedKeys);
  await fs.writeFile(envExamplePath, mergedContents, "utf8");
  const envPath = path.join(runtime.outputDirectory, ".env");
  if (await readIfExists(envPath) !== null) {
    await fs.writeFile(envPath, mergedContents, "utf8");
  }

  if (lockedConflicts.length === 0) {
    return [];
  }

  return [
    `生成阶段未完成：planSpec.environmentVariables 试图修改模板锁定的 .env.example 变量：${Array.from(new Set(lockedConflicts)).join(", ")}。`,
  ];
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function resolveDesignDocumentSourcePath(designPath: string): Promise<string> {
  const resolvedPath = path.resolve(designPath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension !== ".md" && extension !== ".markdown") {
    throw new Error("The --design option must point to a Markdown file.");
  }

  let stats;
  try {
    stats = await fs.stat(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Design file was not found at ${resolvedPath}. ${message}`);
  }

  if (!stats.isFile()) {
    throw new Error(`Design path must reference a file: ${resolvedPath}`);
  }

  return resolvedPath;
}

async function copyDesignDocumentToWorkspace(sourcePath: string, outputDirectory: string): Promise<string> {
  const destinationPath = path.join(outputDirectory, DESIGN_ARTIFACT_RELATIVE_PATH);
  await fs.copyFile(sourcePath, destinationPath);
  return DESIGN_ARTIFACT_RELATIVE_PATH;
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
  const generatedPageRoutes = await collectPageRoutePatterns(outputDirectory);
  const pageExistsByRoute = new Map<string, boolean>();
  const apiExistsByPath = new Map<string, boolean>();

  for (const route of uniquePageRoutes) {
    pageExistsByRoute.set(route, generatedPageRoutes.has(normalizeRoutePattern(route)));
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
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
): Promise<string[]> {
  const lockedKeys = new Set((runtime.templateEnvironmentPolicy ?? defaultTemplateEnvironmentPolicy()).lockedKeys);
  const declaredVariables = collectEnvExampleVariables(planSpec)
    .filter((variable) => !lockedKeys.has(variable.name));
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

async function readStarterProjectConfigSnapshot(
  runtime: Pick<TextGeneratorRuntime, "deepagentsDirectory">,
): Promise<StarterProjectConfigSnapshot | null> {
  const snapshotContents = await readIfExists(starterProjectConfigSnapshotPath(runtime));
  if (!snapshotContents || snapshotContents.trim().length === 0) {
    return null;
  }

  const parsed = JSON.parse(snapshotContents) as Partial<StarterProjectConfigSnapshot>;
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
    return null;
  }

  return {
    version: 1,
    files: parsed.files.flatMap((file) => {
      if (
        !file ||
        typeof file.path !== "string" ||
        file.path.trim() === "" ||
        typeof file.exists !== "boolean"
      ) {
        return [];
      }

      const normalizedPath = normalizeProjectConfigPath(file.path);
      return [{
        path: normalizedPath,
        exists: file.exists,
        ...(typeof file.contents === "string" ? { contents: file.contents } : {}),
      }];
    }),
  };
}

async function collectProjectConfigPolicyIssues(
  outputDirectory: string,
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
): Promise<string[]> {
  const policy = runtime.templateProjectConfigPolicy ?? defaultTemplateProjectConfigPolicy();
  const guardedFiles = collectGuardedProjectConfigFiles(policy);
  if (guardedFiles.length === 0) {
    return [];
  }

  const guardedSet = new Set(guardedFiles);
  const snapshot = await readStarterProjectConfigSnapshot(runtime);
  if (!snapshot) {
    return [];
  }

  const declaredChanges = new Set(
    collectProjectConfigChanges(planSpec).map((change) => normalizeProjectConfigPath(change.filePath)),
  );
  const unauthorizedChangedFiles: string[] = [];

  for (const file of snapshot.files) {
    const guardedFile = normalizeProjectConfigPath(file.path);
    if (!guardedSet.has(guardedFile)) {
      continue;
    }

    const currentContents = await readIfExists(path.join(outputDirectory, guardedFile));
    const changed = file.exists
      ? currentContents !== (file.contents ?? "")
      : currentContents !== null;

    if (changed && !declaredChanges.has(guardedFile)) {
      unauthorizedChangedFiles.push(guardedFile);
    }
  }

  if (unauthorizedChangedFiles.length === 0) {
    return [];
  }

  return [
    `生成阶段未完成：受保护项目配置文件被修改但 artifacts.planSpec.projectConfigChanges 未声明来自 PRD 分析的项目配置变更：${unauthorizedChangedFiles.join(", ")}。只有 PRD 明确要求项目配置变更时才允许编辑这些文件。`,
  ];
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


async function collectReferenceManifestIssues(runtime: TextGeneratorRuntime): Promise<string[]> {
  const issues: string[] = [];
  const manifest = await readReferenceManifest(runtime);
  if (!manifest) {
    return issues;
  }

  for (const entry of manifest.entries) {
    if (entry.retrievalStatus === "downloaded") {
      if (!entry.localPath) {
        issues.push(`reference-manifest 下载项缺少 localPath：${entry.url}`);
        continue;
      }
      const absolutePath = resolveVirtualReferencePath(runtime, entry.localPath);
      if (!absolutePath) {
        issues.push(`reference-manifest localPath 必须位于 .deepagents/references/ 内：${entry.localPath}`);
        continue;
      }
      const contents = await readIfExists(absolutePath);
      if (!contents || contents.trim().length === 0) {
        issues.push(`reference-manifest localPath 文件不存在或为空：${entry.localPath}`);
      }
    }

    if (entry.required && entry.retrievalStatus === "failed") {
      issues.push(`必需参考资料下载失败：${entry.url}${entry.error ? `（${entry.error}）` : ""}`);
    }
  }

  return issues;
}

async function collectPlanReferenceIssues(runtime: TextGeneratorRuntime, planSpec: PlanSpec): Promise<string[]> {
  const issues: string[] = [];
  const generatedSpecContents = await readIfExists(runtime.deepagentsDetailedSpecPath) ?? "";
  const planReferenceLocalPaths = new Set((planSpec.references ?? [])
    .map((reference) => reference.localPath)
    .filter((localPath): localPath is string => Boolean(localPath)));
  const manifest = await readReferenceManifest(runtime);

  for (const entry of manifest?.entries ?? []) {
    if (
      entry.required &&
      entry.retrievalStatus === "downloaded" &&
      entry.localPath &&
      (entry.type === "external_api" || entry.type === "documentation") &&
      !planReferenceLocalPaths.has(entry.localPath)
    ) {
      issues.push(`planSpec.references 必须引用已下载的本地参考资料：${entry.localPath}`);
    }
  }

  for (const reference of planSpec.references ?? []) {
    const mustUseLocalPath = reference.type === "external_api" || reference.type === "documentation";
    if (!reference.localPath) {
      if (mustUseLocalPath && reference.url?.startsWith("http")) {
        issues.push(`planSpec.references 缺少本地参考路径 localPath：${reference.name}`);
      }
      continue;
    }

    const absolutePath = resolveVirtualReferencePath(runtime, reference.localPath);
    if (!absolutePath) {
      issues.push(`planSpec.references localPath 必须位于 .deepagents/references/ 内：${reference.localPath}`);
      continue;
    }

    const contents = await readIfExists(absolutePath);
    if (!contents || contents.trim().length === 0) {
      issues.push(`planSpec.references localPath 文件不存在或为空：${reference.localPath}`);
    }

    if (mustUseLocalPath && !generatedSpecContents.includes(reference.localPath)) {
      issues.push(`generated-spec.md 的 References 章节必须包含本地参考路径：${reference.localPath}`);
    }
  }

  return issues;
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

async function persistStructuredPlanSpecFromResult(
  runtime: TextGeneratorRuntime,
  result: PlanResult,
): Promise<void> {
  if (!result.planSpec) {
    return;
  }

  await fs.writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(result.planSpec, null, 2)}\n`, "utf8");
  await appendWorkflowLog("[host] 已从计划阶段结构化响应写入 plan-spec.json。");
}

async function persistStructuredInteractionContractFromResult(
  runtime: TextGeneratorRuntime,
  result: PlanResult,
): Promise<void> {
  if (!result.interactionContract) {
    return;
  }

  await fs.writeFile(
    runtime.deepagentsInteractionContractPath,
    `${JSON.stringify(result.interactionContract, null, 2)}\n`,
    "utf8",
  );
  await appendWorkflowLog("[host] 已从计划阶段结构化响应写入 interaction-contract.json。");
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

const STRUCTURED_RESPONSE_RETRY_LIMIT = 1;

async function appendStructuredResponseRetryNote(
  logPath: string,
  stageLabel: string,
  retry: number,
  retryLimit: number,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await fs.appendFile(
    logPath,
    `[${new Date().toISOString()}]\n${stageLabel}结构化响应缺失，准备重试当前阶段第 ${retry}/${retryLimit} 次。\nError: ${message}\n\n`,
    "utf8",
  );
}

async function runWithStructuredResponseRetry<T>(
  runtime: TextGeneratorRuntime,
  stageLabel: string,
  operation: () => Promise<T>,
): Promise<T> {
  for (let retryCount = 0; ; retryCount += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isMissingStructuredResponseError(error) || retryCount >= STRUCTURED_RESPONSE_RETRY_LIMIT) {
        throw error;
      }

      const currentRetry = retryCount + 1;
      await appendWorkflowLog(
        `[host] ${stageLabel}结构化响应缺失，准备重试当前阶段第 ${currentRetry}/${STRUCTURED_RESPONSE_RETRY_LIMIT} 次。`,
      );
      await appendStructuredResponseRetryNote(
        runtime.deepagentsErrorLogPath,
        stageLabel,
        currentRetry,
        STRUCTURED_RESPONSE_RETRY_LIMIT,
        error,
      );
    }
  }
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
      runtime.deepagentsInteractionContractPath,
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

async function runPrdAnalysisWithStructuredResponseRetry(
  generator: TextGenerator & Required<Pick<TextGenerator, "analyzePrd">>,
  spec: NormalizedSpec,
  runtime: TextGeneratorRuntime,
): Promise<PlanResult> {
  try {
    return await runWithStructuredResponseRetry(
      runtime,
      "PRD 分析阶段",
      async () => await generator.analyzePrd(spec, runtime),
    );
  } catch (error) {
    const recovered = await synthesizeRecoveredPlanResult(runtime, error);
    if (recovered) {
      return recovered;
    }

    throw error;
  }
}

async function runInitialPrdAnalysisPipeline(
  generator: TextGenerator & Required<Pick<TextGenerator, "analyzePrd">>,
  spec: NormalizedSpec,
  runtime: TextGeneratorRuntime,
  options: { parallelWith?: string } = {},
): Promise<PlanResult> {
  return await measureRuntimeStep(
    runtime,
    {
      name: "plan.prd_analysis",
      phase: "plan",
      attempt: runtime.planAttempt ?? 1,
      metadata: options.parallelWith ? { parallelWith: options.parallelWith } : {},
    },
    async () => await runPrdAnalysisWithStructuredResponseRetry(generator, spec, runtime),
  );
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
  completedPhases: Array<"plan" | "generate" | "validation">,
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

type PreparationStepKey = "workspace" | "input" | "references" | "model";

function createPreparationStepItems(activeStep: PreparationStepKey): Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
}> {
  const steps: Array<{
    key: PreparationStepKey;
    content: string;
  }> = [
    { key: "workspace", content: "准备输出工作区与模板快照" },
    { key: "input", content: "读取 PRD 并整理输入上下文" },
    { key: "references", content: "本地化 PRD 外部参考资料" },
    { key: "model", content: "等待模型开始计划阶段" },
  ];
  const activeIndex = steps.findIndex((step) => step.key === activeStep);

  return steps.map((step, index) => ({
    content: step.content,
    status: index < activeIndex
      ? "completed"
      : index === activeIndex
        ? "in_progress"
        : "pending",
  }));
}

async function showPreparationWorkflowBoard(options: {
  sessionId: string;
  outputDirectory: string;
  activeStep: PreparationStepKey;
  narrative: string;
}): Promise<void> {
  await updateWorkflowBoard({
    stage: "计划阶段",
    todos: createPreparationStepItems(options.activeStep),
    artifacts: createArtifactItemsForStage("计划阶段", "generating"),
    narrative: options.narrative,
    sessionId: options.sessionId,
    outputDirectory: options.outputDirectory,
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
    runtime.deepagentsInteractionContractPath,
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
        reasons.push(...collectPlanEnvironmentPolicyIssues(runtime, planSpec).map(
          (issue) => `计划阶段未完成：${issue}`,
        ));
        reasons.push(...(await collectPlanReferenceIssues(runtime, planSpec)).map(
          (issue) => `计划阶段未完成：参考资料校验失败：${issue}`,
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reasons.push(`计划阶段未完成：artifacts.planSpec 不是合法 JSON：${message}`);
    }
  }

  reasons.push(...(await collectReferenceManifestIssues(runtime)).map(
    (issue) => `计划阶段未完成：参考资料校验失败：${issue}`,
  ));

  const interactionContractContents = await readIfExists(runtime.deepagentsInteractionContractPath);
  if (!interactionContractContents || interactionContractContents.trim().length === 0) {
    reasons.push("计划阶段未完成：artifacts.interactionContract 尚未落盘有效内容。");
  } else {
    try {
      const parsed = JSON.parse(interactionContractContents);
      const validation = validateInteractionContract(parsed);
      if (!validation.success) {
        reasons.push(...validation.issues.map((issue) => `计划阶段未完成：artifacts.interactionContract 校验失败：${issue}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reasons.push(`计划阶段未完成：artifacts.interactionContract 不是合法 JSON：${message}`);
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
  return await measureRuntimeStep(
    runtime,
    {
      name: "plan.validate_artifacts",
      phase: (runtime.planAttempt ?? 1) > 1 ? "plan_repair" : "plan",
      attempt: runtime.planAttempt ?? 1,
    },
    async () => {
      await persistStructuredPlanSpecFromResult(runtime, result);
      await persistStructuredInteractionContractFromResult(runtime, result);
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
    },
  );
}

function getRuntimeValidationForRuntime(runtime: TextGeneratorRuntime): TemplateRuntimeValidation {
  return runtime.templateRuntimeValidation ?? defaultTemplateRuntimeValidation();
}

function resolveRuntimeValidationMode(
  mode?: RuntimeValidationMode,
  runtime?: TextGeneratorRuntime,
): RuntimeValidationMode {
  return mode ?? (runtime?.templateInteractiveRuntimeValidation.enabled ? "interactive" : "non-interactive");
}

function shouldSkipRuntimeDevServerStepsForMode(
  mode?: RuntimeValidationMode,
  runtime?: TextGeneratorRuntime,
): boolean {
  return resolveRuntimeValidationMode(mode, runtime) !== "non-interactive";
}

function runtimeValidationModeOption(mode?: RuntimeValidationMode): { runtimeValidationMode?: RuntimeValidationMode } {
  return mode ? { runtimeValidationMode: mode } : {};
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

function resolveRuntimeDevServerStep(runtime: TextGeneratorRuntime): TemplateRuntimeValidationStep | undefined {
  return runtime.templateInteractiveRuntimeValidation.devServerStep ??
    getRuntimeValidationForRuntime(runtime).steps.find((step) => step.kind === "dev-server");
}

function createSkippedDevServerValidationSteps(runtime: TextGeneratorRuntime): GenerationValidationStep[] {
  return getRuntimeValidationForRuntime(runtime)
    .steps
    .filter((step) => step.kind === "dev-server")
    .map((step) => ({
      name: step.name,
      ok: true,
      detail: "已跳过：当前 validation 阶段由所选浏览器运行验证模式统一启动 dev server，不再单独启动 dev server。",
    }));
}

async function collectPersistedGeneratedValidation(
  outputDirectory: string,
  runtime: TextGeneratorRuntime,
  planSpec: PlanSpec,
  validator: GeneratedAppValidator,
  options: { skipRuntimeDevServerSteps?: boolean; runtimeValidationMode?: RuntimeValidationMode } = {},
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
  const environmentPolicyIssues = await reconcileHostManagedEnvironment(runtime, planSpec);
  const environmentIssues = await collectEnvironmentVariableIssues(outputDirectory, runtime, planSpec);
  const projectConfigIssues = await collectProjectConfigPolicyIssues(outputDirectory, runtime, planSpec);

  if (coverage.missingApiPaths.length > 0) {
    reasons.push(`生成阶段未完成：以下接口尚未落盘：${coverage.missingApiPaths.join(", ")}。`);
  }

  if (coverage.missingPageRoutes.length > 0) {
    reasons.push(`生成阶段未完成：以下页面尚未落盘：${coverage.missingPageRoutes.join(", ")}。`);
  }

  if (missingAcceptanceChecks.length > 0) {
    reasons.push(`生成阶段未完成：以下验收项对应的页面或接口尚未满足：${missingAcceptanceChecks.join(", ")}。`);
  }
  reasons.push(...environmentPolicyIssues, ...environmentIssues, ...projectConfigIssues);

  let steps: GenerationValidationStep[] = [];
  if (reasons.length === 0) {
    const skipRuntimeDevServerSteps =
      options.skipRuntimeDevServerSteps === true ||
      shouldSkipRuntimeDevServerStepsForMode(options.runtimeValidationMode, runtime);
    const validationRuntime = skipRuntimeDevServerSteps
      ? createRuntimeWithoutDevServerValidation(runtime)
      : runtime;
    const runtimeValidation = await validator.validate(outputDirectory, validationRuntime, planSpec);
    reasons.push(...runtimeValidation.reasons);
    steps = skipRuntimeDevServerSteps
      ? [
          ...runtimeValidation.steps,
          ...createSkippedDevServerValidationSteps(runtime),
        ]
      : runtimeValidation.steps;
    if (skipRuntimeDevServerSteps) {
      await appendRuntimeValidationLog(runtime.deepagentsRuntimeValidationLogPath, [
        "[skip] dev-server validation steps are owned by the selected browser runtime validation mode.",
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
  options: { skipRuntimeDevServerSteps?: boolean; runtimeValidationMode?: RuntimeValidationMode } = {},
): Promise<{ reasons: string[]; steps: GenerationValidationStep[] }> {
  return await measureRuntimeStep(
    runtime,
    {
      name: "generate.validate_artifacts",
      phase: (runtime.generateAttempt ?? 1) > 1 ? "generate_repair" : "generate",
      attempt: runtime.generateAttempt ?? 1,
      metadata: {
        skipRuntimeDevServerSteps:
          options.skipRuntimeDevServerSteps === true ||
          shouldSkipRuntimeDevServerStepsForMode(options.runtimeValidationMode, runtime),
        runtimeValidationMode: resolveRuntimeValidationMode(options.runtimeValidationMode, runtime),
      },
    },
    async () => {
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
      const environmentPolicyIssues = await reconcileHostManagedEnvironment(runtime, planSpec);
      const environmentIssues = await collectEnvironmentVariableIssues(outputDirectory, runtime, planSpec);
      const projectConfigIssues = await collectProjectConfigPolicyIssues(outputDirectory, runtime, planSpec);
      if (coverage.missingPageRoutes.length > 0) {
        reasons.push(`生成阶段未完成：以下页面尚未落盘：${coverage.missingPageRoutes.join(", ")}。`);
      }
      if (coverage.missingApiPaths.length > 0) {
        reasons.push(`生成阶段未完成：以下接口尚未落盘：${coverage.missingApiPaths.join(", ")}。`);
      }
      if (missingAcceptanceChecks.length > 0) {
        reasons.push(`生成阶段未完成：以下验收项对应的页面或接口尚未满足：${missingAcceptanceChecks.join(", ")}。`);
      }
      reasons.push(...environmentPolicyIssues, ...environmentIssues, ...projectConfigIssues);

      let steps: GenerationValidationStep[] = [];
      if (reasons.length === 0) {
        const skipRuntimeDevServerSteps =
          options.skipRuntimeDevServerSteps === true ||
          shouldSkipRuntimeDevServerStepsForMode(options.runtimeValidationMode, runtime);
        const validationRuntime = skipRuntimeDevServerSteps
          ? createRuntimeWithoutDevServerValidation(runtime)
          : runtime;
        const runtimeValidation = await validator.validate(outputDirectory, validationRuntime, planSpec);
        reasons.push(...runtimeValidation.reasons);
        steps = skipRuntimeDevServerSteps
          ? [
              ...runtimeValidation.steps,
              ...createSkippedDevServerValidationSteps(runtime),
            ]
          : runtimeValidation.steps;
        if (skipRuntimeDevServerSteps) {
          await appendRuntimeValidationLog(runtime.deepagentsRuntimeValidationLogPath, [
            "[skip] dev-server validation steps are owned by the selected browser runtime validation mode.",
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
    },
  );
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
  let templateEnvironmentPolicy = defaultTemplateEnvironmentPolicy();
  let templateProjectConfigPolicy = defaultTemplateProjectConfigPolicy();
  let persistedModelName: string | undefined;
  let persistedModelRoles: Partial<SanitizedModelRoleConfigMap> = {};
  let designArtifactRelativePath: string | undefined;

  const configContents = await readIfExists(configPath);
  if (configContents) {
    try {
      const parsed = JSON.parse(configContents) as {
        model?: unknown;
        models?: unknown;
        artifacts?: {
          design?: unknown;
        };
        template?: {
          id?: unknown;
          name?: unknown;
          version?: unknown;
          repairRetries?: unknown;
          phases?: unknown;
          runtimeValidation?: unknown;
          interactiveRuntimeValidation?: unknown;
          environmentPolicy?: unknown;
          projectConfigPolicy?: unknown;
        };
      };
      if (typeof parsed.model === "string" && parsed.model.trim() !== "") {
        persistedModelName = parsed.model.trim();
      }
      persistedModelRoles = parseSanitizedModelRoleConfigs(parsed.models);
      if (typeof parsed.artifacts?.design === "string" && parsed.artifacts.design.trim() !== "") {
        designArtifactRelativePath = normalizeRelativePath(parsed.artifacts.design);
      }
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
        const parsePhaseEffort = (value: unknown): { effort?: TemplatePhaseEffort } => {
          if (!value || typeof value !== "object" || Array.isArray(value)) {
            return {};
          }

          const candidate = value as { effort?: unknown };
          if (
            typeof candidate.effort === "string" &&
            (TEMPLATE_PHASE_EFFORTS as readonly string[]).includes(candidate.effort)
          ) {
            return { effort: candidate.effort as TemplatePhaseEffort };
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
      if (
        parsed.template?.environmentPolicy &&
        typeof parsed.template.environmentPolicy === "object" &&
        !Array.isArray(parsed.template.environmentPolicy)
      ) {
        const candidate = parsed.template.environmentPolicy as Partial<TemplateEnvironmentPolicy>;
        if (
          Array.isArray(candidate.lockedKeys) &&
          candidate.lockedKeys.every((key) => typeof key === "string" && key.trim() !== "")
        ) {
          templateEnvironmentPolicy = {
            lockedKeys: Array.from(new Set(candidate.lockedKeys.map((key) => key.trim()))),
          };
        }
      }
      if (
        parsed.template?.projectConfigPolicy &&
        typeof parsed.template.projectConfigPolicy === "object" &&
        !Array.isArray(parsed.template.projectConfigPolicy)
      ) {
        const candidate = parsed.template.projectConfigPolicy as Partial<TemplateProjectConfigPolicy>;
        if (
          Array.isArray(candidate.guardedFiles) &&
          candidate.guardedFiles.every((filePath) => typeof filePath === "string" && filePath.trim() !== "")
        ) {
          templateProjectConfigPolicy = {
            guardedFiles: Array.from(new Set(candidate.guardedFiles.map((filePath) => normalizeProjectConfigPath(filePath)))),
          };
        }
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
    deepagentsMetricsLogPath: path.join(deepagentsDirectory, "metrics.jsonl"),
    deepagentsRuntimeValidationLogPath: path.join(deepagentsDirectory, "runtime-validation.log"),
    deepagentsRuntimeInteractionValidationPath: path.join(deepagentsDirectory, "runtime-interaction-validation.json"),
    deepagentsInteractionContractPath: path.join(deepagentsDirectory, "interaction-contract.json"),
    deepagentsReferenceManifestPath: path.join(deepagentsDirectory, "references", "reference-manifest.json"),
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
    ...(designArtifactRelativePath ? { designPath: path.join(outputDirectory, designArtifactRelativePath) } : {}),
    maxPlanRetries: templateRepairRetries.plan,
    maxGenerateRetries: templateRepairRetries.generate,
    templatePhases,
    templateRuntimeValidation,
    templateInteractiveRuntimeValidation,
    templateEnvironmentPolicy,
    templateProjectConfigPolicy,
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
        ...(options.artifact.completionMode ? { completionMode: options.artifact.completionMode } : {}),
        coverageSatisfied: options.artifact.coverageSatisfied,
        criticalUncoveredTargets: options.artifact.criticalUncoveredTargets,
        ...(options.artifact.implementationRequest
          ? { implementationRequest: options.artifact.implementationRequest.requirement }
          : {}),
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
      phase: "validation",
      effort: undefined,
    },
    ...(runtimeInteraction ? { runtimeInteraction } : {}),
  });
}

async function markWorkflowComplete(runtime: TextGeneratorRuntime, completedPhases: Array<"plan" | "generate" | "validation">): Promise<void> {
  await updateWorkflowState(runtime.deepagentsConfigPath, "complete", completedPhases);
  await showCompletedWorkflowBoard(runtime.sessionId, runtime.outputDirectory);
  await appendWorkflowLog("[host] 全部阶段完成，准备汇总输出。");
}

async function completeAfterGenerateValidation(options: {
  runtime: TextGeneratorRuntime;
  generator?: TextGenerator;
  validator: GeneratedAppValidator;
  approvedPlan: PlanSpec;
  skipValidation?: boolean;
  runtimeValidationMode?: RuntimeValidationMode;
}): Promise<void> {
  if (options.skipValidation) {
    await measureRuntimeStep(
      options.runtime,
      {
        name: "validation.skip",
        phase: "validation",
        metadata: { reason: "--skip-validation" },
      },
      async () => {
        await appendWorkflowLog("[host] 已按 --skip-validation 跳过 validation 阶段。");
        await markWorkflowComplete(options.runtime, ["plan", "generate"]);
      },
    );
    return;
  }

  const runtimeValidationMode = resolveRuntimeValidationMode(options.runtimeValidationMode, options.runtime);
  if (runtimeValidationMode === "non-interactive") {
    await measureRuntimeStep(
      options.runtime,
      {
        name: "validation.non_interactive_complete",
        phase: "validation",
        metadata: { runtimeValidationMode },
      },
      async () => await markWorkflowComplete(options.runtime, ["plan", "generate"]),
    );
    return;
  }

  if (runtimeValidationMode === "interactive" && !options.runtime.templateInteractiveRuntimeValidation.enabled) {
    throw new Error("Interactive runtime validation was requested, but template.interactiveRuntimeValidation.enabled=false.");
  }
  const smokeDevServerStep = runtimeValidationMode === "smoke"
    ? resolveRuntimeDevServerStep(options.runtime)
    : undefined;
  if (runtimeValidationMode === "smoke" && !smokeDevServerStep) {
    throw new Error("Smoke runtime validation was requested, but template.runtimeValidation.steps has no dev-server step.");
  }

  let retryReasons: string[] = [];
  const maxGenerationRepairs = options.runtime.maxGenerateRetries ?? 0;
  const maxRuntimeInteractionRepairs = Math.max(maxGenerationRepairs, 1);
  const runtimeInteractionSession: RuntimeInteractionValidationSession = {};
  let validationAttempt = 0;

  try {
    while (true) {
      if (retryReasons.length === 0) {
        validationAttempt += 1;
        await updateWorkflowState(options.runtime.deepagentsConfigPath, "validation", ["plan", "generate"]);
        await appendWorkflowLog(
          runtimeValidationMode === "smoke"
            ? "[host] 进入运行验证阶段，启动 dev server，并用 Playwright/Chromium 静默渲染计划页面。"
            : "[host] 进入运行验证阶段，启动或复用 dev server，并启动本地请求代理，合并监听 HTTP 响应与 stdout/stderr。",
        );
        await updateRuntimeValidationWorkflowBoard({
          runtime: options.runtime,
          narrative: runtimeValidationMode === "smoke"
            ? "正在启动浏览器冒烟运行验证。"
            : "正在启动交互式运行验证。",
          lifecycle: "generating",
        });

        const validation = await measureRuntimeStep(
          options.runtime,
          {
            name: runtimeValidationMode === "smoke" ? "validation.smoke_runtime" : "validation.interactive_runtime",
            phase: "validation",
            attempt: validationAttempt,
            metadata: {
              runtimeValidationMode,
              coverageThreshold: options.runtime.templateInteractiveRuntimeValidation.coverageThreshold,
              idleTimeoutMs: options.runtime.templateInteractiveRuntimeValidation.idleTimeoutMs,
              readyTimeoutMs: options.runtime.templateInteractiveRuntimeValidation.readyTimeoutMs,
            },
          },
          async () => runtimeValidationMode === "smoke"
            ? await runSmokeRuntimeValidation({
                runtime: options.runtime,
                planSpec: options.approvedPlan,
                devServerStep: smokeDevServerStep!,
                readyTimeoutMs: options.runtime.templateInteractiveRuntimeValidation.readyTimeoutMs,
              })
            : await runInteractiveRuntimeValidation({
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
                      phase: "validation",
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
                      ...(update.implementationRequest ? { implementationRequest: update.implementationRequest.requirement } : {}),
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
              }),
        );

        if (validation.reasons.length === 0) {
          await appendWorkflowLog("[host] 运行验证阶段通过。");
          await updateRuntimeValidationWorkflowBoard({
            runtime: options.runtime,
            artifact: validation.artifact,
            narrative: "运行验证阶段已通过。",
            lifecycle: "verified",
          });
          await markWorkflowComplete(options.runtime, ["plan", "generate", "validation"]);
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
        await closeRuntimeInteractionValidationSession(runtimeInteractionSession);
        await appendWorkflowLog("[host] 已停止失败的运行验证 dev server，修复后将重新启动。");
      }

      const existingRuntimeRepairAttempts = await countRetryAttempts(
        options.runtime.deepagentsErrorLogPath,
        "运行验证修复阶段",
      );
      if (existingRuntimeRepairAttempts >= maxRuntimeInteractionRepairs) {
        throw new Error(`Runtime interaction validation failed: ${retryReasons.join(" | ")}`);
      }
      const repairAttempt = existingRuntimeRepairAttempts + 1;
      const generateAttempt = repairAttempt + 1;

      await updateWorkflowState(options.runtime.deepagentsConfigPath, "validation", ["plan", "generate"]);
      await appendRetryNote(
        options.runtime.deepagentsErrorLogPath,
        repairAttempt,
        "运行验证修复阶段",
        retryReasons,
      );
      await appendWorkflowLog(`[host] 运行验证触发生成修复轮次 ${repairAttempt}。`);

      const repairRuntime = createSessionRuntime(options.runtime, {
        generateAttempt,
        retryReasons,
      });
      const generator = requireSessionGenerator(options.runtime, options.generator);
      let repairedProject: GeneratedProject;
      try {
        repairedProject = await measureRuntimeStep(
          repairRuntime,
          {
            name: "validation.generate_repair_project",
            phase: "validation",
            attempt: repairAttempt,
            metadata: { retryReasonCount: retryReasons.length },
          },
          async () =>
            await runWithStructuredResponseRetry(
              repairRuntime,
              "生成修复阶段",
              async () => await generator.generateRepairProject(options.approvedPlan, repairRuntime),
            ),
        );
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
        await appendWorkflowLog(
          runtimeValidationMode === "smoke"
            ? "[host] 运行验证修复后的生成门禁通过，继续浏览器冒烟验证。"
            : "[host] 运行验证修复后的生成门禁通过，继续交互式监听。",
        );
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
  skipValidation?: boolean;
  runtimeValidationMode?: RuntimeValidationMode;
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
      generatedProject = await measureRuntimeStep(
        initialRuntime,
        { name: initialGenerateMetricName(options.generator), phase: "generate", attempt: 1 },
        async () => await runWithStructuredResponseRetry(
          initialRuntime,
          "生成阶段",
          async () => await runInitialGenerateProject(options.generator, options.approvedPlan, initialRuntime),
        ),
      );
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
      runtimeValidationModeOption(options.runtimeValidationMode),
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
        ...(options.skipValidation ? { skipValidation: true } : {}),
        ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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
      repairedProject = await measureRuntimeStep(
        repairRuntime,
        {
          name: "generate.repair_project",
          phase: "generate_repair",
          attempt: existingRepairAttempts + repairIndex + 1,
          metadata: { retryReasonCount: generationRetryReasons.length },
        },
        async () => await runWithStructuredResponseRetry(
          repairRuntime,
          "生成修复阶段",
          async () => await options.generator.generateRepairProject(options.approvedPlan, repairRuntime),
        ),
      );
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
      runtimeValidationModeOption(options.runtimeValidationMode),
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
        ...(options.skipValidation ? { skipValidation: true } : {}),
        ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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
  skipValidation?: boolean;
  runtimeValidationMode?: RuntimeValidationMode;
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
    const repairResult = await measureRuntimeStep(
      repairRuntime,
      {
        name: "plan.repair_project",
        phase: "plan_repair",
        attempt: existingRepairAttempts + repairIndex + 1,
        metadata: { retryReasonCount: planRetryReasons.length },
      },
      async () => await runWithStructuredResponseRetry(
        repairRuntime,
        "计划修复阶段",
        async () => await options.generator.planRepairProject(repairRuntime),
      ),
    );
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
    ...(options.skipValidation ? { skipValidation: true } : {}),
    ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
  });
}

export async function validateSessionPhase(options: {
  sessionId: string;
  phase?: ValidationPhase;
  cwd?: string;
  stdoutMode?: StdoutMode;
  skipValidation?: boolean;
  runtimeValidationMode?: RuntimeValidationMode;
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
            ...(options.skipValidation ? { skipValidation: true } : {}),
            ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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

    if (phase === "runtimeValidation") {
      await updateWorkflowState(runtime.deepagentsConfigPath, "validation", ["plan", "generate"]);
      await updateRuntimeValidationWorkflowBoard({
        runtime,
        narrative: "按 runtimeValidation 参数进入运行验证阶段，正在执行生成门禁与运行验证。",
        lifecycle: "validating",
      });
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
        runtimeValidationModeOption(options.runtimeValidationMode),
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
          ...(options.skipValidation ? { skipValidation: true } : {}),
          ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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
        validationPath: phase === "runtimeValidation"
          ? runtime.deepagentsRuntimeInteractionValidationPath
          : runtime.deepagentsGenerationValidationPath,
        runtimeValidationLogPath: runtime.deepagentsRuntimeValidationLogPath,
        runtimeInteractionValidationPath: runtime.deepagentsRuntimeInteractionValidationPath,
        workflowPhase: "complete",
        resumedFromPhase: "generate_repair",
      };
    }

    if (
      (
        phase === "runtimeValidation" ||
        runtime.templateInteractiveRuntimeValidation.enabled
      ) &&
      planValidation.planSpec &&
      (
        phase === "runtimeValidation" ||
        persistedWorkflowPhase !== "complete"
      )
    ) {
      try {
        await completeAfterGenerateValidation({
          runtime,
          ...(options.generator ? { generator: options.generator } : {}),
          validator,
          approvedPlan: planValidation.planSpec,
          ...(options.skipValidation ? { skipValidation: true } : {}),
          ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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
      validationPath: phase === "runtimeValidation"
        ? runtime.deepagentsRuntimeInteractionValidationPath
        : runtime.deepagentsGenerationValidationPath,
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
  skipValidation?: boolean;
  runtimeValidationMode?: RuntimeValidationMode;
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
            ...(options.skipValidation ? { skipValidation: true } : {}),
            ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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
          ...(options.skipValidation ? { skipValidation: true } : {}),
          ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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
      ...(options.skipValidation ? { skipValidation: true } : {}),
      ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
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
    persistedPhase === "validation" ||
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
    if (phase === "runtime_validation" || phase === "runtimeValidation") {
      return "validation";
    }
    return phase === "plan" ||
      phase === "plan_repair" ||
      phase === "generate" ||
      phase === "generate_repair" ||
      phase === "validation" ||
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

function supportsParallelPrdAssembly(
  generator: TextGenerator,
): generator is TextGenerator & Required<Pick<TextGenerator, "analyzePrd" | "assemblePlanProject">> {
  return typeof generator.analyzePrd === "function" && typeof generator.assemblePlanProject === "function";
}

function supportsParallelGeneration(
  generator: TextGenerator,
): generator is TextGenerator & Required<Pick<TextGenerator, "generateProjectWithParallelAgents">> {
  return typeof generator.generateProjectWithParallelAgents === "function";
}

async function runInitialGenerateProject(
  generator: TextGenerator,
  approvedPlan: PlanSpec,
  runtime: TextGeneratorRuntime,
): Promise<GeneratedProject> {
  return supportsParallelGeneration(generator)
    ? await generator.generateProjectWithParallelAgents(approvedPlan, runtime)
    : await generator.generateProject(approvedPlan, runtime);
}

function initialGenerateMetricName(generator: TextGenerator): string {
  return supportsParallelGeneration(generator)
    ? "generate.parallel_project"
    : "generate.project";
}

export async function generateApplication(options: GenerateAppOptions): Promise<GenerationResult> {
  setWorkflowStdoutMode(options.stdoutMode);
  try {
    const designSourcePath = options.designPath
      ? await resolveDesignDocumentSourcePath(options.designPath)
      : undefined;
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

    const prepareStartedAt = new Date();
    const prepareStartedHr = process.hrtime.bigint();
    const workspace = await prepareOutputWorkspace(workspaceOptions);
    await appendWorkflowMetricRecord(
      workspace.deepagentsMetricsLogPath,
      buildWorkflowMetricRecord({
        sessionId: workspace.sessionId,
        metric: {
          name: "workspace.prepare",
          phase: "workspace",
          metadata: {
            outputDirectory: workspace.outputDirectory,
            force: workspaceOptions.force === true,
          },
        },
        status: "success",
        startedAt: prepareStartedAt,
        completedAt: new Date(),
        startedHr: prepareStartedHr,
      }),
    );
    await showPreparationWorkflowBoard({
      sessionId: workspace.sessionId,
      outputDirectory: workspace.outputDirectory,
      activeStep: "workspace",
      narrative: "正在准备输出工作区、加载模板并初始化生成看板。",
    });
    await appendWorkflowLog("[host] 已创建输出工作区，开始加载模板与读取 PRD。");
    const template = await measureWorkflowStep(
      workspace.deepagentsMetricsLogPath,
      workspace.sessionId,
      {
        name: "template.load",
        phase: "template",
        metadata: { templateId: options.templateId ?? "default" },
      },
      async () => await loadTemplatePack(options.templateId),
    );
    const templateLock = await measureWorkflowStep(
      workspace.deepagentsMetricsLogPath,
      workspace.sessionId,
      {
        name: "template.stage",
        phase: "template",
        metadata: { templateId: template.id, templateVersion: template.version },
      },
      async () => await stageTemplatePack(template, workspace),
    );

    const sourceMarkdown = await measureWorkflowStep(
      workspace.deepagentsMetricsLogPath,
      workspace.sessionId,
      {
        name: "spec.read_source",
        phase: "spec",
        metadata: { specPath: path.resolve(options.specPath) },
      },
      async () => await fs.readFile(options.specPath, "utf8"),
    );
    const parsed = await measureWorkflowStep(
      workspace.deepagentsMetricsLogPath,
      workspace.sessionId,
      { name: "spec.parse_prd", phase: "spec" },
      async () => parsePrd(sourceMarkdown),
    );
    await measureWorkflowStep(
      workspace.deepagentsMetricsLogPath,
      workspace.sessionId,
      { name: "spec.snapshot_source", phase: "spec" },
      async () => await fs.writeFile(workspace.sourcePrdSnapshotPath, sourceMarkdown, "utf8"),
    );
    await showPreparationWorkflowBoard({
      sessionId: workspace.sessionId,
      outputDirectory: workspace.outputDirectory,
      activeStep: "input",
      narrative: "已读取 PRD 与模板上下文，正在准备模型输入。",
    });
    const modelRoles = resolveModelRoleConfigs(process.env, {
      requireApiKeys: options.generator ? false : true,
    });
    const generator =
      options.generator ??
      new DeepAgentsTextGenerator({ modelRoles });
    const validator =
      options.validator ??
      (options.generator ? new PassthroughGeneratedAppValidator() : new ShellGeneratedAppValidator());
    let localReferences: LocalReference[] = [];
    let designArtifactRelativePath: string | undefined;

    const createRuntime = (overrides: Partial<TextGeneratorRuntime> = {}): TextGeneratorRuntime => ({
      sessionId: workspace.sessionId,
      outputDirectory: workspace.outputDirectory,
      deepagentsDirectory: workspace.deepagentsDirectory,
      deepagentsAgentsPath: workspace.deepagentsAgentsPath,
      deepagentsLogPath: workspace.deepagentsLogPath,
      deepagentsErrorLogPath: workspace.deepagentsErrorLogPath,
      deepagentsMetricsLogPath: workspace.deepagentsMetricsLogPath,
      deepagentsRuntimeValidationLogPath: workspace.deepagentsRuntimeValidationLogPath,
      deepagentsRuntimeInteractionValidationPath: workspace.deepagentsRuntimeInteractionValidationPath,
      deepagentsInteractionContractPath: workspace.deepagentsInteractionContractPath,
      deepagentsReferenceManifestPath: workspace.deepagentsReferenceManifestPath,
      localReferences,
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
      ...(designArtifactRelativePath
        ? { designPath: path.join(workspace.outputDirectory, designArtifactRelativePath) }
        : {}),
      maxPlanRetries: template.repairRetries.plan,
      maxGenerateRetries: template.repairRetries.generate,
      templatePhases: template.phases,
      templateRuntimeValidation: template.runtimeValidation,
      templateInteractiveRuntimeValidation: template.interactiveRuntimeValidation,
      templateEnvironmentPolicy: template.environmentPolicy,
      templateProjectConfigPolicy: template.projectConfigPolicy,
      modelRoles,
      ...overrides,
    });

    const referenceCandidates = await measureWorkflowStep(
      workspace.deepagentsMetricsLogPath,
      workspace.sessionId,
      { name: "spec.extract_external_references", phase: "spec" },
      async () => extractExternalReferenceDrafts(parsed),
    );
    const useParallelPrdAssembly = supportsParallelPrdAssembly(generator);
    let spec: NormalizedSpec;

    const preparePlanningWorkspace = async (appName: string): Promise<void> => {
      await measureWorkflowStep(
        workspace.deepagentsMetricsLogPath,
        workspace.sessionId,
        {
          name: "workspace.copy_starter",
          phase: "workspace",
          metadata: { templateId: template.id },
        },
        async () => await copyStarterScaffold(template, workspace.outputDirectory),
      );
      await measureWorkflowStep(
        workspace.deepagentsMetricsLogPath,
        workspace.sessionId,
        {
          name: "workspace.snapshot_starter_env",
          phase: "workspace",
          metadata: { templateId: template.id },
        },
        async () => await snapshotStarterEnvExample(workspace.outputDirectory, workspace.deepagentsDirectory),
      );
      await measureWorkflowStep(
        workspace.deepagentsMetricsLogPath,
        workspace.sessionId,
        {
          name: "workspace.snapshot_project_config",
          phase: "workspace",
          metadata: { templateId: template.id },
        },
        async () => await snapshotStarterProjectConfigFiles(
          workspace.outputDirectory,
          workspace.deepagentsDirectory,
          template.projectConfigPolicy,
        ),
      );

      if (designSourcePath) {
        designArtifactRelativePath = await measureWorkflowStep(
          workspace.deepagentsMetricsLogPath,
          workspace.sessionId,
          {
            name: "workspace.copy_design",
            phase: "workspace",
            metadata: {
              sourcePath: designSourcePath,
              targetPath: DESIGN_ARTIFACT_RELATIVE_PATH,
            },
          },
          async () => await copyDesignDocumentToWorkspace(designSourcePath, workspace.outputDirectory),
        );
      }

      await measureWorkflowStep(
        workspace.deepagentsMetricsLogPath,
        workspace.sessionId,
        { name: "workspace.write_config", phase: "workspace" },
        async () => await writeDeepagentsConfig(workspace, {
          sessionId: workspace.sessionId,
          startedAt: new Date().toISOString(),
          appName,
          model: modelRoles.plan.modelName,
          models: sanitizeModelRoleConfigs(modelRoles),
          workflow: {
            phase: "plan",
            completedPhases: [],
          },
          artifacts: {
            sourcePrd: ".deepagents/source-prd.md",
            ...(designArtifactRelativePath ? { design: designArtifactRelativePath } : {}),
            analysis: ".deepagents/prd-analysis.md",
            generatedSpec: ".deepagents/generated-spec.md",
            planSpec: ".deepagents/plan-spec.json",
            interactionContract: ".deepagents/interaction-contract.json",
            referenceManifest: ".deepagents/references/reference-manifest.json",
            planValidation: ".deepagents/plan-validation.json",
            generationValidation: ".deepagents/generation-validation.json",
            runtimeValidationLog: ".deepagents/runtime-validation.log",
            runtimeInteractionValidation: ".deepagents/runtime-interaction-validation.json",
            metricsLog: ".deepagents/metrics.jsonl",
            errorLog: ".deepagents/error.log",
          },
          prompts: {
            plan: ".deepagents/plan-system-prompt.md",
            planRepair: ".deepagents/plan-repair-system-prompt.md",
            generate: ".deepagents/generate-system-prompt.md",
            generateRepair: ".deepagents/generate-repair-system-prompt.md",
          },
          template: templateLock,
        }),
      );
      await measureRuntimeStep(
        createRuntime(),
        { name: "workspace.materialize_prompt_snapshots", phase: "workspace" },
        async () => await materializeSessionPromptSnapshots(createRuntime()),
      );
    };

    if (useParallelPrdAssembly) {
      spec = await measureWorkflowStep(
        workspace.deepagentsMetricsLogPath,
        workspace.sessionId,
        {
          name: "spec.normalize",
          phase: "spec",
          metadata: {
            appNameOverride: options.appNameOverride ?? null,
            localReferenceCount: 0,
          },
        },
        async () => normalizeSpec(parsed, sourceMarkdown, options.appNameOverride, []),
      );
      await preparePlanningWorkspace(spec.appName);
      await showPreparationWorkflowBoard({
        sessionId: workspace.sessionId,
        outputDirectory: workspace.outputDirectory,
        activeStep: "references",
        narrative: "正在并行本地化 PRD 外部参考资料，并启动 PRD 分析阶段。",
      });

      const analysisRuntime = createRuntime({
        planAttempt: 1,
        retryReasons: [],
      });
      const referenceResolution = measureRuntimeStep(
        createRuntime(),
        {
          name: "references.resolve_external",
          phase: "references",
          metadata: { candidateCount: referenceCandidates.length, parallelWith: "plan.prd_analysis" },
        },
        async () => await resolveExternalReferences(createRuntime(), referenceCandidates, generator),
      );
      const prdAnalysis = runInitialPrdAnalysisPipeline(
        generator,
        spec,
        analysisRuntime,
        { parallelWith: "references.resolve_external" },
      );

      const [resolvedReferences] = await Promise.all([referenceResolution, prdAnalysis]);
      localReferences = resolvedReferences;
      spec = await measureWorkflowStep(
        workspace.deepagentsMetricsLogPath,
        workspace.sessionId,
        {
          name: "spec.normalize_with_references",
          phase: "spec",
          metadata: {
            appNameOverride: options.appNameOverride ?? null,
            localReferenceCount: localReferences.length,
          },
        },
        async () => normalizeSpec(parsed, sourceMarkdown, options.appNameOverride, localReferences),
      );
    } else {
      await showPreparationWorkflowBoard({
        sessionId: workspace.sessionId,
        outputDirectory: workspace.outputDirectory,
        activeStep: "references",
        narrative: "正在本地化 PRD 分析阶段识别出的外部参考资料。",
      });
      localReferences = await measureRuntimeStep(
        createRuntime(),
        {
          name: "references.resolve_external",
          phase: "references",
          metadata: { candidateCount: referenceCandidates.length },
        },
        async () => await resolveExternalReferences(createRuntime(), referenceCandidates, generator),
      );

      spec = await measureWorkflowStep(
        workspace.deepagentsMetricsLogPath,
        workspace.sessionId,
        {
          name: "spec.normalize",
          phase: "spec",
          metadata: {
            appNameOverride: options.appNameOverride ?? null,
            localReferenceCount: localReferences.length,
          },
        },
        async () => normalizeSpec(parsed, sourceMarkdown, options.appNameOverride, localReferences),
      );
      await preparePlanningWorkspace(spec.appName);
    }

    await showPreparationWorkflowBoard({
      sessionId: workspace.sessionId,
      outputDirectory: workspace.outputDirectory,
      activeStep: "model",
      narrative: "准备工作已完成，等待模型开始计划阶段。",
    });

    const maxPlanRepairs = template.repairRetries.plan;
    const maxGenerationRepairs = template.repairRetries.generate;

    let approvedPlan: PlanSpec | null = null;
    let planRetryReasons: string[] = [];

    {
      const initialRuntime = createRuntime({
        planAttempt: 1,
        retryReasons: [],
      });
      let planResult: PlanResult;
      try {
        planResult = await measureRuntimeStep(
          initialRuntime,
          { name: useParallelPrdAssembly ? "plan.prd_assembly" : "plan.project", phase: "plan", attempt: 1 },
          async () => await runWithStructuredResponseRetry(
            initialRuntime,
            "计划阶段",
            async () => useParallelPrdAssembly
              ? await generator.assemblePlanProject(spec, initialRuntime)
              : await generator.planProject(spec, initialRuntime),
          ),
        );
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
        repairResult = await measureRuntimeStep(
          repairRuntime,
          {
            name: "plan.repair_project",
            phase: "plan_repair",
            attempt: repairIndex + 1,
            metadata: { retryReasonCount: planRetryReasons.length },
          },
          async () => await runWithStructuredResponseRetry(
            repairRuntime,
            "计划修复阶段",
            async () => await generator.planRepairProject(repairRuntime),
          ),
        );
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
      await materializeGenerationPromptSnapshot(initialRuntime, approvedPlan, "generate");
      let generatedProject: GeneratedProject;
      try {
        generatedProject = await measureRuntimeStep(
          initialRuntime,
          { name: initialGenerateMetricName(generator), phase: "generate", attempt: 1 },
          async () => await runWithStructuredResponseRetry(
            initialRuntime,
            "生成阶段",
            async () => await runInitialGenerateProject(generator, approvedPlan, initialRuntime),
          ),
        );
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
        runtimeValidationModeOption(options.runtimeValidationMode),
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
      await materializeGenerationPromptSnapshot(repairRuntime, approvedPlan, "generate_repair");
      let repairedProject: GeneratedProject;
      try {
        repairedProject = await measureRuntimeStep(
          repairRuntime,
          {
            name: "generate.repair_project",
            phase: "generate_repair",
            attempt: repairIndex + 1,
            metadata: { retryReasonCount: generationRetryReasons.length },
          },
          async () => await runWithStructuredResponseRetry(
            repairRuntime,
            "生成修复阶段",
            async () => await generator.generateRepairProject(approvedPlan, repairRuntime),
          ),
        );
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
        runtimeValidationModeOption(options.runtimeValidationMode),
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
      ...(options.skipValidation ? { skipValidation: true } : {}),
      ...(options.runtimeValidationMode ? { runtimeValidationMode: options.runtimeValidationMode } : {}),
    });

    const outputDirectory = workspace.outputDirectory;
    const writtenFiles = await measureWorkflowStep(
      workspace.deepagentsMetricsLogPath,
      workspace.sessionId,
      { name: "workspace.collect_generated_files", phase: "workspace" },
      async () => await collectGeneratedFiles(outputDirectory),
    );

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
