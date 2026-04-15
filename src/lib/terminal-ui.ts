import React from "react";
import path from "node:path";
import { promises as fs } from "node:fs";

import { Box, Text, render, renderToString, type Instance } from "ink";

import { validatePlanSpec, type PlanSpec } from "./plan-spec.js";

export type WorkflowStage = "计划阶段" | "生成阶段";
export type TodoStatus = "pending" | "in_progress" | "completed";
export type ArtifactStatus = "pending" | "generating" | "generated" | "validating" | "verified";
export type WorkflowStageMarker = WorkflowStage | "完成阶段";

export type TodoItem = {
  content: string;
  status: TodoStatus;
};

export type ArtifactItem = {
  label: string;
  status: ArtifactStatus;
};

export type TodoBoardState = {
  stage: WorkflowStage;
  todos: TodoItem[];
  artifacts: ArtifactItem[];
  narrative: string;
  elapsedMs?: number;
  outputDirectory?: string;
  logs?: string[];
};

export type TodoBoardRenderer = {
  update(state: TodoBoardState): Promise<void>;
  stop(): Promise<void>;
};

const WORKFLOW_STAGE_SEQUENCE: WorkflowStageMarker[] = ["计划阶段", "生成阶段", "完成阶段"];
type WorkflowLogPrefixColor = "cyan" | "yellow" | "magenta" | "blue" | "green" | "red" | "gray";

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

export function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function visibleTextWidth(input: string): number {
  let width = 0;

  for (const char of stripAnsi(input)) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }

  return width;
}

export function estimateRenderedRows(lines: string[], columns: number): number {
  const safeColumns = Math.max(columns, 1);

  return lines.reduce((total, line) => {
    const width = visibleTextWidth(line);
    return total + Math.max(1, Math.ceil(width / safeColumns));
  }, 0);
}

export function renderTodoStatus(status: TodoStatus): string {
  switch (status) {
    case "completed":
      return "✅";
    case "in_progress":
      return "✳️";
    default:
      return "✴️";
  }
}

export function formatTodoHeader(completedCount: number, totalCount: number): string {
  return `执行步骤（${completedCount}/${totalCount}）：`;
}

export function formatArtifactHeader(): string {
  return "关键产出物：";
}

export function formatWorkflowStageLine(activeStage: WorkflowStageMarker): string {
  return WORKFLOW_STAGE_SEQUENCE
    .map((stage) => (stage === activeStage ? `[${stage}]` : stage))
    .join(" -> ");
}

export function formatLogHeader(): string {
  return "详细日志：";
}

export function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function getVisibleLogs(logs: string[], limit = 8): string[] {
  return logs.slice(-limit);
}

function normalizeRelativePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadPlanSpecFromOutput(outputDirectory: string): Promise<PlanSpec | null> {
  const planSpecPath = path.join(outputDirectory, ".deepagents", "plan-spec.json");
  try {
    const contents = await fs.readFile(planSpecPath, "utf8");
    const parsed = JSON.parse(contents);
    const validation = validatePlanSpec(parsed);
    return validation.success ? validation.data : null;
  } catch {
    return null;
  }
}

function routeToPageFileCandidates(route: string): string[] {
  const cleanRoute = route.replace(/^\/+|\/+$/g, "");
  if (!cleanRoute) {
    return [
      "app/page.tsx",
      "app/(admin)/page.tsx",
      "app/(full-width-pages)/page.tsx",
    ];
  }

  const routePagePath = path.posix.join("app", cleanRoute, "page.tsx");
  return [
    routePagePath,
    path.posix.join("app", "(admin)", cleanRoute, "page.tsx"),
    path.posix.join("app", "(full-width-pages)", cleanRoute, "page.tsx"),
  ];
}

async function countExistingFiles(outputDirectory: string, candidates: string[]): Promise<number> {
  let count = 0;

  for (const candidate of candidates) {
    if (await pathExists(path.join(outputDirectory, normalizeRelativePath(candidate)))) {
      count += 1;
    }
  }

  return count;
}

