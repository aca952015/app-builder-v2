import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import type { Duplex } from "node:stream";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import {
  isChildProcessRunning,
  isPidRunning,
  spawnManagedDevServerProcess,
  terminateDevServerProcess,
  terminateManagedDevServerProcess,
  terminateProcessTreeByPid,
  type DevServerProcessCleanupResult,
  type ManagedDevServerProcess,
} from "./dev-server-process.js";
import {
  compareRoutePatternsBySpecificity,
  hasDynamicRoutePattern,
  normalizeRoutePath,
  routePatternMatchesPath,
  routePatternToSamplePath,
} from "./app-router.js";
import type { PlanSpec } from "./plan-spec.js";
import type {
  GenerationValidationStep,
  RuntimeValidationMode,
  TemplateInteractiveRuntimeValidation,
  TemplateRuntimeValidationStep,
  TextGeneratorRuntime,
} from "./types.js";
import { workspaceRelativePath } from "./workspace-artifacts.js";

const RUNTIME_VALIDATION_LOG_LABEL = workspaceRelativePath("runtime-validation.log");

type RuntimeInteractionTargetKind = "page" | "api";
type RuntimeInteractionRequestSource = "proxy" | "dev-server-output" | "non-interactive-probe" | "browser-smoke";

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
  source?: RuntimeInteractionRequestSource;
  method: string;
  path: string;
  rawPath?: string;
  status?: number;
  targetId?: string;
  targetLabel?: string;
  counted: boolean;
  errorSummary?: string;
  responseBodySummary?: string;
  responseHeaders?: Record<string, string>;
  devServerOutputContext?: string[];
  durationMs?: number;
  proxiedUrl?: string;
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
  validationMode?: RuntimeValidationMode;
  proxyUrl?: string;
  validationUrl?: string;
  manualCompleted?: boolean;
  completionMode?: "manual_override" | "coverage_proven" | "automated_probe" | "browser_smoke";
  coverageSatisfied: boolean;
  criticalUncoveredTargets: string[];
  implementationRequest?: RuntimeInteractionImplementationRequest;
  devServerUrl?: string;
  browserOpenAttempted?: boolean;
  browserOpened?: boolean;
  browserOpenError?: string;
  devServerOutputSummary?: string;
  detectedDevServerError?: string;
  devServerProcessCleanup?: DevServerProcessCleanupResult;
  recentDevServerOutput?: string[];
  startedAt: string;
  completedAt?: string;
  coverageThreshold: number;
  idleTimeoutMs: number;
  readyTimeoutMs: number;
  coverage: RuntimeInteractionCoverageSummary;
  recentRequests: RuntimeInteractionRequestRecord[];
  failureChain?: RuntimeInteractionFailureChain;
};

export type RuntimeInteractionImplementationRequest = {
  source: "/validate";
  requestedAt: string;
  requirement: string;
};

export type RuntimeInteractionFailureChain = {
  reason: string;
  proxyUrl?: string;
  validationUrl?: string;
  devServerUrl?: string;
  request?: RuntimeInteractionRequestRecord;
  recentRequests: RuntimeInteractionRequestRecord[];
  recentDevServerOutput: string[];
};

export type RuntimeInteractionValidationResult = {
  reasons: string[];
  steps: GenerationValidationStep[];
  artifact: RuntimeInteractionValidationArtifact;
};

export type RuntimeInteractionRecordInput = {
  source?: RuntimeInteractionRequestSource;
  method: string;
  path: string;
  status?: number;
  errorSummary?: string;
  responseBodySummary?: string;
  responseHeaders?: Record<string, string>;
  devServerOutputContext?: string[];
  durationMs?: number;
  proxiedUrl?: string;
};

type RuntimeInteractionReadyInfo = {
  proxyUrl?: string;
  validationUrl?: string;
  devServerUrl: string;
  browserOpenAttempted?: boolean;
  browserOpened?: boolean;
  browserOpenReused?: boolean;
  browserOpenError?: string;
  targets: RuntimeInteractionTarget[];
};

type RuntimeInteractionUpdate = {
  proxyUrl?: string;
  validationUrl?: string;
  implementationRequest?: RuntimeInteractionImplementationRequest;
  devServerUrl: string;
  browserOpenAttempted?: boolean;
  browserOpened?: boolean;
  browserOpenReused?: boolean;
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

export type SmokeConsoleMessage = {
  type(): string;
  text(): string;
  location?(): { url?: string; lineNumber?: number; columnNumber?: number };
};

export type SmokeResponse = {
  status(): number;
  url(): string;
};

export type SmokePage = {
  on(event: "console", listener: (message: SmokeConsoleMessage) => void): unknown;
  on(event: "pageerror", listener: (error: Error) => void): unknown;
  on(event: "response", listener: (response: SmokeResponse) => void): unknown;
  goto(url: string, options: { waitUntil: "networkidle"; timeout: number }): Promise<SmokeResponse | null>;
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>;
  close?(): Promise<void>;
};

export type SmokeBrowser = {
  newPage(): Promise<SmokePage>;
  close(): Promise<void>;
};

export type SmokeBrowserLauncher = {
  launch(options: { headless: boolean }): Promise<SmokeBrowser>;
};

export type RuntimeInteractionValidationSession = {
  devPort?: number;
  proxyPort?: number;
  browserOpenResult?: BrowserOpenResult;
  browserOpenUrl?: string;
  devServerProcess?: ChildProcess;
  devServerProcessGroupId?: number;
  devServerOutput?: string;
  devServerOutputListeners?: Set<(chunk: Buffer) => void>;
  devServerOutputHandler?: (chunk: Buffer) => void;
  devServerLogPath?: string;
  devServerSpawnedAt?: string;
  devServerSpawnCommand?: string;
  devServerSpawnCwd?: string;
  devServerProcessCleanup?: DevServerProcessCleanupResult;
};

const MAX_RECORDED_REQUESTS = 100;
const REQUEST_POLL_INTERVAL_MS = 200;
const DEFAULT_NON_INTERACTIVE_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SMOKE_NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_DEV_SERVER_OUTPUT_CHARS = 40_000;
const MAX_RESPONSE_BODY_CAPTURE_BYTES = 32_768;
const MAX_RESPONSE_BODY_SUMMARY_CHARS = 6_000;
const MAX_IMPLEMENTATION_REQUEST_BYTES = 16_384;
const MAX_IMPLEMENTATION_REQUEST_CHARS = 6_000;
const VALIDATION_PAGE_PATH = "/validate";
const MANUAL_VALIDATION_COMPLETE_PATH = "/__app_builder_validate_complete";
const IMPLEMENTATION_REQUEST_PATH = "/__app_builder_validate_request";
const VALIDATION_PAGE_TEMPLATE_FILENAME = "runtime-validation-page.html";
const MANUAL_VALIDATION_COMPLETE_PATH_PLACEHOLDER = "__APP_BUILDER_MANUAL_COMPLETE_PATH__";
const IMPLEMENTATION_REQUEST_PATH_PLACEHOLDER = "__APP_BUILDER_IMPLEMENTATION_REQUEST_PATH__";

const DEV_SERVER_ERROR_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bblocked cross-origin request\b/i, label: "跨源资源阻止" },
  { pattern: /\bcross-origin access\b.*\bblocked\b/i, label: "跨源资源阻止" },
  { pattern: /\banother\s+next(?:\.js)?\s+dev\s+server\s+is\s+already\s+running\b/i, label: "Next.js dev server 冲突" },
  { pattern: /\berror:\s+can't\s+resolve\b/i, label: "模块解析失败" },
  { pattern: /\bcan't\s+resolve\s+['"][^'"]+['"]/i, label: "模块解析失败" },
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

const IGNORABLE_DEV_SERVER_OUTPUT_PATTERNS = [
  /\bMallocStackLogging:\s+can't turn off malloc stack logging because it was not enabled\./i,
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

function appendBoundedDevServerOutput(current: string | undefined, text: string): string {
  const output = `${current ?? ""}${text}`;
  if (output.length <= MAX_DEV_SERVER_OUTPUT_CHARS) {
    return output;
  }
  return output.slice(output.length - MAX_DEV_SERVER_OUTPUT_CHARS);
}

function ensureSessionOutputListeners(session: RuntimeInteractionValidationSession): Set<(chunk: Buffer) => void> {
  if (!session.devServerOutputListeners) {
    session.devServerOutputListeners = new Set();
  }
  return session.devServerOutputListeners;
}

function clearSessionDevServerProcess(session: RuntimeInteractionValidationSession): void {
  const child = session.devServerProcess;
  const handler = session.devServerOutputHandler;
  if (child && handler) {
    child.stdout?.off("data", handler);
    child.stderr?.off("data", handler);
  }
  delete session.devServerProcess;
  delete session.devServerProcessGroupId;
  delete session.devServerOutput;
  delete session.devServerOutputListeners;
  delete session.devServerOutputHandler;
  delete session.devServerLogPath;
  delete session.devServerSpawnedAt;
  delete session.devServerSpawnCommand;
  delete session.devServerSpawnCwd;
}

function attachDevServerProcessToSession(
  session: RuntimeInteractionValidationSession,
  managed: ManagedDevServerProcess,
  logPath: string,
): void {
  clearSessionDevServerProcess(session);
  const { child } = managed;
  session.devServerProcess = child;
  if (managed.processGroupId !== undefined) {
    session.devServerProcessGroupId = managed.processGroupId;
  }
  session.devServerOutput = "";
  session.devServerLogPath = logPath;
  session.devServerSpawnedAt = managed.spawnedAt;
  session.devServerSpawnCommand = [managed.command, ...managed.args].join(" ");
  session.devServerSpawnCwd = managed.cwd;
  delete session.devServerProcessCleanup;
  session.devServerOutputListeners = new Set();

  const handler = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    session.devServerOutput = appendBoundedDevServerOutput(session.devServerOutput, text);
    if (session.devServerLogPath) {
      void fs.appendFile(session.devServerLogPath, text, "utf8");
    }
    for (const listener of session.devServerOutputListeners ?? []) {
      listener(chunk);
    }
  };

  session.devServerOutputHandler = handler;
  child.stdout?.on("data", handler);
  child.stderr?.on("data", handler);
}

export async function closeRuntimeInteractionValidationSession(
  session: RuntimeInteractionValidationSession,
): Promise<DevServerProcessCleanupResult | undefined> {
  const child = session.devServerProcess;
  let cleanup: DevServerProcessCleanupResult | undefined;
  if (child) {
    cleanup = await terminateDevServerProcess(child, {
      ...(session.devServerProcessGroupId !== undefined
        ? { processGroupId: session.devServerProcessGroupId }
        : {}),
    });
    session.devServerProcessCleanup = cleanup;
  }
  clearSessionDevServerProcess(session);
  return cleanup;
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
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .filter((line) => !isIgnorableDevServerOutputLine(line));
  if (lines.length === 0) {
    return "没有捕获到额外输出。";
  }

  const excerpt = lines.slice(-8).join(" | ");
  return excerpt.length > 400 ? `${excerpt.slice(0, 397)}...` : excerpt;
}

function summarizeImplementationRequirement(requirement: string): string {
  const summary = requirement.replace(/\s+/g, " ").trim();
  return summary.length > 500 ? `${summary.slice(0, 497)}...` : summary;
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function parseDevServerRequestLine(line: string): RuntimeInteractionRecordInput | null {
  const normalizedLine = stripAnsi(line).trim();
  const match = normalizedLine.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(\d{3})(?:\s|$)/i);
  if (!match) {
    return null;
  }

  const [, method, rawPath, rawStatus] = match;
  if (!method || !rawPath || !rawStatus) {
    return null;
  }

  let requestPath = rawPath;
  if (/^https?:\/\//i.test(rawPath)) {
    try {
      const parsed = new URL(rawPath);
      requestPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      requestPath = rawPath;
    }
  }

  return {
    source: "dev-server-output",
    method: method.toUpperCase(),
    path: requestPath,
    status: Number(rawStatus),
  };
}

function recentOutputLines(output: string, limit = 12): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .filter((line) => !isIgnorableDevServerOutputLine(line))
    .slice(-limit);
}

function allSignificantOutputLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean)
    .filter((line) => !isIgnorableDevServerOutputLine(line));
}

