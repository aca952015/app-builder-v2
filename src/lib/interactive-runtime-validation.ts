import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  request as httpRequest,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { PlanSpec } from "./plan-spec.js";
import type {
  GenerationValidationStep,
  TemplateInteractiveRuntimeValidation,
  TemplateRuntimeValidationStep,
  TextGeneratorRuntime,
} from "./types.js";

type RuntimeInteractionTargetKind = "page" | "api";

export type RuntimeInteractionTarget = {
  id: string;
  kind: RuntimeInteractionTargetKind;
  method: string;
  path: string;
  label: string;
  source: string;
};

export type RuntimeInteractionRequestRecord = {
  timestamp: string;
  method: string;
  path: string;
  status?: number;
  targetId?: string;
  targetLabel?: string;
  counted: boolean;
  errorSummary?: string;
};

export type RuntimeInteractionCoverageSummary = {
  ratio: number;
  covered: number;
  total: number;
  coveredTargets: string[];
  uncoveredTargets: string[];
};

export type RuntimeInteractionValidationArtifact = {
  valid: boolean;
  reasons: string[];
  proxyUrl?: string;
  devServerUrl?: string;
  browserOpenAttempted?: boolean;
  browserOpened?: boolean;
  browserOpenError?: string;
  devServerOutputSummary?: string;
  detectedDevServerError?: string;
  recentDevServerOutput?: string[];
  startedAt: string;
  completedAt?: string;
  coverageThreshold: number;
  idleTimeoutMs: number;
  readyTimeoutMs: number;
  coverage: RuntimeInteractionCoverageSummary;
  recentRequests: RuntimeInteractionRequestRecord[];
};

export type RuntimeInteractionValidationResult = {
  reasons: string[];
  steps: GenerationValidationStep[];
  artifact: RuntimeInteractionValidationArtifact;
};

type RuntimeInteractionRecordInput = {
  method: string;
  path: string;
  status?: number;
  errorSummary?: string;
};

type RuntimeInteractionReadyInfo = {
  proxyUrl?: string;
  devServerUrl: string;
  browserOpenAttempted?: boolean;
  browserOpened?: boolean;
  browserOpenError?: string;
  targets: RuntimeInteractionTarget[];
};

type RuntimeInteractionUpdate = {
  proxyUrl?: string;
  devServerUrl: string;
  browserOpenAttempted?: boolean;
  browserOpened?: boolean;
  browserOpenError?: string;
  coverage: RuntimeInteractionCoverageSummary;
  recentRequests: RuntimeInteractionRequestRecord[];
  recentDevServerOutput: string[];
};

export type BrowserOpenResult = {
  attempted: boolean;
  opened: boolean;
  error?: string;
};

const MAX_RECORDED_REQUESTS = 100;
const REQUEST_POLL_INTERVAL_MS = 200;
const MAX_DEV_SERVER_OUTPUT_CHARS = 40_000;

const DEV_SERVER_ERROR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bfailed to compile\b/i, label: "编译失败" },
  { pattern: /\bcompilation failed\b/i, label: "编译失败" },
  { pattern: /\bbuild failed\b/i, label: "构建失败" },
  { pattern: /\bmodule not found\b/i, label: "模块缺失" },
  { pattern: /\bsyntax\s*error\b/i, label: "语法错误" },
  { pattern: /\bunhandled(?: runtime)? error\b/i, label: "未处理运行时错误" },
  { pattern: /\bruntime error\b/i, label: "运行时错误" },
  { pattern: /\b(?:TypeError|ReferenceError|RangeError|EvalError|URIError):/i, label: "运行时异常" },
  { pattern: /^⨯\s+/, label: "Next.js 错误输出" },
  { pattern: /\berror:\s+(?!.*\b(?:ready|started|compiled|listening)\b)/i, label: "错误输出" },
];