function decorateProgressLabel(baseLabel: string, completed: number, total: number): string {
  return `${baseLabel}（${completed}/${total}）`;
}

async function monitorArtifactItems(state: TodoBoardState): Promise<ArtifactItem[]> {
  if (!state.outputDirectory) {
    return state.artifacts;
  }

  const planSpec = await loadPlanSpecFromOutput(state.outputDirectory);
  const monitoredArtifacts: ArtifactItem[] = [];

  for (const artifact of state.artifacts) {
    if (artifact.status === "verified") {
      monitoredArtifacts.push(artifact);
      continue;
    }

    if (artifact.label.startsWith(".deepagents/")) {
      const artifactPath = path.join(state.outputDirectory, normalizeRelativePath(artifact.label));
      const exists = await pathExists(artifactPath);
      monitoredArtifacts.push({
        label: artifact.label,
        status: exists ? "generated" : artifact.status,
      });
      continue;
    }

    if (artifact.label === "app-builder-report.md") {
      const exists = await pathExists(path.join(state.outputDirectory, "app-builder-report.md"));
      monitoredArtifacts.push({
        label: artifact.label,
        status: exists ? "generated" : artifact.status,
      });
      continue;
    }

    if (artifact.label.startsWith("app/api/**") && planSpec) {
      const apiPaths = planSpec.apis.map((api) => normalizeRelativePath(api.path));
      const completed = await countExistingFiles(state.outputDirectory, apiPaths);
      monitoredArtifacts.push({
        label: decorateProgressLabel("app/api/**", completed, apiPaths.length),
        status: completed === 0 ? artifact.status : completed >= apiPaths.length ? "generated" : "generating",
      });
      continue;
    }

    if (artifact.label.startsWith("app/** 页面与布局") && planSpec) {
      let completed = 0;
      for (const page of planSpec.pages) {
        const candidates = routeToPageFileCandidates(page.route);
        const found = await countExistingFiles(state.outputDirectory, candidates);
        if (found > 0) {
          completed += 1;
        }
      }

      monitoredArtifacts.push({
        label: decorateProgressLabel("app/** 页面与布局", completed, planSpec.pages.length),
        status: completed === 0 ? artifact.status : completed >= planSpec.pages.length ? "generated" : "generating",
      });
      continue;
    }

    monitoredArtifacts.push(artifact);
  }

  return monitoredArtifacts;
}

function detectWorkflowLogPrefix(content: string): { prefix: string; color: WorkflowLogPrefixColor } {
  if (/读取文件|列出目录|搜索文件/.test(content)) {
    return { prefix: "[READ]", color: "cyan" };
  }

  if (/写入文件|编辑文件/.test(content)) {
    return { prefix: "[WRITE]", color: "yellow" };
  }

  if (/更新 todo|更新|补齐|实现/.test(content)) {
    return { prefix: "[UPDATE]", color: "magenta" };
  }

  if (/修复|轮次/.test(content)) {
    return { prefix: "[FIX]", color: "magenta" };
  }

  if (/校验|验证|复核/.test(content)) {
    return { prefix: "[CHECK]", color: "blue" };
  }

  if (/通过|完成|结束|汇总/.test(content)) {
    return { prefix: "[DONE]", color: "green" };
  }

  return { prefix: "[FLOW]", color: "gray" };
}

function parseWorkflowLogLine(logLine: string): {
  timestamp: string | null;
  prefix: string;
  prefixColor: WorkflowLogPrefixColor;
  message: string;
} {
  const match = logLine.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+(\[[^\]]+\])\s+(.*)$/);
  if (match) {
    const timestamp = match[1] ?? null;
    const prefix = match[2] ?? "[流]";
    const message = match[3] ?? logLine;
    const color = detectWorkflowLogPrefix(message).color;
    return {
      timestamp,
      prefix,
      prefixColor: color,
      message,
    };
  }

  const detected = detectWorkflowLogPrefix(logLine);
  return {
    timestamp: null,
    prefix: detected.prefix,
    prefixColor: detected.color,
    message: logLine,
  };
}