function isIgnorableDevServerOutputLine(line: string): boolean {
  return IGNORABLE_DEV_SERVER_OUTPUT_PATTERNS.some((pattern) => pattern.test(line));
}

export function detectDevServerOutputFailure(output: string): string | undefined {
  for (const line of allSignificantOutputLines(output)) {
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
}): Promise<ManagedDevServerProcess> {
  const env = {
    ...process.env,
    ...options.step.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(options.port),
  };
  const resolvedCommand = await resolveSpawnCommand(options.step.command, env);

  return spawnManagedDevServerProcess({
    command: resolvedCommand,
    args: options.step.args,
    cwd: options.cwd,
    env,
  });
}

type NextDevServerLockInfo = {
  pid: number;
  dir: string;
  source: string;
  appUrl?: string;
};

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function parseNextDevServerLockInfo(
  source: string,
  contents: string,
  outputDirectory: string,
): NextDevServerLockInfo | null {
  try {
    const parsed = JSON.parse(contents) as Partial<{
      pid: unknown;
      appUrl: unknown;
    }>;
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    return {
      pid,
      dir: outputDirectory,
      source,
      ...(typeof parsed.appUrl === "string" ? { appUrl: parsed.appUrl } : {}),
    };
  } catch {
    return null;
  }
}

async function resolveComparablePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function isSameDirectory(left: string, right: string): Promise<boolean> {
  return path.normalize(await resolveComparablePath(left)) === path.normalize(await resolveComparablePath(right));
}

async function readCurrentOutputNextDevServerLocks(outputDirectory: string): Promise<NextDevServerLockInfo[]> {
  const lockPaths = [
    path.join(outputDirectory, ".next", "dev", "lock"),
    path.join(outputDirectory, ".next", "lock"),
  ];
  const locks: NextDevServerLockInfo[] = [];
  for (const lockPath of lockPaths) {
    const contents = await readOptionalText(lockPath);
    if (!contents) {
      continue;
    }
    const lockInfo = parseNextDevServerLockInfo(lockPath, contents, outputDirectory);
    if (lockInfo) {
      locks.push(lockInfo);
    }
  }
  return locks;
}

async function findStaleDevServerPidsByDirectory(directory: string): Promise<number[]> {
  if (process.platform === "win32") {
    return [];
  }

  return await new Promise<number[]>((resolve) => {
    const child = spawn("ps", ["-A", "-o", "pid=", "-o", "args="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => resolve([]));
    child.once("exit", (exitCode) => {
      if (exitCode !== 0) {
        resolve([]);
        return;
      }

      const resolvedDir = path.resolve(directory);
      const pids: number[] = [];
      for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const parts = trimmed.split(/\s+/);
        if (parts.length < 2) {
          continue;
        }
        const pid = Number(parts[0]);
        if (!Number.isInteger(pid) || pid <= 0) {
          continue;
        }

        const args = parts.slice(1).join(" ");
        if (args.includes(resolvedDir) && args.includes("next")) {
          pids.push(pid);
        }
      }
      resolve(pids);
    });
  });
}

async function cleanupStaleNextDevServerBeforeStart(options: {
  outputDirectory: string;
  logPath: string;
}): Promise<DevServerProcessCleanupResult | undefined> {
  const locks = await readCurrentOutputNextDevServerLocks(options.outputDirectory);
  for (const lockInfo of locks) {
    if (lockInfo.pid === process.pid || !(await isSameDirectory(lockInfo.dir, options.outputDirectory))) {
      continue;
    }
    if (!isPidRunning(lockInfo.pid)) {
      continue;
    }

    const cleanup = await terminateProcessTreeByPid({ pid: lockInfo.pid });
    await appendRuntimeValidationLog(options.logPath, [
      `[interactive] Stopped stale Next dev server PID ${lockInfo.pid} for ${options.outputDirectory} before starting validation.`,
      `[interactive] Stale source: ${lockInfo.source}${lockInfo.appUrl ? ` (${lockInfo.appUrl})` : ""}; cleanup exited=${cleanup.exited} forced=${cleanup.forced}.`,
      "",
    ]);
    return cleanup;
  }

  const orphanPids = await findStaleDevServerPidsByDirectory(options.outputDirectory);
  for (const pid of orphanPids) {
    if (pid === process.pid || !isPidRunning(pid)) {
      continue;
    }

    const cleanup = await terminateProcessTreeByPid({ pid });
    await appendRuntimeValidationLog(options.logPath, [
      `[interactive] Stopped orphan dev server PID ${pid} for ${options.outputDirectory} before starting validation (detected by command-line scan).`,
      `[interactive] Cleanup exited=${cleanup.exited} forced=${cleanup.forced}.`,
      "",
    ]);
    return cleanup;
  }

  return undefined;
}

async function pingDevServer(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/__app_builder_ready",
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
    normalized === "/__app_builder_ready" ||
    normalized === VALIDATION_PAGE_PATH ||
    normalized === MANUAL_VALIDATION_COMPLETE_PATH ||
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
  const apiTargets = targets
    .filter((target) => target.kind === "api")
    .sort((a, b) => compareRoutePatternsBySpecificity(a.path, b.path));
  const pageTargets = targets
    .filter((target) => target.kind === "page")
    .sort((a, b) => compareRoutePatternsBySpecificity(a.path, b.path));

  for (const target of apiTargets) {
    if (target.method === normalizedMethod && routePatternMatchesPath(target.path, normalizedPath)) {
      return target;
    }
  }

  if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") {
    return null;
  }

  for (const target of pageTargets) {
    if (routePatternMatchesPath(target.path, normalizedPath)) {
      return target;
    }
  }

  return null;
}

function isApiAuthorizationFailure(
  target: RuntimeInteractionTarget | null,
  status: number | undefined,
  pathname?: string,
): boolean {
  const isApiRequest = target?.kind === "api" ||
    (pathname !== undefined && normalizeRoutePath(pathname).startsWith("/api/"));
  return isApiRequest && (status === 401 || status === 403);
}

function statusCountsForCoverage(
  status: number | undefined,
  target: RuntimeInteractionTarget | null,
): boolean {
  return status !== undefined && status !== 404 && status < 500 && !isApiAuthorizationFailure(target, status);
}

export class RuntimeInteractionCoverageTracker {
  private readonly coveredTargetIds = new Set<string>();
  private readonly requests: RuntimeInteractionRequestRecord[] = [];

  constructor(private readonly targets: RuntimeInteractionTarget[]) {}

  record(input: RuntimeInteractionRecordInput, options: { countNotFoundAsCovered?: boolean } = {}): {
    record: RuntimeInteractionRequestRecord;
    repairReason?: string;
  } {
    const rawPath = input.path;
    const pathname = normalizeRoutePath(input.path);
    const target = matchRuntimeInteractionTarget(input.method, pathname, this.targets);
    const counted = Boolean(target && (
      statusCountsForCoverage(input.status, target) ||
      (
        options.countNotFoundAsCovered === true &&
        input.status === 404 &&
        !isApiAuthorizationFailure(target, input.status, pathname)
      )
    ));
    if (target && counted) {
      this.coveredTargetIds.add(target.id);
    }

    const record: RuntimeInteractionRequestRecord = {
      timestamp: new Date().toISOString(),
      ...(input.source ? { source: input.source } : {}),
      method: input.method.toUpperCase(),
      path: pathname,
      ...(rawPath !== pathname ? { rawPath } : {}),
      counted,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(target ? { targetId: target.id, targetLabel: target.label } : {}),
      ...(input.errorSummary ? { errorSummary: input.errorSummary } : {}),
      ...(input.responseBodySummary ? { responseBodySummary: input.responseBodySummary } : {}),
      ...(input.responseHeaders ? { responseHeaders: input.responseHeaders } : {}),
      ...(input.devServerOutputContext && input.devServerOutputContext.length > 0
        ? { devServerOutputContext: input.devServerOutputContext }
        : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.proxiedUrl ? { proxiedUrl: input.proxiedUrl } : {}),
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
      return [
        `代理转发失败：${record.method} ${record.rawPath ?? record.path}。${record.errorSummary}`,
        record.responseBodySummary ? `响应体摘要：${record.responseBodySummary}` : "",
        record.devServerOutputContext && record.devServerOutputContext.length > 0
          ? `相邻 stdout/stderr：${record.devServerOutputContext.join(" | ")}`
          : "",
      ].filter(Boolean).join(" ");
    }

    if (isApiAuthorizationFailure(target, record.status, record.path)) {
      return [
        `API 权限错误 ${record.status}：${record.method} ${record.rawPath ?? record.path}`,
        record.targetLabel ? `匹配目标：${record.targetLabel}。` : "",
        "这通常表示 API key、鉴权头、环境变量或上游权限范围配置不正确，不能算作交互验证通过。",
        record.responseBodySummary ? `响应体摘要：${record.responseBodySummary}` : "",
        record.devServerOutputContext && record.devServerOutputContext.length > 0
          ? `相邻 stdout/stderr：${record.devServerOutputContext.join(" | ")}`
          : "",
      ].filter(Boolean).join(" ");
    }

    if (record.status !== undefined && record.status >= 500) {
      return [
        `请求返回 ${record.status}：${record.method} ${record.rawPath ?? record.path}`,
        record.targetLabel ? `匹配目标：${record.targetLabel}。` : "",
        record.responseBodySummary ? `响应体摘要：${record.responseBodySummary}` : "",
        record.devServerOutputContext && record.devServerOutputContext.length > 0
          ? `相邻 stdout/stderr：${record.devServerOutputContext.join(" | ")}`
          : "",
      ].filter(Boolean).join(" ");
    }

    return undefined;
  }
}