const DISABLED_OPEN_BROWSER_VALUES = new Set(["0", "false", "no", "off"]);
const ENABLED_OPEN_BROWSER_VALUES = new Set(["1", "true", "yes", "on"]);

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

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSpawnCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.platform !== "win32") {
    return command;
  }

  if (command.includes("/") || command.includes("\\") || /\.[^\\/]+$/.test(command)) {
    return command;
  }

  const pathExt = readEnvCaseInsensitive(env, "PATHEXT");
  const extensions = (pathExt ? pathExt.split(";") : [".COM", ".EXE", ".BAT", ".CMD"])
    .map((entry) => entry.trim())
    .filter(Boolean);
  const searchDirectories = (readEnvCaseInsensitive(env, "PATH") ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const directory of searchDirectories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

async function appendRuntimeValidationLog(logPath: string, lines: string[]): Promise<void> {
  await fs.appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
}

async function reserveFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
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

function resolveDefaultBrowserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

async function openUrlInDefaultBrowser(url: string): Promise<BrowserOpenResult> {
  const { command, args } = resolveDefaultBrowserCommand(url);

  return await new Promise<BrowserOpenResult>((resolve) => {
    const browserProcess = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    let settled = false;

    browserProcess.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        attempted: true,
        opened: false,
        error: errorSummary(error),
      });
    });

    browserProcess.once("spawn", () => {
      if (settled) {
        return;
      }
      settled = true;
      browserProcess.unref();
      resolve({
        attempted: true,
        opened: true,
      });
    });
  });
}

function shouldOpenBrowser(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) {
    return explicit;
  }

  const configured = process.env.APP_BUILDER_OPEN_BROWSER?.trim().toLowerCase();
  if (configured && DISABLED_OPEN_BROWSER_VALUES.has(configured)) {
    return false;
  }
  if (configured && ENABLED_OPEN_BROWSER_VALUES.has(configured)) {
    return true;
  }

  return process.stdout.isTTY === true && process.env.CI !== "true";
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

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function recentOutputLines(output: string, limit = 12): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .slice(-limit);
}

function detectDevServerOutputFailure(output: string): string | undefined {
  for (const line of recentOutputLines(output, 24)) {
    const matchedPattern = DEV_SERVER_ERROR_PATTERNS.find(({ pattern }) => pattern.test(line));
    if (matchedPattern) {
      return `开发服务器 stdout/stderr 检测到${matchedPattern.label}：${line}`;
    }
  }

  return undefined;
}