function buildActionLine(state: TodoBoardState): string {
  return `当前动作：${state.narrative}`;
}

function buildTodoHeader(state: TodoBoardState): string {
  const completedCount = state.todos.filter((todo) => todo.status === "completed").length;
  return formatTodoHeader(completedCount, state.todos.length);
}

export function buildTodoBoardLines(state: TodoBoardState): string[] {
  if (state.todos.length === 0 && state.artifacts.length === 0) {
    return [buildActionLine(state)];
  }

  const lines = [
    formatWorkflowStageLine(state.stage),
    `总耗时：${formatElapsedTime(state.elapsedMs ?? 0)}`,
    "",
    buildTodoHeader(state),
  ];
  for (const todo of state.todos) {
    lines.push(`  ${renderTodoStatus(todo.status)} ${todo.content}`);
  }
  lines.push("");
  lines.push(buildActionLine(state));
  if (state.logs && state.logs.length > 0) {
    lines.push("");
    lines.push(formatLogHeader());
    for (const logLine of getVisibleLogs(state.logs)) {
      lines.push(`  ${logLine}`);
    }
  }
  if (state.artifacts.length > 0) {
    lines.push("");
    lines.push(formatArtifactHeader());
    for (const artifact of state.artifacts) {
      lines.push(`  ${renderArtifactStatus(artifact.status)} ${artifact.label}`);
    }
  }
  return lines;
}

function colorForStatus(status: TodoStatus): "green" | "yellow" | "gray" {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return "yellow";
    default:
      return "gray";
  }
}

function borderColorForStage(stage: TodoBoardState["stage"]): "cyan" | "green" {
  return stage === "计划阶段" ? "cyan" : "green";
}

function artifactColorForStatus(status: ArtifactStatus): "gray" | "yellow" | "blue" | "green" {
  switch (status) {
    case "verified":
    case "generated":
      return "green";
    case "validating":
      return "blue";
    case "pending":
      return "gray";
    default:
      return "yellow";
  }
}

export function renderArtifactStatus(status: ArtifactStatus): string {
  switch (status) {
    case "verified":
      return "[已验证]";
    case "generated":
      return "[已生成]";
    case "validating":
      return "[验证中]";
    case "pending":
      return "[待生成]";
    default:
      return "[生成中]";
  }
}

export function createDefaultStepItems(stage: WorkflowStage): TodoItem[] {
  if (stage === "计划阶段") {
    return [
      { content: "读取 PRD 与模板上下文", status: "in_progress" },
      { content: "整理分析稿与详细 spec", status: "pending" },
      { content: "写入结构化 plan-spec.json", status: "pending" },
      { content: "等待宿主校验计划阶段产物", status: "pending" },
    ];
  }

  return [
    { content: "读取已验证的 planSpec 与 starter", status: "in_progress" },
    { content: "实现资源模型与 REST API", status: "pending" },
    { content: "补齐页面接线与交付文件", status: "pending" },
    { content: "等待宿主校验生成阶段产物", status: "pending" },
  ];
}

export function createStepItemsForLifecycle(stage: WorkflowStage, lifecycle: ArtifactStatus): TodoItem[] {
  const defaults = createDefaultStepItems(stage);

  if (lifecycle === "verified") {
    return defaults.map((todo) => ({ ...todo, status: "completed" }));
  }

  if (lifecycle === "validating") {
    return defaults.map((todo, index) => ({
      ...todo,
      status: index === defaults.length - 1 ? "in_progress" : "completed",
    }));
  }

  return defaults;
}