export function runtimeInteractionTargetToProbePath(target: RuntimeInteractionTarget): string {
  return routePatternToSamplePath(target.path);
}

function shouldAllowNotFoundProbeCoverage(target: RuntimeInteractionTarget): boolean {
  return hasDynamicRoutePattern(target.path);
}

async function probeRuntimeInteractionTarget(options: {
  devPort: number;
  target: RuntimeInteractionTarget;
  probePath: string;
  devServerUrl: string;
  devServerOutput: string;
  requestTimeoutMs: number;
}): Promise<RuntimeInteractionRecordInput> {
  const startedAt = Date.now();
  const method = options.target.method.toUpperCase();
  const shouldSendJsonBody = method !== "GET" && method !== "HEAD";

  return await new Promise<RuntimeInteractionRecordInput>((resolve) => {
    const capturedChunks: Buffer[] = [];
    let capturedBytes = 0;
    let totalResponseBytes = 0;
    let settled = false;
    const settle = (record: RuntimeInteractionRecordInput) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(record);
    };

    const requestOptions = {
      host: "127.0.0.1",
      port: options.devPort,
      method,
      path: options.probePath,
      headers: {
        accept: "application/json, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5",
        "user-agent": "app-builder-runtime-validator/1.0",
        "x-app-builder-runtime-validation": "non-interactive",
        ...(shouldSendJsonBody
          ? {
              "content-type": "application/json; charset=utf-8",
              "content-length": "2",
            }
          : {}),
      },
      timeout: options.requestTimeoutMs,
    };

    const req = httpRequest(requestOptions, (response) => {
      response.on("data", (chunk: Buffer) => {
        totalResponseBytes += chunk.length;
        if (capturedBytes < MAX_RESPONSE_BODY_CAPTURE_BYTES) {
          const remaining = MAX_RESPONSE_BODY_CAPTURE_BYTES - capturedBytes;
          const capturedChunk = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          capturedChunks.push(capturedChunk);
          capturedBytes += capturedChunk.length;
        }
      });

      response.once("end", () => {
        const responseBodySummary = summarizeHttpResponseBody(capturedChunks, totalResponseBytes);
        settle({
          source: "non-interactive-probe",
          method,
          path: options.probePath,
          durationMs: Date.now() - startedAt,
          proxiedUrl: `${options.devServerUrl}${options.probePath}`,
          devServerOutputContext: recentOutputLines(options.devServerOutput, 16),
          ...(response.statusCode !== undefined ? { status: response.statusCode } : {}),
          responseHeaders: summarizeResponseHeaders(response.headers),
          ...(responseBodySummary ? { responseBodySummary } : {}),
        });
      });

      response.once("error", (error) => {
        const responseBodySummary = summarizeHttpResponseBody(capturedChunks, totalResponseBytes);
        settle({
          source: "non-interactive-probe",
          method,
          path: options.probePath,
          status: 502,
          durationMs: Date.now() - startedAt,
          proxiedUrl: `${options.devServerUrl}${options.probePath}`,
          errorSummary: `读取 dev server 响应失败：${errorSummary(error)}`,
          devServerOutputContext: recentOutputLines(options.devServerOutput, 16),
          ...(responseBodySummary ? { responseBodySummary } : {}),
        });
      });
    });

    req.once("timeout", () => {
      req.destroy(new Error(`Request timed out for ${method} ${options.probePath}`));
    });
    req.once("error", (error) => {
      settle({
        source: "non-interactive-probe",
        method,
        path: options.probePath,
        durationMs: Date.now() - startedAt,
        proxiedUrl: `${options.devServerUrl}${options.probePath}`,
        errorSummary: errorSummary(error),
        devServerOutputContext: recentOutputLines(options.devServerOutput, 16),
      });
    });

    if (shouldSendJsonBody) {
      req.write("{}");
    }
    req.end();
  });
}

function buildRuntimeSmokeTargets(planSpec: PlanSpec): RuntimeInteractionTarget[] {
  return buildRuntimeInteractionTargets(planSpec).filter((target) => target.kind === "page");
}

async function loadPlaywrightChromium(): Promise<SmokeBrowserLauncher> {
  try {
    const playwright = await import("playwright") as { chromium?: SmokeBrowserLauncher };
    if (!playwright.chromium) {
      throw new Error("Playwright did not expose a Chromium launcher.");
    }
    return playwright.chromium;
  } catch (error) {
    throw new Error(
      [
        `无法加载 Playwright：${errorSummary(error)}`,
        "请确认依赖已安装：pnpm install。",
      ].join(" "),
    );
  }
}

function addPlaywrightBrowserInstallHint(message: string): string {
  if (/playwright\s+install|executable doesn't exist|browser executable|install browsers/i.test(message)) {
    return `${message} 请安装 Playwright Chromium：pnpm exec playwright install chromium。`;
  }
  return message;
}

function formatSmokeConsoleMessage(message: SmokeConsoleMessage): string {
  const location = message.location?.();
  const where = location?.url
    ? ` (${location.url}${location.lineNumber !== undefined ? `:${location.lineNumber}` : ""})`
    : "";
  return `${message.type()}: ${message.text()}${where}`;
}

function responseBelongsToDevServer(response: SmokeResponse, devServerUrl: string): boolean {
  try {
    return new URL(response.url()).origin === devServerUrl;
  } catch {
    return response.url().startsWith(devServerUrl);
  }
}

function buildRuntimeInteractionArtifact(options: {
  valid: boolean;
  reasons: string[];
  validationMode?: RuntimeValidationMode;
  proxyUrl?: string;
  validationUrl?: string;
  manualCompleted?: boolean;
  completionMode?: RuntimeInteractionValidationArtifact["completionMode"];
  implementationRequest?: RuntimeInteractionImplementationRequest;
  devServerUrl?: string;
  browserOpenResult?: BrowserOpenResult;
  devServerOutput?: string;
  detectedDevServerError?: string;
  devServerProcessCleanup?: DevServerProcessCleanupResult;
  startedAt: string;
  completedAt?: string;
  config: TemplateInteractiveRuntimeValidation;
  tracker: RuntimeInteractionCoverageTracker;
  failureChain?: RuntimeInteractionFailureChain;
}): RuntimeInteractionValidationArtifact {
  const artifact: RuntimeInteractionValidationArtifact = {
    coverage: options.tracker.getSummary(),
    recentRequests: options.tracker.getRecentRequests(),
    valid: options.valid,
    reasons: options.reasons,
    ...(options.validationMode ? { validationMode: options.validationMode } : {}),
    startedAt: options.startedAt,
    coverageThreshold: options.config.coverageThreshold,
    idleTimeoutMs: options.config.idleTimeoutMs,
    readyTimeoutMs: options.config.readyTimeoutMs,
    coverageSatisfied: false,
    criticalUncoveredTargets: [],
  };
  artifact.coverageSatisfied = artifact.coverage.ratio >= options.config.coverageThreshold;
  artifact.criticalUncoveredTargets = artifact.coverage.uncoveredTargets;

  if (options.proxyUrl) {
    artifact.proxyUrl = options.proxyUrl;
  }
  if (options.validationUrl) {
    artifact.validationUrl = options.validationUrl;
  }
  if (options.manualCompleted) {
    artifact.manualCompleted = true;
    artifact.completionMode = "manual_override";
  } else if (options.completionMode) {
    artifact.completionMode = options.completionMode;
  } else if (options.valid && artifact.coverageSatisfied) {
    artifact.completionMode = "coverage_proven";
  }
  if (options.implementationRequest) {
    artifact.implementationRequest = options.implementationRequest;
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
  if (options.devServerProcessCleanup) {
    artifact.devServerProcessCleanup = options.devServerProcessCleanup;
  }
  if (options.completedAt) {
    artifact.completedAt = options.completedAt;
  }
  if (options.failureChain) {
    artifact.failureChain = options.failureChain;
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

async function closeHttpServer(server: HttpServer): Promise<void> {
  for (const socket of proxyServerSockets.get(server) ?? []) {
    socket.destroy();
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
    sleep(1_000).then(() => undefined),
  ]);
}

const proxyUrls = new WeakMap<HttpServer, string>();
const proxyServerSockets = new WeakMap<HttpServer, Set<Duplex>>();

function setProxyUrlForServer(server: HttpServer, proxyUrl: string): void {
  proxyUrls.set(server, proxyUrl);
}

function proxyUrlForServer(server: HttpServer): string {
  return proxyUrls.get(server) ?? "http://127.0.0.1";
}

function trackProxyServerSocket(server: HttpServer, socket: Duplex): void {
  let sockets = proxyServerSockets.get(server);
  if (!sockets) {
    sockets = new Set<Duplex>();
    proxyServerSockets.set(server, sockets);
  }
  sockets.add(socket);
  socket.once("close", () => {
    sockets.delete(socket);
  });
}

function rewriteForwardedUrlHeader(value: string | undefined, proxyUrl: string, devServerUrl: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replaceAll(proxyUrl, devServerUrl);
}

function buildProxyRequestHeaders(
  incomingHeaders: IncomingHttpHeaders,
  options: {
    devPort: number;
    proxyUrl: string;
    devServerUrl: string;
    preserveConnectionHeader?: boolean;
  },
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    ...incomingHeaders,
    host: `127.0.0.1:${options.devPort}`,
    "x-forwarded-host": incomingHeaders.host,
    "x-forwarded-proto": "http",
  };

  delete headers["accept-encoding"];
  if (!options.preserveConnectionHeader) {
    delete headers.connection;
  } else if (!headers.connection && headers.upgrade) {
    headers.connection = "Upgrade";
  }
  delete headers["proxy-connection"];

  const rewrittenOrigin = rewriteForwardedUrlHeader(
    Array.isArray(headers.origin) ? headers.origin[0] : headers.origin,
    options.proxyUrl,
    options.devServerUrl,
  );
  if (rewrittenOrigin) {
    headers.origin = rewrittenOrigin;
  }

  const rewrittenReferer = rewriteForwardedUrlHeader(
    Array.isArray(headers.referer) ? headers.referer[0] : headers.referer,
    options.proxyUrl,
    options.devServerUrl,
  );
  if (rewrittenReferer) {
    headers.referer = rewrittenReferer;
  }

  return headers;
}

function summarizeResponseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    const normalizedValue = Array.isArray(value) ? value.join(", ") : String(value);
    if (normalizedValue.length === 0) {
      continue;
    }

    summary[key] = normalizedValue.length > 300 ? `${normalizedValue.slice(0, 297)}...` : normalizedValue;
    if (Object.keys(summary).length >= 24) {
      break;
    }
  }

  return summary;
}