async function spawnDevServer(options: {
  step: TemplateRuntimeValidationStep;
  cwd: string;
  port: number;
}): Promise<ChildProcess> {
  const env = {
    ...process.env,
    ...options.step.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(options.port),
  };
  const resolvedCommand = await resolveSpawnCommand(options.step.command, env);

  return spawn(resolvedCommand, options.step.args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function pingDevServer(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const req = httpRequest(
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

function normalizeRoutePath(route: string): string {
  const withoutQuery = route.split("?")[0] ?? route;
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const trimmed = withLeadingSlash.replace(/\/+$/g, "");
  return trimmed === "" ? "/" : trimmed;
}

function routeSegments(route: string): string[] {
  const normalized = normalizeRoutePath(route);
  if (normalized === "/") {
    return [];
  }
  return normalized.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

function isDynamicSegment(segment: string): boolean {
  return (
    (/^\[[^.[\]]+\]$/.test(segment) && !segment.startsWith("[...")) ||
    (/^:[A-Za-z0-9_]+$/.test(segment))
  );
}

function isCatchAllSegment(segment: string): boolean {
  return (
    /^\[\.\.\.[^.[\]]+\]$/.test(segment) ||
    /^:[A-Za-z0-9_][A-Za-z0-9_]*[+*]$/.test(segment)
  );
}

function matchSegments(pattern: string[], actual: string[]): boolean {
  if (pattern.length === 0) {
    return actual.length === 0;
  }

  const [patternHead, ...patternTail] = pattern;
  if (!patternHead) {
    return actual.length === 0;
  }

  if (isCatchAllSegment(patternHead)) {
    if (patternHead.endsWith("*") && actual.length === 0) {
      return matchSegments(patternTail, actual);
    }
    return actual.length > 0;
  }

  const [actualHead, ...actualTail] = actual;
  if (!actualHead) {
    return false;
  }

  if (isDynamicSegment(patternHead)) {
    return matchSegments(patternTail, actualTail);
  }

  return patternHead === actualHead && matchSegments(patternTail, actualTail);
}

function routeMatches(pattern: string, actualPath: string): boolean {
  return matchSegments(routeSegments(pattern), routeSegments(actualPath));
}

export function apiFilePathToHttpPath(apiFilePath: string): string {
  const normalized = apiFilePath.replace(/^\/+/, "");
  const withoutPrefix = normalized.replace(/^app\/api\//, "");
  const withoutRouteFile = withoutPrefix.replace(/\/route\.ts$/, "");
  return normalizeRoutePath(`/api/${withoutRouteFile}`);
}

export function buildRuntimeInteractionTargets(planSpec: PlanSpec): RuntimeInteractionTarget[] {
  const targets = new Map<string, RuntimeInteractionTarget>();

  for (const page of planSpec.pages) {
    const path = normalizeRoutePath(page.route);
    const id = `page:${path}`;
    if (targets.has(id)) {
      continue;
    }
    targets.set(id, {
      id,
      kind: "page",
      method: "GET",
      path,
      label: `GET ${path}`,
      source: page.route,
    });
  }

  for (const api of planSpec.apis) {
    const path = apiFilePathToHttpPath(api.path);
    for (const method of api.methods) {
      const normalizedMethod = method.toUpperCase();
      const id = `api:${normalizedMethod}:${path}`;
      if (targets.has(id)) {
        continue;
      }
      targets.set(id, {
        id,
        kind: "api",
        method: normalizedMethod,
        path,
        label: `${normalizedMethod} ${path}`,
        source: api.path,
      });
    }
  }

  return [...targets.values()];
}

function isIgnoredRequestPath(pathname: string): boolean {
  const normalized = normalizeRoutePath(pathname);
  if (
    normalized === "/favicon.ico" ||
    normalized === "/robots.txt" ||
    normalized.startsWith("/_next/") ||
    normalized.startsWith("/__nextjs")
  ) {
    return true;
  }

  return /\.(?:avif|css|gif|ico|jpeg|jpg|js|map|otf|png|svg|ttf|txt|webp|woff|woff2)$/i.test(normalized);
}

export function matchRuntimeInteractionTarget(
  method: string,
  pathname: string,
  targets: RuntimeInteractionTarget[],
): RuntimeInteractionTarget | null {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = normalizeRoutePath(pathname);
  const apiTargets = targets.filter((target) => target.kind === "api");
  const pageTargets = targets.filter((target) => target.kind === "page");

  for (const target of apiTargets) {
    if (target.method === normalizedMethod && routeMatches(target.path, normalizedPath)) {
      return target;
    }
  }

  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
    return null;
  }

  for (const target of pageTargets) {
    if (routeMatches(target.path, normalizedPath)) {
      return target;
    }
  }

  return null;
}

function statusCountsForCoverage(status?: number): boolean {
  return status !== undefined && status !== 404 && status < 500;
}

export class RuntimeInteractionCoverageTracker {
  private readonly coveredTargetIds = new Set<string>();
  private readonly requests: RuntimeInteractionRequestRecord[] = [];

  constructor(private readonly targets: RuntimeInteractionTarget[]) {}

  record(input: RuntimeInteractionRecordInput): {
    record: RuntimeInteractionRequestRecord;
    repairReason?: string;
  } {
    const pathname = normalizeRoutePath(input.path);
    const target = matchRuntimeInteractionTarget(input.method, pathname, this.targets);
    const counted = Boolean(target && statusCountsForCoverage(input.status));
    if (target && counted) {
      this.coveredTargetIds.add(target.id);
    }

    const record: RuntimeInteractionRequestRecord = {
      timestamp: new Date().toISOString(),
      method: input.method.toUpperCase(),
      path: pathname,
      counted,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(target ? { targetId: target.id, targetLabel: target.label } : {}),
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
    };
    this.requests.push(record);
    if (this.requests.length > MAX_RECORDED_REQUESTS) {
      this.requests.splice(0, this.requests.length - MAX_RECORDED_REQUESTS);
    }

    const repairReason = this.resolveRepairReason(record, target);
    return repairReason ? { record, repairReason } : { record };
  }

  getSummary(): RuntimeInteractionCoverageSummary {
    const total = this.targets.length;
    const coveredTargets = this.targets
      .filter((target) => this.coveredTargetIds.has(target.id))
      .map((target) => target.label);
    const uncoveredTargets = this.targets
      .filter((target) => !this.coveredTargetIds.has(target.id))
      .map((target) => target.label);
    return {
      ratio: total === 0 ? 1 : coveredTargets.length / total,
      covered: coveredTargets.length,
      total,
      coveredTargets,
      uncoveredTargets,
    };
  }

  getRecentRequests(): RuntimeInteractionRequestRecord[] {
    return [...this.requests];
  }

  private resolveRepairReason(
    record: RuntimeInteractionRequestRecord,
    target: RuntimeInteractionTarget | null,
  ): string | undefined {
    const shouldTreatAsApplicationRequest = target !== null || !isIgnoredRequestPath(record.path);

    if (!shouldTreatAsApplicationRequest) {
      return undefined;
    }

    if (record.errorSummary) {
      return `代理转发失败：${record.method} ${record.path}。${record.errorSummary}`;
    }

    if (record.status !== undefined && record.status >= 500) {
      return `请求返回 ${record.status}：${record.method} ${record.path}`;
    }

    return undefined;
  }
}

function buildRuntimeInteractionArtifact(options: {
  valid: boolean;
  reasons: string[];
  proxyUrl?: string;
  devServerUrl?: string;
  browserOpenResult?: BrowserOpenResult;
  devServerOutput?: string;
  detectedDevServerError?: string;
  startedAt: string;
  completedAt?: string;
  config: TemplateInteractiveRuntimeValidation;
  tracker: RuntimeInteractionCoverageTracker;
}): RuntimeInteractionValidationArtifact {
  const artifact: RuntimeInteractionValidationArtifact = {
    valid: options.valid,
    reasons: options.reasons,
    startedAt: options.startedAt,
    coverageThreshold: options.config.coverageThreshold,
    idleTimeoutMs: options.config.idleTimeoutMs,
    readyTimeoutMs: options.config.readyTimeoutMs,
    coverage: options.tracker.getSummary(),
    recentRequests: options.tracker.getRecentRequests(),
  };

  if (options.proxyUrl) {
    artifact.proxyUrl = options.proxyUrl;
  }
  if (options.devServerUrl) {
    artifact.devServerUrl = options.devServerUrl;
  }
  if (options.browserOpenResult) {
    artifact.browserOpenAttempted = options.browserOpenResult.attempted;
    artifact.browserOpened = options.browserOpenResult.opened;
    if (options.browserOpenResult.error) {
      artifact.browserOpenError = options.browserOpenResult.error;
    }
  }
  if (options.devServerOutput) {
    artifact.devServerOutputSummary = summarizeCommandOutput(options.devServerOutput);
    artifact.recentDevServerOutput = recentOutputLines(options.devServerOutput);
  }
  if (options.detectedDevServerError) {
    artifact.detectedDevServerError = options.detectedDevServerError;
  }
  if (options.completedAt) {
    artifact.completedAt = options.completedAt;
  }

  return artifact;
}

async function writeRuntimeInteractionArtifact(
  artifactPath: string,
  artifact: RuntimeInteractionValidationArtifact,
): Promise<void> {
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function errorSummary(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runInteractiveRuntimeValidation(options: {
  runtime: TextGeneratorRuntime;
  planSpec: PlanSpec;
  config: TemplateInteractiveRuntimeValidation;
  openBrowser?: boolean;
  browserOpener?: (url: string) => BrowserOpenResult | Promise<BrowserOpenResult>;
  onReady?: (info: RuntimeInteractionReadyInfo) => Promise<void> | void;
  onUpdate?: (update: RuntimeInteractionUpdate) => Promise<void> | void;
}): Promise<RuntimeInteractionValidationResult> {
  const startedAt = new Date().toISOString();
  const targets = buildRuntimeInteractionTargets(options.planSpec);
  const tracker = new RuntimeInteractionCoverageTracker(targets);
  const config = options.config;
  const devServerStep = config.devServerStep;

  if (!config.enabled) {
    const artifact = buildRuntimeInteractionArtifact({
      valid: true,
      reasons: [],
      startedAt,
      completedAt: new Date().toISOString(),
      config,
      tracker,
    });
    await writeRuntimeInteractionArtifact(options.runtime.deepagentsRuntimeInteractionValidationPath, artifact);
    return { reasons: [], steps: [], artifact };
  }

  if (!devServerStep) {
    const reason = "交互式运行验证配置错误：缺少可复用的 dev-server step。";
    const artifact = buildRuntimeInteractionArtifact({
      valid: false,
      reasons: [reason],
      startedAt,
      completedAt: new Date().toISOString(),
      config,
      tracker,
    });
    await writeRuntimeInteractionArtifact(options.runtime.deepagentsRuntimeInteractionValidationPath, artifact);
    return {
      reasons: [reason],
      steps: [{ name: "interactive runtime validation", ok: false, detail: reason }],
      artifact,
    };
  }

  const devPort = await reserveFreePort();
  const devServerUrl = `http://127.0.0.1:${devPort}`;
  let output = "";
  let stopping = false;
  let failureReason: string | null = null;
  let browserOpenResult: BrowserOpenResult | undefined;
  let lastOutputAt = Date.now();
  let persistQueue = Promise.resolve();
  let child: ChildProcess | null = null;

  const persist = async (valid: boolean, reasons: string[], completedAt?: string) => {
    const artifact = buildRuntimeInteractionArtifact({
      valid,
      reasons,
      devServerUrl,
      ...(browserOpenResult ? { browserOpenResult } : {}),
      devServerOutput: output,
      ...(failureReason ? { detectedDevServerError: failureReason } : {}),
      startedAt,
      ...(completedAt ? { completedAt } : {}),
      config,
      tracker,
    });
    await writeRuntimeInteractionArtifact(options.runtime.deepagentsRuntimeInteractionValidationPath, artifact);
    return artifact;
  };

  const queuePersist = (valid: boolean, reasons: string[]) => {
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => persist(valid, reasons).then(() => undefined));
    return persistQueue;
  };

  const publishUpdate = async () => {
    if (!options.onUpdate) {
      return;
    }
    await options.onUpdate({
      devServerUrl,
      ...(browserOpenResult
        ? {
            browserOpenAttempted: browserOpenResult.attempted,
            browserOpened: browserOpenResult.opened,
            ...(browserOpenResult.error ? { browserOpenError: browserOpenResult.error } : {}),
          }
        : {}),
      coverage: tracker.getSummary(),
      recentRequests: tracker.getRecentRequests(),
      recentDevServerOutput: recentOutputLines(output),
    });
  };

  await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
    "=== interactive runtime validation ===",
    `$ PORT=${devPort} HOSTNAME=127.0.0.1 ${[devServerStep.command, ...devServerStep.args].join(" ")}`,
    "",
  ]);

  try {
    child = await spawnDevServer({
      step: devServerStep,
      cwd: options.runtime.outputDirectory,
      port: devPort,
    });
  } catch (error) {
    const reason = `交互式运行验证无法启动开发服务器：${errorSummary(error)}`;
    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[error] ${reason}`,
      "",
    ]);
    const artifact = await persist(false, [reason], new Date().toISOString());
    return {
      reasons: [reason],
      steps: [{ name: "interactive runtime validation", ok: false, detail: reason }],
      artifact,
    };
  }

  const recordDevServerOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output = `${output}${text}`;
    if (output.length > MAX_DEV_SERVER_OUTPUT_CHARS) {
      output = output.slice(output.length - MAX_DEV_SERVER_OUTPUT_CHARS);
    }
    lastOutputAt = Date.now();
    if (!failureReason) {
      failureReason = detectDevServerOutputFailure(output) ?? null;
    }
    void fs.appendFile(options.runtime.deepagentsRuntimeValidationLogPath, text, "utf8");
    void queuePersist(false, failureReason ? [failureReason] : []);
    void publishUpdate();
  };

  child.stdout!.on("data", recordDevServerOutput);
  child.stderr!.on("data", recordDevServerOutput);
  child.once("exit", (exitCode, signal) => {
    if (stopping) {
      return;
    }
    failureReason = `开发服务器提前退出，exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}。摘要：${summarizeCommandOutput(output)}`;
  });

  try {
    const readyTimeoutAt = Date.now() + config.readyTimeoutMs;
    while (Date.now() < readyTimeoutAt) {
      if (failureReason) {
        const artifact = await persist(false, [failureReason], new Date().toISOString());
        return {
          reasons: [failureReason],
          steps: [{ name: "interactive runtime validation", ok: false, detail: failureReason }],
          artifact,
        };
      }

      if (await pingDevServer(devPort)) {
        break;
      }

      await sleep(1_000);
    }

    if (!(await pingDevServer(devPort))) {
      const reason = `交互式运行验证等待开发服务器启动超时。摘要：${summarizeCommandOutput(output)}`;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] ${reason}`,
        "",
      ]);
      const artifact = await persist(false, [reason], new Date().toISOString());
      return {
        reasons: [reason],
        steps: [{ name: "interactive runtime validation", ok: false, detail: reason }],
        artifact,
      };
    }

    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[interactive] Dev server ready at ${devServerUrl}.`,
      `[interactive] Visit dev server URL: ${devServerUrl}`,
      `[interactive] Dev server stdout/stderr is the repair signal for this phase.`,
      `[interactive] Planned targets: ${targets.map((target) => target.label).join(", ")}`,
      "",
    ]);

    if (shouldOpenBrowser(options.openBrowser)) {
      const opener = options.browserOpener ?? openUrlInDefaultBrowser;
      browserOpenResult = await opener(devServerUrl);
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        browserOpenResult.opened
          ? `[interactive] Opened default browser at ${devServerUrl}.`
          : `[warn] Failed to open default browser at ${devServerUrl}: ${browserOpenResult.error ?? "unknown error"}`,
        "",
      ]);
    }

    lastOutputAt = Date.now();
    await persist(false, []);
    await publishUpdate();
    await options.onReady?.({
      devServerUrl,
      ...(browserOpenResult
        ? {
            browserOpenAttempted: browserOpenResult.attempted,
            browserOpened: browserOpenResult.opened,
            ...(browserOpenResult.error ? { browserOpenError: browserOpenResult.error } : {}),
          }
        : {}),
      targets,
    });

    while (true) {
      if (failureReason) {
        await persistQueue;
        const artifact = await persist(false, [failureReason], new Date().toISOString());
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          `[error] ${failureReason}`,
          "",
        ]);
        return {
          reasons: [`交互式运行验证失败：${failureReason} 详见 .deepagents/runtime-validation.log。`],
          steps: [{
            name: "interactive runtime validation",
            ok: false,
            detail: failureReason,
          }],
          artifact,
        };
      }

      const idleForMs = Date.now() - lastOutputAt;
      if (idleForMs >= config.idleTimeoutMs) {
        await persistQueue;
        const artifact = await persist(true, [], new Date().toISOString());
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          `[ok] Dev server stayed ready with no error output for ${Math.round(idleForMs / 1000)}s.`,
          "",
        ]);
        return {
          reasons: [],
          steps: [{
            name: "interactive runtime validation",
            ok: true,
            detail: `开发服务器 ${devServerUrl} 已稳定 ${Math.round(idleForMs / 1000)}s，未检测到错误输出。`,
          }],
          artifact,
        };
      }

      await sleep(REQUEST_POLL_INTERVAL_MS);
    }
  } finally {
    stopping = true;
    if (child) {
      await terminateChildProcess(child);
    }
  }
}