export function createArtifactItemsForStage(stage: WorkflowStage, status: ArtifactStatus): ArtifactItem[] {
  const planArtifacts: ArtifactItem[] = [
    { label: ".deepagents/prd-analysis.md", status: stage === "计划阶段" ? status : "verified" },
    { label: ".deepagents/generated-spec.md", status: stage === "计划阶段" ? status : "verified" },
    { label: ".deepagents/plan-spec.json", status: stage === "计划阶段" ? status : "verified" },
    { label: ".deepagents/plan-validation.json", status: stage === "计划阶段" ? status : "verified" },
  ];

  const generationArtifacts: ArtifactItem[] = [
    { label: "app/api/**", status: stage === "生成阶段" ? status : "pending" },
    { label: "app/** 页面与布局", status: stage === "生成阶段" ? status : "pending" },
    { label: "app-builder-report.md", status: stage === "生成阶段" ? status : "pending" },
    { label: ".deepagents/generation-validation.json", status: stage === "生成阶段" ? status : "pending" },
  ];

  return [...planArtifacts, ...generationArtifacts];
}

function createTodoBoardElement(state: TodoBoardState) {
  const borderColor = borderColorForStage(state.stage);

  return React.createElement(
    Box,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor,
      paddingX: 1,
    },
    [
      React.createElement(
        Box,
        {
          key: "header-row",
          justifyContent: "space-between",
        },
        [
          React.createElement(
            Box,
            {
              key: "stage-flow",
              flexDirection: "row",
              flexGrow: 1,
              flexWrap: "wrap",
            },
            WORKFLOW_STAGE_SEQUENCE.flatMap((stage, index) => {
              const stageProps =
                stage === state.stage
                  ? {
                      key: `stage-${stage}`,
                      color: "black" as const,
                      backgroundColor: borderColor,
                      bold: true,
                    }
                  : {
                      key: `stage-${stage}`,
                      color: "gray" as const,
                      bold: false,
                    };

              const nodes: React.ReactNode[] = [
                React.createElement(
                  Text,
                  stageProps,
                  stage,
                ),
              ];

              if (index < WORKFLOW_STAGE_SEQUENCE.length - 1) {
                nodes.push(
                  React.createElement(
                    Text,
                    {
                      key: `arrow-${stage}`,
                      color: "gray",
                    },
                    " -> ",
                  ),
                );
              }

              return nodes;
            }),
          ),
          React.createElement(
            Text,
            {
              key: "elapsed",
              color: "green",
            },
            `总耗时：${formatElapsedTime(state.elapsedMs ?? 0)}`,
          ),
        ],
      ),
      React.createElement(
        Box,
        {
          key: "body",
          flexDirection: "row",
          marginTop: 1,
          columnGap: 3,
        },
        [
          React.createElement(
            Box,
            {
              key: "steps-panel",
              flexDirection: "column",
              width: "60%",
            },
            [
              React.createElement(
                Text,
                {
                  key: "steps-title",
                  bold: true,
                },
                buildTodoHeader(state),
              ),
              ...state.todos.map((todo, index) =>
                React.createElement(
                  Text,
                  {
                    key: `todo-${index}`,
                    color: colorForStatus(todo.status),
                  },
                  `${renderTodoStatus(todo.status)} ${todo.content}`,
                )
              ),
              React.createElement(
                Box,
                {
                  key: "action-wrap",
                  marginTop: 1,
                },
                React.createElement(
                  Text,
                  {
                    key: "action",
                    color: "magenta",
                  },
                  buildActionLine(state),
                ),
              ),
              React.createElement(
                Box,
                {
                  key: "logs-box",
                  flexDirection: "column",
                  width: "100%",
                  marginTop: 1,
                  borderStyle: "round",
                  borderColor: "gray",
                  paddingX: 1,
                },
                [
                  React.createElement(
                    Text,
                    {
                      key: "logs-title",
                      bold: true,
                    },
                    formatLogHeader(),
                  ),
                  ...getVisibleLogs(state.logs ?? []).map((logLine, index) =>
                    React.createElement(
                      Box,
                      {
                        key: `log-${index}`,
                        flexDirection: "row",
                        flexWrap: "wrap",
                      },
                      (() => {
                        const parsed = parseWorkflowLogLine(logLine);
                        return [
                          React.createElement(
                            Text,
                            {
                              key: `log-time-${index}`,
                              color: "gray",
                            },
                            parsed.timestamp ? `[${parsed.timestamp}] ` : "",
                          ),
                          React.createElement(
                            Text,
                            {
                              key: `log-prefix-${index}`,
                              color: parsed.prefixColor,
                            },
                            `${parsed.prefix} `,
                          ),
                          React.createElement(
                            Text,
                            {
                              key: `log-message-${index}`,
                              color: "white",
                            },
                            parsed.message,
                          ),
                        ];
                      })(),
                    )
                  ),
                ],
              ),
            ],
          ),
          React.createElement(
            Box,
            {
              key: "artifacts-panel",
              flexDirection: "column",
              width: "40%",
            },
            [
              React.createElement(
                Text,
                {
                  key: "artifacts-title",
                  bold: true,
                },
                formatArtifactHeader(),
              ),
              ...state.artifacts.map((artifact, index) =>
                React.createElement(
                  Text,
                  {
                    key: `artifact-${index}`,
                    color: artifactColorForStatus(artifact.status),
                  },
                  `${renderArtifactStatus(artifact.status)} ${artifact.label}`,
                )
              ),
            ],
          ),
        ],
      ),
    ],
  );
}