function summarizeHttpResponseBody(chunks: Buffer[], totalBytes: number): string | undefined {
  if (chunks.length === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString("utf8");
  const collapsed = text
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) {
    return totalBytes > 0 ? `[${totalBytes} response bytes captured, no UTF-8 text]` : undefined;
  }

  const suffix = totalBytes > MAX_RESPONSE_BODY_CAPTURE_BYTES ? ` ... [truncated after ${MAX_RESPONSE_BODY_CAPTURE_BYTES} bytes]` : "";
  return `${collapsed.slice(0, MAX_RESPONSE_BODY_SUMMARY_CHARS)}${collapsed.length > MAX_RESPONSE_BODY_SUMMARY_CHARS ? " ..." : ""}${suffix}`;
}

function writeProxyErrorResponse(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function requestPathname(rawPath: string): string {
  try {
    return new URL(rawPath, "http://127.0.0.1").pathname;
  } catch {
    return rawPath.split("?")[0] ?? rawPath;
  }
}

function validationUrlForProxy(proxyUrl: string): string {
  return `${proxyUrl}${VALIDATION_PAGE_PATH}`;
}

async function readValidationPageTemplate(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, VALIDATION_PAGE_TEMPLATE_FILENAME),
    path.resolve(moduleDirectory, "../../../src/lib", VALIDATION_PAGE_TEMPLATE_FILENAME),
    path.resolve(process.cwd(), "src/lib", VALIDATION_PAGE_TEMPLATE_FILENAME),
  ];

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Could not find ${VALIDATION_PAGE_TEMPLATE_FILENAME}.`);
}

async function buildValidationPageHtml(): Promise<string> {
  const template = await readValidationPageTemplate();
  return template
    .replaceAll(MANUAL_VALIDATION_COMPLETE_PATH_PLACEHOLDER, MANUAL_VALIDATION_COMPLETE_PATH)
    .replaceAll(IMPLEMENTATION_REQUEST_PATH_PLACEHOLDER, IMPLEMENTATION_REQUEST_PATH);
}

function writeValidationPageResponse(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function writeManualValidationCompleteResponse(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ ok: true, manualCompleted: true }));
}

function writeJsonResponse(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJsonRequestBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseImplementationRequest(raw: unknown): RuntimeInteractionImplementationRequest {
  const candidate = raw && typeof raw === "object" ? raw as { requirement?: unknown; prompt?: unknown; requestedAt?: unknown } : {};
  const rawRequirement = typeof candidate.requirement === "string"
    ? candidate.requirement
    : typeof candidate.prompt === "string"
      ? candidate.prompt
      : "";
  const requirement = rawRequirement.trim();

  if (!requirement) {
    throw new Error("Requirement is required.");
  }

  return {
    source: "/validate",
    requestedAt: typeof candidate.requestedAt === "string" && candidate.requestedAt.trim() !== ""
      ? candidate.requestedAt
      : new Date().toISOString(),
    requirement: requirement.length > MAX_IMPLEMENTATION_REQUEST_CHARS
      ? requirement.slice(0, MAX_IMPLEMENTATION_REQUEST_CHARS)
      : requirement,
  };
}

async function handleImplementationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  onImplementationRequest: (implementationRequest: RuntimeInteractionImplementationRequest) => void,
): Promise<void> {
  try {
    const payload = await readJsonRequestBody(request, MAX_IMPLEMENTATION_REQUEST_BYTES);
    const implementationRequest = parseImplementationRequest(payload);
    onImplementationRequest(implementationRequest);
    writeJsonResponse(response, 200, {
      ok: true,
      implementationRequested: true,
      requirement: implementationRequest.requirement,
    });
  } catch (error) {
    writeJsonResponse(response, 400, {
      ok: false,
      error: errorSummary(error),
    });
  }
}

function writeUpgradeRequest(
  upstreamSocket: Duplex,
  request: IncomingMessage,
  proxyUrl: string,
  devServerUrl: string,
  devPort: number,
): void {
  const headers = buildProxyRequestHeaders(request.headers, {
    devPort,
    proxyUrl,
    devServerUrl,
    preserveConnectionHeader: true,
  });
  const lines = [`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        lines.push(`${key}: ${entry}`);
      }
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

async function startDevServerProxy(options: {
  devPort: number;
  proxyPort?: number;
  devServerUrl: string;
  tracker: RuntimeInteractionCoverageTracker;
  logPath: string;
  getDevServerOutput: () => string;
  onActivity: () => void;
  onFailure: (reason: string, record: RuntimeInteractionRequestRecord) => void;
  onManualComplete: () => void;
  onImplementationRequest: (implementationRequest: RuntimeInteractionImplementationRequest) => void;
  onRecordedRequest: () => void;
}): Promise<{ server: HttpServer; proxyUrl: string }> {
  const validationPageHtml = await buildValidationPageHtml();
  const server = createHttpServer((request, response) => {
    const startedAt = Date.now();
    const method = (request.method ?? "GET").toUpperCase();
    const rawPath = request.url ?? "/";
    const hostPath = normalizeRoutePath(requestPathname(rawPath));
    const capturedChunks: Buffer[] = [];
    let capturedBytes = 0;
    let totalResponseBytes = 0;

    if (hostPath === VALIDATION_PAGE_PATH) {
      if (method !== "GET" && method !== "HEAD") {
        response.writeHead(405, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          allow: "GET, HEAD",
        });
        response.end(JSON.stringify({ ok: false, error: "Method not allowed." }));
        request.resume();
        return;
      }
      writeValidationPageResponse(response, validationPageHtml);
      request.resume();
      return;
    }

    if (hostPath === MANUAL_VALIDATION_COMPLETE_PATH) {
      if (method !== "POST") {
        response.writeHead(405, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          allow: "POST",
        });
        response.end(JSON.stringify({ ok: false, error: "Method not allowed." }));
        request.resume();
        return;
      }
      options.onManualComplete();
      writeManualValidationCompleteResponse(response);
      request.resume();
      return;
    }

    if (hostPath === IMPLEMENTATION_REQUEST_PATH) {
      if (method !== "POST") {
        response.writeHead(405, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          allow: "POST",
        });
        response.end(JSON.stringify({ ok: false, error: "Method not allowed." }));
        request.resume();
        return;
      }
      void handleImplementationRequest(request, response, options.onImplementationRequest);
      return;
    }

    options.onActivity();

    const recordRequest = async (input: Omit<RuntimeInteractionRecordInput, "source" | "method" | "path" | "durationMs" | "proxiedUrl" | "devServerOutputContext">) => {
      options.onActivity();
      const recordResult = options.tracker.record({
        source: "proxy",
        method,
        path: rawPath,
        durationMs: Date.now() - startedAt,
        proxiedUrl: `${options.devServerUrl}${rawPath}`,
        devServerOutputContext: recentOutputLines(options.getDevServerOutput(), 16),
        ...input,
      });

      const status = recordResult.record.status === undefined ? "ERR" : String(recordResult.record.status);
      await appendRuntimeValidationLog(options.logPath, [
        `[proxy] ${method} ${rawPath} -> ${status}${recordResult.record.targetLabel ? ` (${recordResult.record.targetLabel})` : ""}`,
        ...(recordResult.record.responseBodySummary ? [`[proxy] response body: ${recordResult.record.responseBodySummary}`] : []),
        ...(recordResult.record.errorSummary ? [`[proxy] error: ${recordResult.record.errorSummary}`] : []),
      ]);

      if (recordResult.repairReason) {
        options.onFailure(recordResult.repairReason, recordResult.record);
      }
      options.onRecordedRequest();
    };

    const proxyRequest = httpRequest(
      {
        host: "127.0.0.1",
        port: options.devPort,
        method,
        path: rawPath,
        headers: buildProxyRequestHeaders(request.headers, {
          devPort: options.devPort,
          proxyUrl: proxyUrlForServer(server),
          devServerUrl: options.devServerUrl,
        }),
      },
      (proxyResponse) => {
        const headers = { ...proxyResponse.headers };
        response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.statusMessage, headers);

        proxyResponse.on("data", (chunk: Buffer) => {
          totalResponseBytes += chunk.length;
          if (capturedBytes < MAX_RESPONSE_BODY_CAPTURE_BYTES) {
            const remaining = MAX_RESPONSE_BODY_CAPTURE_BYTES - capturedBytes;
            const capturedChunk = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            capturedChunks.push(capturedChunk);
            capturedBytes += capturedChunk.length;
          }
          response.write(chunk);
        });

        proxyResponse.once("end", () => {
          response.end();
          const responseBodySummary = summarizeHttpResponseBody(capturedChunks, totalResponseBytes);
          void recordRequest({
            ...(proxyResponse.statusCode !== undefined ? { status: proxyResponse.statusCode } : {}),
            responseHeaders: summarizeResponseHeaders(proxyResponse.headers),
            ...(responseBodySummary ? { responseBodySummary } : {}),
          });
        });

        proxyResponse.once("error", (error) => {
          const detail = `读取 dev server 响应失败：${errorSummary(error)}`;
          const responseBodySummary = summarizeHttpResponseBody(capturedChunks, totalResponseBytes);
          writeProxyErrorResponse(response, 502, detail);
          void recordRequest({
            status: 502,
            errorSummary: detail,
            ...(responseBodySummary ? { responseBodySummary } : {}),
          });
        });
      },
    );

    proxyRequest.once("timeout", () => {
      proxyRequest.destroy(new Error(`Proxy request timed out for ${method} ${rawPath}`));
    });
    proxyRequest.once("error", (error) => {
      const detail = errorSummary(error);
      writeProxyErrorResponse(response, 502, `Proxy failed to reach dev server: ${detail}`);
      void recordRequest({
        status: 502,
        errorSummary: detail,
      });
    });
    proxyRequest.setTimeout(30_000);
    request.pipe(proxyRequest);
  });

  const proxyUrlPromise = new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.proxyPort ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine runtime proxy port."));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  const proxyUrl = await proxyUrlPromise;
  setProxyUrlForServer(server, proxyUrl);
  server.on("connection", (socket) => {
    trackProxyServerSocket(server, socket);
  });

  server.on("upgrade", (request, socket, head) => {
    options.onActivity();
    trackProxyServerSocket(server, socket);
    const upstreamSocket = connectNet(options.devPort, "127.0.0.1");
    trackProxyServerSocket(server, upstreamSocket);
    upstreamSocket.once("connect", () => {
      writeUpgradeRequest(upstreamSocket, request, proxyUrl, options.devServerUrl, options.devPort);
      if (head.length > 0) {
        upstreamSocket.write(head);
      }
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstreamSocket.once("error", (error) => {
      socket.destroy(error);
    });
  });

  return { server, proxyUrl };
}

export async function runNonInteractiveRuntimeValidation(options: {
  runtime: TextGeneratorRuntime;
  planSpec: PlanSpec;
  devServerStep: TemplateRuntimeValidationStep;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}): Promise<RuntimeInteractionValidationResult> {
  const startedAt = new Date().toISOString();
  const targets = buildRuntimeInteractionTargets(options.planSpec);
  const tracker = new RuntimeInteractionCoverageTracker(targets);
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_NON_INTERACTIVE_REQUEST_TIMEOUT_MS;
  const devPort = await reserveFreePort();
  const devServerUrl = `http://127.0.0.1:${devPort}`;
  const config: TemplateInteractiveRuntimeValidation = {
    enabled: false,
    coverageThreshold: 1,
    idleTimeoutMs: 0,
    readyTimeoutMs,
    devServerStep: options.devServerStep,
  };

  let output = "";
  let child: ChildProcess | null = null;
  let managedDevServer: ManagedDevServerProcess | null = null;
  let devServerProcessCleanup: DevServerProcessCleanupResult | undefined;
  let failureReason: string | null = null;
  let failureRecord: RuntimeInteractionRequestRecord | undefined;
  let stopping = false;
  let pendingOutputLine = "";

  const buildFailureChain = (): RuntimeInteractionFailureChain | undefined => {
    if (!failureReason) {
      return undefined;
    }

    return {
      reason: failureReason,
      devServerUrl,
      ...(failureRecord ? { request: failureRecord } : {}),
      recentRequests: tracker.getRecentRequests(),
      recentDevServerOutput: recentOutputLines(output, 24),
    };
  };

  const finish = async (valid: boolean, reasons: string[]) => {
    stopping = true;
    if (managedDevServer && !devServerProcessCleanup) {
      devServerProcessCleanup = await terminateManagedDevServerProcess(managedDevServer);
    } else if (child && !devServerProcessCleanup) {
      devServerProcessCleanup = await terminateDevServerProcess(child);
    }
    child = null;
    managedDevServer = null;

    const failureChain = buildFailureChain();
    const artifact = buildRuntimeInteractionArtifact({
      valid,
      reasons,
      validationMode: "non-interactive",
      ...(valid ? { completionMode: "automated_probe" } : {}),
      devServerUrl,
      devServerOutput: output,
      ...(failureReason ? { detectedDevServerError: failureReason } : {}),
      ...(devServerProcessCleanup ? { devServerProcessCleanup } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
      config,
      tracker,
      ...(failureChain ? { failureChain } : {}),
    });
    await writeRuntimeInteractionArtifact(options.runtime.deepagentsRuntimeInteractionValidationPath, artifact);
    return artifact;
  };

  const recordDevServerOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const detectedOutputFailure = failureReason
      ? undefined
      : detectDevServerOutputFailure(`${output}${text}`) ?? detectDevServerOutputFailure(text);
    output = appendBoundedDevServerOutput(output, text);
    void fs.appendFile(options.runtime.deepagentsRuntimeValidationLogPath, text, "utf8");

    const outputWithPending = `${pendingOutputLine}${text}`;
    const outputLines = outputWithPending.split(/\r?\n/);
    pendingOutputLine = outputLines.pop() ?? "";
    for (const line of outputLines) {
      const requestRecord = parseDevServerRequestLine(line);
      if (!requestRecord) {
        continue;
      }
      const recordResult = tracker.record(requestRecord);
      if (!failureReason && recordResult.repairReason) {
        failureReason = recordResult.repairReason;
        failureRecord = recordResult.record;
      }
    }

    if (!failureReason) {
      failureReason = detectedOutputFailure ?? detectDevServerOutputFailure(output) ?? null;
    }
  };

  await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
    "=== non-interactive runtime validation ===",
    `$ PORT=${devPort} HOSTNAME=127.0.0.1 ${[options.devServerStep.command, ...options.devServerStep.args].join(" ")}`,
    `[non-interactive] Planned targets: ${targets.map((target) => target.label).join(", ")}`,
    "",
  ]);

  try {
    await cleanupStaleNextDevServerBeforeStart({
      outputDirectory: options.runtime.outputDirectory,
      logPath: options.runtime.deepagentsRuntimeValidationLogPath,
    });

    try {
      managedDevServer = await spawnDevServer({
        step: options.devServerStep,
        cwd: options.runtime.outputDirectory,
        port: devPort,
      });
      child = managedDevServer.child;
    } catch (error) {
      const reason = `非交互式运行验证无法启动开发服务器：${errorSummary(error)}`;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] ${reason}`,
        "",
      ]);
      const artifact = await finish(false, [reason]);
      return {
        reasons: [reason],
        steps: [{ name: options.devServerStep.name, ok: false, detail: reason }],
        artifact,
      };
    }

    child.stdout?.on("data", recordDevServerOutput);
    child.stderr?.on("data", recordDevServerOutput);
    child.once("exit", (exitCode, signal) => {
      if (stopping) {
        return;
      }
      failureReason = `开发服务器提前退出，exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}。摘要：${summarizeCommandOutput(output)}`;
    });

    const readyTimeoutAt = Date.now() + readyTimeoutMs;
    while (Date.now() < readyTimeoutAt) {
      if (failureReason) {
        const artifact = await finish(false, [failureReason]);
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          `[error] ${failureReason}`,
          "",
        ]);
        return {
          reasons: [`非交互式运行验证失败：${failureReason} 详见 ${RUNTIME_VALIDATION_LOG_LABEL}。`],
          steps: [{ name: options.devServerStep.name, ok: false, detail: failureReason }],
          artifact,
        };
      }

      if (await pingDevServer(devPort)) {
        break;
      }

      await sleep(1_000);
    }

    if (!(await pingDevServer(devPort))) {
      const reason = `非交互式运行验证等待开发服务器启动超时。摘要：${summarizeCommandOutput(output)}`;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] ${reason}`,
        "",
      ]);
      const artifact = await finish(false, [reason]);
      return {
        reasons: [reason],
        steps: [{ name: options.devServerStep.name, ok: false, detail: reason }],
        artifact,
      };
    }

    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[non-interactive] Dev server ready at ${devServerUrl}.`,
      "",
    ]);

    const reasons: string[] = [];
    for (const target of targets) {
      const probePath = runtimeInteractionTargetToProbePath(target);
      const recordInput = await probeRuntimeInteractionTarget({
        devPort,
        target,
        probePath,
        devServerUrl,
        devServerOutput: output,
        requestTimeoutMs,
      });
      const recordResult = tracker.record(recordInput, {
        countNotFoundAsCovered: shouldAllowNotFoundProbeCoverage(target),
      });
      const record = recordResult.record;
      const status = record.status === undefined ? "ERR" : String(record.status);
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[non-interactive] ${record.method} ${probePath} -> ${status} (${target.label})`,
        ...(record.responseBodySummary ? [`[non-interactive] response body: ${record.responseBodySummary}`] : []),
        ...(record.errorSummary ? [`[non-interactive] error: ${record.errorSummary}`] : []),
      ]);

      const staticNotFoundReason =
        record.status === 404 && !shouldAllowNotFoundProbeCoverage(target)
          ? `非交互式运行验证请求返回 404：${record.method} ${probePath}（目标：${target.label}）`
          : undefined;
      const reason = recordResult.repairReason ?? staticNotFoundReason;
      if (reason) {
        reasons.push(reason);
        if (!failureReason) {
          failureReason = reason;
          failureRecord = record;
        }
      }
    }

    const coverage = tracker.getSummary();
    if (coverage.covered < coverage.total) {
      reasons.push(
        `非交互式运行验证覆盖不足：${coverage.covered}/${coverage.total}。未覆盖：${coverage.uncoveredTargets.join(", ") || "无"}`,
      );
    }

    if (reasons.length > 0) {
      const artifact = await finish(false, reasons);
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] Non-interactive runtime validation failed. Covered ${coverage.covered}/${coverage.total}.`,
        "",
      ]);
      return {
        reasons: [`非交互式运行验证失败：${reasons.join(" | ")} 详见 ${RUNTIME_VALIDATION_LOG_LABEL}。`],
        steps: [{
          name: options.devServerStep.name,
          ok: false,
          detail: `自动访问 ${coverage.covered}/${coverage.total} 个页面/API 目标后失败：${reasons.join(" | ")}`,
        }],
        artifact,
      };
    }

    const artifact = await finish(true, []);
    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[ok] Non-interactive runtime validation visited all ${coverage.total} page/API targets and detected no 5xx, API auth failure, proxy failure, or dev server error output.`,
      "",
    ]);
    return {
      reasons: [],
      steps: [{
        name: options.devServerStep.name,
        ok: true,
        detail: `非交互式运行验证已启动 dev server，并自动访问全部 ${coverage.total} 个页面/API 目标。`,
      }],
      artifact,
    };
  } finally {
    child?.stdout?.off("data", recordDevServerOutput);
    child?.stderr?.off("data", recordDevServerOutput);
    if ((child || managedDevServer) && !devServerProcessCleanup) {
      stopping = true;
      if (managedDevServer) {
        await terminateManagedDevServerProcess(managedDevServer);
      } else if (child) {
        await terminateDevServerProcess(child);
      }
    }
  }
}