export function renderTodoBoardToString(state: TodoBoardState, columns = 80): string {
  return renderToString(createTodoBoardElement(state), { columns });
}

class PlainTodoBoardRenderer implements TodoBoardRenderer {
  private lastFrame = "";

  constructor(private readonly stdout: NodeJS.WriteStream) {}

  async update(state: TodoBoardState): Promise<void> {
    const frame = buildTodoBoardLines(state).join("\n");
    if (frame === this.lastFrame) {
      return;
    }

    this.stdout.write(`${frame}\n`);
    this.lastFrame = frame;
  }

  async stop(): Promise<void> {}
}

class InkTodoBoardRenderer implements TodoBoardRenderer {
  private instance: Instance | null = null;

  constructor(
    private readonly stdout: NodeJS.WriteStream,
    private readonly stdin: NodeJS.ReadStream,
    private readonly stderr: NodeJS.WriteStream,
  ) {}

  async update(state: TodoBoardState): Promise<void> {
    const element = createTodoBoardElement(state);

    if (!this.instance) {
      this.instance = render(element, {
        stdout: this.stdout,
        stdin: this.stdin,
        stderr: this.stderr,
        exitOnCtrlC: false,
        interactive: true,
        maxFps: 20,
      });
    } else {
      this.instance.rerender(element);
    }

    await this.instance.waitUntilRenderFlush();
  }

  async stop(): Promise<void> {
    if (!this.instance) {
      return;
    }

    this.instance.unmount();
    await this.instance.waitUntilExit();
    this.instance = null;
  }
}

export function createTodoBoardRenderer(
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin,
  stderr: NodeJS.WriteStream = process.stderr,
): TodoBoardRenderer {
  if (!stdout.isTTY) {
    return new PlainTodoBoardRenderer(stdout);
  }

  return new InkTodoBoardRenderer(stdout, stdin, stderr);
}

let activeRenderer: TodoBoardRenderer | null = null;
let activeWorkflowState: TodoBoardState | null = null;
let activeWorkflowLogs: string[] = [];
let activeWorkflowStartedAt: number | null = null;
let activeWorkflowRenderedArtifacts: ArtifactItem[] | null = null;
let elapsedRefreshTimer: NodeJS.Timeout | null = null;
let artifactRefreshTimer: NodeJS.Timeout | null = null;
let artifactRefreshInFlight = false;