export async function runSmokeRuntimeValidation(options: {
  runtime: TextGeneratorRuntime;
  planSpec: PlanSpec;
  devServerStep: TemplateRuntimeValidationStep;
  readyTimeoutMs?: number;
  navigationTimeoutMs?: number;
  browserLauncher?: SmokeBrowserLauncher;
}): Promise<RuntimeInteractionValidationResult> {
  const startedAt = new Date().toISOString();
  const targets = buildRuntimeSmokeTargets(options.planSpec);
  const tracker = new RuntimeInteractionCoverageTracker(targets);
  const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
  const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_SMOKE_NAVIGATION_TIMEOUT_MS;
  const devPort = await reserveFreePort();
  const devServerUrl = `http://127.0.0.1:${devPort}`;
  const config: TemplateInteractiveRuntimeValidation = {
    enabled: false,
    coverageThreshold: 1,
    idleTimeoutMs: 0,
    readyTimeoutMs,
    devServerStep: options.devServerStep,
  };

  let output = "";
  let child: ChildProcess | null = null;
  let managedDevServer: ManagedDevServerProcess | null = null;
  let devServerProcessCleanup: DevServerProcessCleanupResult | undefined;
  let browser: SmokeBrowser | null = null;
  let failureReason: string | null = null;
  let failureRecord: RuntimeInteractionRequestRecord | undefined;
  let stopping = false;
  let pendingOutputLine = "";

  const buildFailureChain = (): RuntimeInteractionFailureChain | undefined => {
    if (!failureReason) {
      return undefined;
    }

    return {
      reason: failureReason,
      devServerUrl,
      ...(failureRecord ? { request: failureRecord } : {}),
      recentRequests: tracker.getRecentRequests(),
      recentDevServerOutput: recentOutputLines(output, 24),
    };
  };

  const finish = async (valid: boolean, reasons: string[]) => {
    stopping = true;
    if (browser) {
      await browser.close().catch(() => undefined);
      browser = null;
    }
    if (managedDevServer && !devServerProcessCleanup) {
      devServerProcessCleanup = await terminateManagedDevServerProcess(managedDevServer);
    } else if (child && !devServerProcessCleanup) {
      devServerProcessCleanup = await terminateDevServerProcess(child);
    }
    child = null;
    managedDevServer = null;

    const failureChain = buildFailureChain();
    const artifact = buildRuntimeInteractionArtifact({
      valid,
      reasons,
      validationMode: "smoke",
      ...(valid ? { completionMode: "browser_smoke" } : {}),
      devServerUrl,
      devServerOutput: output,
      ...(failureReason ? { detectedDevServerError: failureReason } : {}),
      ...(devServerProcessCleanup ? { devServerProcessCleanup } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
      config,
      tracker,
      ...(failureChain ? { failureChain } : {}),
    });
    await writeRuntimeInteractionArtifact(options.runtime.deepagentsRuntimeInteractionValidationPath, artifact);
    return artifact;
  };

  const recordDevServerOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const detectedOutputFailure = failureReason
      ? undefined
      : detectDevServerOutputFailure(`${output}${text}`) ?? detectDevServerOutputFailure(text);
    output = appendBoundedDevServerOutput(output, text);
    void fs.appendFile(options.runtime.deepagentsRuntimeValidationLogPath, text, "utf8");

    const outputWithPending = `${pendingOutputLine}${text}`;
    const outputLines = outputWithPending.split(/\r?\n/);
    pendingOutputLine = outputLines.pop() ?? "";
    for (const line of outputLines) {
      const requestRecord = parseDevServerRequestLine(line);
      if (!requestRecord) {
        continue;
      }
      const recordResult = tracker.record(requestRecord);
      if (!failureReason && recordResult.repairReason) {
        failureReason = recordResult.repairReason;
        failureRecord = recordResult.record;
      }
    }

    if (!failureReason) {
      failureReason = detectedOutputFailure ?? detectDevServerOutputFailure(output) ?? null;
    }
  };

  await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
    "=== smoke runtime validation ===",
    `$ PORT=${devPort} HOSTNAME=127.0.0.1 ${[options.devServerStep.command, ...options.devServerStep.args].join(" ")}`,
    `[smoke] Planned page targets: ${targets.map((target) => target.label).join(", ") || "none"}`,
    "",
  ]);

  try {
    await cleanupStaleNextDevServerBeforeStart({
      outputDirectory: options.runtime.outputDirectory,
      logPath: options.runtime.deepagentsRuntimeValidationLogPath,
    });

    try {
      managedDevServer = await spawnDevServer({
        step: options.devServerStep,
        cwd: options.runtime.outputDirectory,
        port: devPort,
      });
      child = managedDevServer.child;
    } catch (error) {
      const reason = `冒烟运行验证无法启动开发服务器：${errorSummary(error)}`;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] ${reason}`,
        "",
      ]);
      const artifact = await finish(false, [reason]);
      return {
        reasons: [reason],
        steps: [{ name: options.devServerStep.name, ok: false, detail: reason }],
        artifact,
      };
    }

    child.stdout?.on("data", recordDevServerOutput);
    child.stderr?.on("data", recordDevServerOutput);
    child.once("exit", (exitCode, signal) => {
      if (stopping) {
        return;
      }
      failureReason = `开发服务器提前退出，exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}。摘要：${summarizeCommandOutput(output)}`;
    });

    const readyTimeoutAt = Date.now() + readyTimeoutMs;
    while (Date.now() < readyTimeoutAt) {
      if (failureReason) {
        const artifact = await finish(false, [failureReason]);
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          `[error] ${failureReason}`,
          "",
        ]);
        return {
          reasons: [`冒烟运行验证失败：${failureReason} 详见 ${RUNTIME_VALIDATION_LOG_LABEL}。`],
          steps: [{ name: options.devServerStep.name, ok: false, detail: failureReason }],
          artifact,
        };
      }

      if (await pingDevServer(devPort)) {
        break;
      }

      await sleep(1_000);
    }

    if (!(await pingDevServer(devPort))) {
      const reason = `冒烟运行验证等待开发服务器启动超时。摘要：${summarizeCommandOutput(output)}`;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] ${reason}`,
        "",
      ]);
      const artifact = await finish(false, [reason]);
      return {
        reasons: [reason],
        steps: [{ name: options.devServerStep.name, ok: false, detail: reason }],
        artifact,
      };
    }

    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[smoke] Dev server ready at ${devServerUrl}.`,
      "",
    ]);

    try {
      const launcher = options.browserLauncher ?? await loadPlaywrightChromium();
      browser = await launcher.launch({ headless: true });
    } catch (error) {
      const reason = `冒烟运行验证无法启动 Playwright Chromium：${addPlaywrightBrowserInstallHint(errorSummary(error))}`;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] ${reason}`,
        "",
      ]);
      const artifact = await finish(false, [reason]);
      return {
        reasons: [reason],
        steps: [{ name: "browser smoke runtime validation", ok: false, detail: reason }],
        artifact,
      };
    }

    const reasons: string[] = [];
    for (const target of targets) {
      if (failureReason) {
        reasons.push(failureReason);
        break;
      }

      const smokePath = runtimeInteractionTargetToProbePath(target);
      const smokeUrl = `${devServerUrl}${smokePath}`;
      const page = await browser.newPage();
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const responseFailures: string[] = [];
      const startedRequestAt = Date.now();

      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(formatSmokeConsoleMessage(message));
        }
      });
      page.on("pageerror", (error) => {
        pageErrors.push(errorSummary(error));
      });
      page.on("response", (response) => {
        if (responseBelongsToDevServer(response, devServerUrl) && response.status() >= 500) {
          responseFailures.push(`${response.status()} ${response.url()}`);
        }
      });

      let mainResponse: SmokeResponse | null = null;
      let navigationError: string | undefined;
      try {
        mainResponse = await page.goto(smokeUrl, {
          waitUntil: "networkidle",
          timeout: navigationTimeoutMs,
        });
      } catch (error) {
        navigationError = errorSummary(error);
      }

      const status = mainResponse?.status();
      const responseBodyLength = navigationError
        ? undefined
        : await page.evaluate(() => document.body?.innerText?.trim().length ?? 0).catch(() => undefined);
      const recordResult = tracker.record({
        source: "browser-smoke",
        method: "GET",
        path: smokePath,
        durationMs: Date.now() - startedRequestAt,
        proxiedUrl: smokeUrl,
        devServerOutputContext: recentOutputLines(output, 16),
        ...(status !== undefined ? { status } : {}),
        ...(navigationError ? { errorSummary: navigationError } : {}),
        ...(responseBodyLength !== undefined
          ? { responseBodySummary: `[browser innerText length: ${responseBodyLength}]` }
          : {}),
      }, {
        countNotFoundAsCovered: shouldAllowNotFoundProbeCoverage(target),
      });
      const record = recordResult.record;
      const statusLabel = record.status === undefined ? "ERR" : String(record.status);
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[smoke] GET ${smokePath} -> ${statusLabel} (${target.label})`,
        ...(navigationError ? [`[smoke] navigation error: ${navigationError}`] : []),
        ...(responseBodyLength !== undefined ? [`[smoke] body innerText length: ${responseBodyLength}`] : []),
        ...pageErrors.map((error) => `[smoke] pageerror: ${error}`),
        ...consoleErrors.map((error) => `[smoke] console.error: ${error}`),
        ...responseFailures.map((failure) => `[smoke] HTTP 5xx response: ${failure}`),
      ]);

      const targetReasons = [
        navigationError ? `冒烟运行验证导航失败：GET ${smokePath}。${navigationError}` : undefined,
        !navigationError && !mainResponse ? `冒烟运行验证没有收到导航响应：GET ${smokePath}` : undefined,
        recordResult.repairReason,
        status === 404 && !shouldAllowNotFoundProbeCoverage(target)
          ? `冒烟运行验证页面返回 404：GET ${smokePath}（目标：${target.label}）`
          : undefined,
        !navigationError && status !== 404 && responseBodyLength === 0
          ? `冒烟运行验证渲染空白页：GET ${smokePath}（目标：${target.label}）`
          : undefined,
        ...pageErrors.map((error) => `冒烟运行验证捕获 pageerror：GET ${smokePath}。${error}`),
        ...consoleErrors.map((error) => `冒烟运行验证捕获 console.error：GET ${smokePath}。${error}`),
        ...responseFailures.map((failure) => `冒烟运行验证捕获 HTTP 5xx 响应：${failure}`),
      ].filter((reason): reason is string => Boolean(reason));

      if (targetReasons.length > 0) {
        reasons.push(...targetReasons);
        if (!failureReason) {
          failureReason = targetReasons[0] ?? null;
          failureRecord = record;
        }
      }

      await page.close?.().catch(() => undefined);
    }

    const coverage = tracker.getSummary();
    if (coverage.covered < coverage.total) {
      reasons.push(
        `冒烟运行验证覆盖不足：${coverage.covered}/${coverage.total}。未覆盖：${coverage.uncoveredTargets.join(", ") || "无"}`,
      );
    }

    if (reasons.length > 0) {
      const artifact = await finish(false, reasons);
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        ...reasons.map((reason) => `[error] ${reason}`),
        `[error] Smoke runtime validation failed. Covered ${coverage.covered}/${coverage.total}.`,
        "",
      ]);
      return {
        reasons: [`冒烟运行验证失败：${reasons.join(" | ")} 详见 ${RUNTIME_VALIDATION_LOG_LABEL}。`],
        steps: [{
          name: "browser smoke runtime validation",
          ok: false,
          detail: `真实浏览器访问 ${coverage.covered}/${coverage.total} 个页面目标后失败：${reasons.join(" | ")}`,
        }],
        artifact,
      };
    }

    const artifact = await finish(true, []);
    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[ok] Smoke runtime validation rendered all ${coverage.total} page targets in headless Chromium with no pageerror, console.error, HTTP 5xx, non-dynamic 404, blank render, or dev server error output.`,
      "",
    ]);
    return {
      reasons: [],
      steps: [{
        name: "browser smoke runtime validation",
        ok: true,
        detail: `冒烟运行验证已启动 dev server，并用真实浏览器渲染全部 ${coverage.total} 个页面目标。`,
      }],
      artifact,
    };
  } finally {
    child?.stdout?.off("data", recordDevServerOutput);
    child?.stderr?.off("data", recordDevServerOutput);
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    if ((child || managedDevServer) && !devServerProcessCleanup) {
      stopping = true;
      if (managedDevServer) {
        await terminateManagedDevServerProcess(managedDevServer);
      } else if (child) {
        await terminateDevServerProcess(child);
      }
    }
  }
}

export async function runInteractiveRuntimeValidation(options: {
  runtime: TextGeneratorRuntime;
  planSpec: PlanSpec;
  config: TemplateInteractiveRuntimeValidation;
  session?: RuntimeInteractionValidationSession;
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

  const devPort = options.session?.devPort ?? await reserveFreePort();
  if (options.session && options.session.devPort === undefined) {
    options.session.devPort = devPort;
  }
  if (options.session) {
    options.session.devServerLogPath = options.runtime.deepagentsRuntimeValidationLogPath;
  }
  const devServerUrl = `http://127.0.0.1:${devPort}`;
  let proxyUrl: string | undefined;
  let validationUrl: string | undefined;
  let output = "";
  let stopping = false;
  let failureReason: string | null = null;
  let failureRecord: RuntimeInteractionRequestRecord | undefined;
  let manualCompletionRequested = false;
  let manualCompleted = false;
  let implementationRequest: RuntimeInteractionImplementationRequest | undefined;
  let browserOpenResult: BrowserOpenResult | undefined;
  let browserOpenReused = false;
  let lastActivityAt = Date.now();
  let persistQueue = Promise.resolve();
  let child: ChildProcess | null = null;
  let managedDevServer: ManagedDevServerProcess | null = null;
  let devServerProcessCleanup: DevServerProcessCleanupResult | undefined;
  let proxyServer: HttpServer | null = null;
  let pendingOutputLine = "";
  let finished = false;
  let lastCoverageWaitPersistAt = 0;
  let removeDevServerOutputListener: (() => void) | undefined;
  let removeDevServerExitListener: (() => void) | undefined;

  const buildFailureChain = (): RuntimeInteractionFailureChain | undefined => {
    if (!failureReason) {
      return undefined;
    }

    return {
      reason: failureReason,
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(validationUrl ? { validationUrl } : {}),
      devServerUrl,
      ...(failureRecord ? { request: failureRecord } : {}),
      recentRequests: tracker.getRecentRequests(),
      recentDevServerOutput: recentOutputLines(output, 24),
    };
  };

  const persist = async (valid: boolean, reasons: string[], completedAt?: string) => {
    const includeFailure = !manualCompleted;
    const failureChain = includeFailure ? buildFailureChain() : undefined;
    const artifact = buildRuntimeInteractionArtifact({
      valid,
      reasons,
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(validationUrl ? { validationUrl } : {}),
      ...(manualCompleted ? { manualCompleted } : {}),
      ...(implementationRequest ? { implementationRequest } : {}),
      devServerUrl,
      ...(browserOpenResult ? { browserOpenResult } : {}),
      devServerOutput: output,
      ...(includeFailure && failureReason ? { detectedDevServerError: failureReason } : {}),
      ...(devServerProcessCleanup ? { devServerProcessCleanup } : {}),
      startedAt,
      ...(completedAt ? { completedAt } : {}),
      config,
      tracker,
      ...(failureChain ? { failureChain } : {}),
    });
    await writeRuntimeInteractionArtifact(options.runtime.deepagentsRuntimeInteractionValidationPath, artifact);
    return artifact;
  };

  const queuePersist = (valid: boolean, reasons: string[]) => {
    if (finished) {
      return persistQueue;
    }

    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => persist(valid, reasons).then(() => undefined));
    return persistQueue;
  };

  const finish = async (valid: boolean, reasons: string[]) => {
    finished = true;
    await persistQueue;
    return await persist(valid, reasons, new Date().toISOString());
  };

  const stopDevServerBeforeRepair = async (reason: string) => {
    if (!child || devServerProcessCleanup) {
      return;
    }

    stopping = true;
    if (options.session?.devServerProcess) {
      devServerProcessCleanup = await closeRuntimeInteractionValidationSession(options.session);
    } else if (managedDevServer) {
      devServerProcessCleanup = await terminateManagedDevServerProcess(managedDevServer);
    } else {
      devServerProcessCleanup = await terminateDevServerProcess(child);
    }
    child = null;
    managedDevServer = null;
    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[interactive] Stopped failing dev server before repair: ${reason}`,
      devServerProcessCleanup
        ? `[interactive] Dev server cleanup attempted=${devServerProcessCleanup.attempted} exited=${devServerProcessCleanup.exited} forced=${devServerProcessCleanup.forced} pids=${devServerProcessCleanup.killedPids.join(",") || "none"}.`
        : "[interactive] Dev server cleanup skipped: no live process was recorded.",
      "",
    ]);
  };

  const publishUpdate = async () => {
    if (!options.onUpdate) {
      return;
    }
    await options.onUpdate({
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(validationUrl ? { validationUrl } : {}),
      ...(implementationRequest ? { implementationRequest } : {}),
      devServerUrl,
      ...(browserOpenResult
        ? {
          browserOpenAttempted: browserOpenResult.attempted,
          browserOpened: browserOpenResult.opened,
          ...(browserOpenReused ? { browserOpenReused } : {}),
          ...(browserOpenResult.error ? { browserOpenError: browserOpenResult.error } : {}),
        }
        : {}),
      coverage: tracker.getSummary(),
      recentRequests: tracker.getRecentRequests(),
      recentDevServerOutput: recentOutputLines(output),
    });
  };

  const recordDevServerOutput = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const detectedOutputFailure = failureReason
      ? undefined
      : detectDevServerOutputFailure(`${output}${text}`) ?? detectDevServerOutputFailure(text);
    output = appendBoundedDevServerOutput(output, text);
    lastActivityAt = Date.now();

    const outputWithPending = `${pendingOutputLine}${text}`;
    const outputLines = outputWithPending.split(/\r?\n/);
    pendingOutputLine = outputLines.pop() ?? "";
    for (const line of outputLines) {
      const requestRecord = parseDevServerRequestLine(line);
      if (!requestRecord) {
        continue;
      }

      const recordResult = tracker.record(requestRecord);
      if (!failureReason && recordResult.repairReason) {
        failureReason = recordResult.repairReason;
        failureRecord = recordResult.record;
      }
    }

    if (!failureReason) {
      failureReason = detectedOutputFailure ?? detectDevServerOutputFailure(output) ?? null;
    }
    if (!options.session) {
      void fs.appendFile(options.runtime.deepagentsRuntimeValidationLogPath, text, "utf8");
    }
    void queuePersist(false, failureReason ? [failureReason] : []);
    void publishUpdate();
  };

  await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
    "=== interactive runtime validation ===",
  ]);

  const existingChild = options.session?.devServerProcess;
  if (existingChild && !isChildProcessRunning(existingChild) && options.session) {
    clearSessionDevServerProcess(options.session);
  }

  const reusableChild = options.session?.devServerProcess;
  if (reusableChild && isChildProcessRunning(reusableChild)) {
    child = reusableChild;
    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[interactive] Reusing existing dev server process at ${devServerUrl}; command not restarted.`,
      "",
    ]);
  } else {
    await cleanupStaleNextDevServerBeforeStart({
      outputDirectory: options.runtime.outputDirectory,
      logPath: options.runtime.deepagentsRuntimeValidationLogPath,
    });
    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `$ PORT=${devPort} HOSTNAME=127.0.0.1 ${[devServerStep.command, ...devServerStep.args].join(" ")}`,
      "",
    ]);
    try {
      managedDevServer = await spawnDevServer({
        step: devServerStep,
        cwd: options.runtime.outputDirectory,
        port: devPort,
      });
      child = managedDevServer.child;
      if (options.session) {
        attachDevServerProcessToSession(options.session, managedDevServer, options.runtime.deepagentsRuntimeValidationLogPath);
      }
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
  }

  if (options.session) {
    const listeners = ensureSessionOutputListeners(options.session);
    listeners.add(recordDevServerOutput);
    removeDevServerOutputListener = () => listeners.delete(recordDevServerOutput);
    if (managedDevServer && options.session.devServerOutput) {
      const bufferedOutput = options.session.devServerOutput;
      output = appendBoundedDevServerOutput(output, bufferedOutput);
      failureReason = detectDevServerOutputFailure(bufferedOutput) ?? failureReason;
    }
  } else {
    child.stdout!.on("data", recordDevServerOutput);
    child.stderr!.on("data", recordDevServerOutput);
    removeDevServerOutputListener = () => {
      child?.stdout?.off("data", recordDevServerOutput);
      child?.stderr?.off("data", recordDevServerOutput);
    };
  }

  const onDevServerExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (stopping) {
      return;
    }
    failureReason = `开发服务器提前退出，exitCode=${exitCode ?? "null"} signal=${signal ?? "null"}。摘要：${summarizeCommandOutput(output)}`;
  };
  child.once("exit", onDevServerExit);
  removeDevServerExitListener = () => child?.off("exit", onDevServerExit);

  try {
    const readyTimeoutAt = Date.now() + config.readyTimeoutMs;
    while (Date.now() < readyTimeoutAt) {
      if (failureReason) {
        await stopDevServerBeforeRepair(failureReason);
        const artifact = await finish(false, [failureReason]);
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
      await stopDevServerBeforeRepair(reason);
      const artifact = await finish(false, [reason]);
      return {
        reasons: [reason],
        steps: [{ name: "interactive runtime validation", ok: false, detail: reason }],
        artifact,
      };
    }

    try {
      const proxy = await startDevServerProxy({
        devPort,
        ...(options.session?.proxyPort !== undefined ? { proxyPort: options.session.proxyPort } : {}),
        devServerUrl,
        tracker,
        logPath: options.runtime.deepagentsRuntimeValidationLogPath,
        getDevServerOutput: () => output,
        onActivity: () => {
          lastActivityAt = Date.now();
        },
        onFailure: (reason, record) => {
          if (!failureReason) {
            failureReason = reason;
            failureRecord = record;
          }
        },
        onManualComplete: () => {
          manualCompletionRequested = true;
        },
        onImplementationRequest: (request) => {
          implementationRequest = request;
        },
        onRecordedRequest: () => {
          void queuePersist(false, failureReason ? [failureReason] : []);
          void publishUpdate();
        },
      });
      proxyServer = proxy.server;
      proxyUrl = proxy.proxyUrl;
      validationUrl = validationUrlForProxy(proxyUrl);
      if (options.session && options.session.proxyPort === undefined) {
        options.session.proxyPort = Number(new URL(proxyUrl).port);
      }
    } catch (error) {
      const reason = `交互式运行验证无法启动本地请求代理：${errorSummary(error)}`;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        `[error] ${reason}`,
        "",
      ]);
      await stopDevServerBeforeRepair(reason);
      const artifact = await finish(false, [reason]);
      return {
        reasons: [reason],
        steps: [{ name: "interactive runtime validation", ok: false, detail: reason }],
        artifact,
      };
    }

    await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
      `[interactive] Dev server ready at ${devServerUrl}.`,
      `[interactive] Proxy ready at ${proxyUrl}.`,
      `[interactive] Visit validation URL: ${validationUrl}`,
      `[interactive] Visit proxy URL (diagnostic): ${proxyUrl}`,
      `[interactive] Runtime repair signal combines proxy HTTP request/response records with dev server stdout/stderr.`,
      `[interactive] Planned targets: ${targets.map((target) => target.label).join(", ")}`,
      "",
    ]);

    const browserUrl = validationUrl ?? proxyUrl ?? devServerUrl;
    if (options.session?.browserOpenResult) {
      browserOpenResult = options.session.browserOpenResult;
      browserOpenReused = true;
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        browserOpenResult.opened
          ? `[interactive] Reusing previously opened browser at ${options.session.browserOpenUrl ?? browserUrl}.`
          : `[interactive] Reusing previous browser open attempt and not spawning another browser process for ${options.session.browserOpenUrl ?? browserUrl}.`,
        "",
      ]);
    } else if (shouldOpenBrowser(options.openBrowser)) {
      const opener = options.browserOpener ?? openUrlInDefaultBrowser;
      browserOpenResult = await opener(browserUrl);
      if (options.session) {
        options.session.browserOpenResult = browserOpenResult;
        options.session.browserOpenUrl = browserUrl;
      }
      await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
        browserOpenResult.opened
          ? `[interactive] Opened default browser at ${browserUrl}.`
          : `[warn] Failed to open default browser at ${browserUrl}: ${browserOpenResult.error ?? "unknown error"}`,
        "",
      ]);
    }

    lastActivityAt = Date.now();
    await persist(false, []);
    await publishUpdate();
    await options.onReady?.({
      ...(proxyUrl ? { proxyUrl } : {}),
      ...(validationUrl ? { validationUrl } : {}),
      devServerUrl,
      ...(browserOpenResult
        ? {
            browserOpenAttempted: browserOpenResult.attempted,
            browserOpened: browserOpenResult.opened,
            ...(browserOpenReused ? { browserOpenReused } : {}),
            ...(browserOpenResult.error ? { browserOpenError: browserOpenResult.error } : {}),
          }
        : {}),
      targets,
    });

    while (true) {
      if (manualCompletionRequested) {
        manualCompleted = true;
        const artifact = await finish(true, []);
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          "[ok] Runtime validation manually completed from /validate.",
          "",
        ]);
        return {
          reasons: [],
          steps: [{
            name: "interactive runtime validation",
            ok: true,
            detail: `运行验证已由用户在 ${validationUrl ?? proxyUrl ?? devServerUrl} 人工确认完成。`,
          }],
          artifact,
        };
      }

      if (implementationRequest) {
        const requirementSummary = summarizeImplementationRequirement(implementationRequest.requirement);
        const reason = `用户在运行验证页提交实现要求：${requirementSummary}`;
        await stopDevServerBeforeRepair(reason);
        const artifact = await finish(false, [reason]);
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          `[repair] Runtime validation implementation request from /validate: ${requirementSummary}`,
          "",
        ]);
        return {
          reasons: [reason],
          steps: [{
            name: "interactive runtime validation",
            ok: false,
            detail: reason,
          }],
          artifact,
        };
      }

      if (failureReason) {
        await stopDevServerBeforeRepair(failureReason);
        const artifact = await finish(false, [failureReason]);
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          `[error] ${failureReason}`,
          "",
        ]);
        return {
          reasons: [`交互式运行验证失败：${failureReason} 详见 ${RUNTIME_VALIDATION_LOG_LABEL}。`],
          steps: [{
            name: "interactive runtime validation",
            ok: false,
            detail: failureReason,
          }],
          artifact,
        };
      }

      const idleForMs = Date.now() - lastActivityAt;
      const coverage = tracker.getSummary();
      const coverageSatisfied = coverage.ratio >= config.coverageThreshold;

      if (idleForMs >= config.idleTimeoutMs && coverageSatisfied) {
        const artifact = await finish(true, []);
        await appendRuntimeValidationLog(options.runtime.deepagentsRuntimeValidationLogPath, [
          `[ok] Runtime coverage ${coverage.covered}/${coverage.total} (${Math.round(coverage.ratio * 100)}%) reached threshold ${Math.round(config.coverageThreshold * 100)}%, and dev server stayed ready with no error output for ${Math.round(idleForMs / 1000)}s.`,
          "",
        ]);
        return {
          reasons: [],
          steps: [{
            name: "interactive runtime validation",
            ok: true,
            detail: `运行覆盖率 ${coverage.covered}/${coverage.total} 已达到 ${Math.round(config.coverageThreshold * 100)}%，代理 ${proxyUrl ?? devServerUrl} 已稳定 ${Math.round(idleForMs / 1000)}s，未检测到 API 401/403、HTTP 5xx、代理错误或 dev server 错误输出。`,
          }],
          artifact,
        };
      }

      if (idleForMs >= config.idleTimeoutMs && !coverageSatisfied) {
        const now = Date.now();
        if (now - lastCoverageWaitPersistAt >= 1_000) {
          lastCoverageWaitPersistAt = now;
          const reason = `交互式运行验证覆盖率不足：${coverage.covered}/${coverage.total} (${Math.round(coverage.ratio * 100)}%)，需要达到 ${Math.round(config.coverageThreshold * 100)}%。未覆盖：${coverage.uncoveredTargets.join(", ") || "无"}`;
          await persist(false, [reason]);
          await publishUpdate();
        }
      }

      await sleep(REQUEST_POLL_INTERVAL_MS);
    }
  } finally {
    stopping = true;
    removeDevServerOutputListener?.();
    removeDevServerExitListener?.();
    if (proxyServer) {
      await closeHttpServer(proxyServer);
    }
    if (child && !options.session) {
      if (managedDevServer) {
        await terminateManagedDevServerProcess(managedDevServer);
      } else {
        await terminateDevServerProcess(child);
      }
    }
  }
}