function trimWorkflowLogs(logs: string[], maxEntries = 200): string[] {
  return logs.slice(-maxEntries);
}

function formatWorkflowLogTimestamp(date = new Date()): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function sanitizeWorkflowLogContent(logLine: string): string {
  return logLine.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function clearWorkflowTimers(): void {
  if (elapsedRefreshTimer) {
    clearInterval(elapsedRefreshTimer);
    elapsedRefreshTimer = null;
  }

  if (artifactRefreshTimer) {
    clearInterval(artifactRefreshTimer);
    artifactRefreshTimer = null;
  }
}

async function renderActiveWorkflowState(forceArtifactRefresh = false): Promise<void> {
  if (!activeRenderer || !activeWorkflowState) {
    return;
  }

  const elapsedMs =
    activeWorkflowState.elapsedMs ??
    (activeWorkflowStartedAt === null ? 0 : Date.now() - activeWorkflowStartedAt);

  let artifacts = activeWorkflowRenderedArtifacts ?? activeWorkflowState.artifacts;

  if (forceArtifactRefresh && !artifactRefreshInFlight) {
    artifactRefreshInFlight = true;
    try {
      artifacts = await monitorArtifactItems({
        ...activeWorkflowState,
        logs: activeWorkflowLogs,
        elapsedMs,
      });
      activeWorkflowRenderedArtifacts = artifacts;
    } finally {
      artifactRefreshInFlight = false;
    }
  }

  const renderState: TodoBoardState = {
    ...activeWorkflowState,
    elapsedMs,
    artifacts,
    logs: activeWorkflowLogs,
  };

  await activeRenderer.update(renderState);
}

function ensureWorkflowTimers(): void {
  if (!elapsedRefreshTimer) {
    elapsedRefreshTimer = setInterval(() => {
      void renderActiveWorkflowState(false);
    }, 1_000);
  }

  if (!artifactRefreshTimer) {
    artifactRefreshTimer = setInterval(() => {
      void renderActiveWorkflowState(true);
    }, 30_000);
  }
}

export async function updateWorkflowBoard(state: TodoBoardState): Promise<void> {
  if (!activeRenderer) {
    activeRenderer = createTodoBoardRenderer();
  }
  if (activeWorkflowStartedAt === null) {
    activeWorkflowStartedAt = Date.now();
  }

  activeWorkflowState = {
    ...state,
    logs: state.logs ?? activeWorkflowLogs,
  };
  activeWorkflowLogs = trimWorkflowLogs(activeWorkflowState.logs ?? []);
  activeWorkflowRenderedArtifacts = activeWorkflowState.artifacts;
  ensureWorkflowTimers();

  await renderActiveWorkflowState(true);
}

export async function appendWorkflowLog(logLine: string): Promise<void> {
  const content = sanitizeWorkflowLogContent(logLine);
  if (!content || content.includes("完成")) {
    return;
  }

  const detected = detectWorkflowLogPrefix(content);

  activeWorkflowLogs = trimWorkflowLogs([
    ...activeWorkflowLogs,
    `[${formatWorkflowLogTimestamp()}] ${detected.prefix} ${content}`,
  ]);

  if (!activeRenderer || !activeWorkflowState) {
    return;
  }

  activeWorkflowState = {
    ...activeWorkflowState,
    logs: activeWorkflowLogs,
  };
  await renderActiveWorkflowState(false);
}

export async function closeWorkflowBoard(): Promise<void> {
  if (!activeRenderer) {
    activeWorkflowState = null;
    activeWorkflowLogs = [];
    activeWorkflowStartedAt = null;
    activeWorkflowRenderedArtifacts = null;
    clearWorkflowTimers();
    return;
  }

  clearWorkflowTimers();
  await activeRenderer.stop();
  activeRenderer = null;
  activeWorkflowState = null;
  activeWorkflowLogs = [];
  activeWorkflowStartedAt = null;
  activeWorkflowRenderedArtifacts = null;
}
