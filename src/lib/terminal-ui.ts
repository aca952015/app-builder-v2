import React from "react";

import { Box, Text, render, renderToString, type Instance } from "ink";

export type WorkflowStage = "计划阶段" | "生成阶段";
export type TodoStatus = "pending" | "in_progress" | "completed";
export type ArtifactStatus = "generating" | "validating" | "verified";
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

function getVisibleLogs(logs: string[], limit = 8): string[] {
  return logs.slice(-limit);
}

function translateActionToEnglish(narrative: string): string {
  const exactMap = new Map<string, string>([
    ["等待模型开始处理。", "Waiting for the model to start."],
    ["生成流程结束。", "Generation flow finished."],
    ["正在整理分析稿。", "Preparing the analysis draft."],
    ["正在验证计划阶段产出物。", "Validating planning artifacts."],
    ["计划阶段产出物已验证，通过生成门禁。", "Planning artifacts verified. Gate passed."],
    ["正在复核修复后的计划产出物。", "Re-checking repaired planning artifacts."],
    ["正在验证生成阶段交付物。", "Validating generated deliverables."],
    ["生成阶段交付物已验证，全部通过。", "Generated deliverables verified. All checks passed."],
    ["正在复核修复后的生成交付物。", "Re-checking repaired generated deliverables."],
  ]);

  const exact = exactMap.get(narrative);
  if (exact) {
    return exact;
  }

  const replacements: Array<[RegExp, string]> = [
    [/^读取文件：(.+)$/, "Reading file: $1"],
    [/^写入文件：(.+)$/, "Writing file: $1"],
    [/^写入文件完成：(.+)$/, "Finished writing file: $1"],
    [/^编辑文件：(.+)$/, "Editing file: $1"],
    [/^编辑文件完成：(.+)$/, "Finished editing file: $1"],
    [/^列出目录：(.+)$/, "Listing directory: $1"],
    [/^列出目录完成：(.+)$/, "Finished listing directory: $1"],
    [/^搜索文件：(.+)$/, "Searching files: $1"],
    [/^搜索文件完成：(.+)$/, "Finished searching files: $1"],
    [/^更新 todo。$/, "Updating todos."],
    [/^更新 todo 完成。$/, "Finished updating todos."],
    [/^调用工具 (.+)。$/, "Calling tool: $1."],
    [/^调用工具 (.+) 完成。$/, "Finished calling tool: $1."],
    [/^工具 (.+) 执行中$/, "Tool in progress: $1"],
    [/^工具 (.+) completed$/, "Tool completed: $1"],
  ];

  for (const [pattern, replacement] of replacements) {
    if (pattern.test(narrative)) {
      return narrative.replace(pattern, replacement);
    }
  }

  return narrative;
}

function detectWorkflowLogPrefix(content: string): { prefix: string; color: WorkflowLogPrefixColor } {
  if (/读取文件|列出目录|搜索文件/.test(content)) {
    return { prefix: "[读]", color: "cyan" };
  }

  if (/写入文件|编辑文件/.test(content)) {
    return { prefix: "[写]", color: "yellow" };
  }

  if (/更新 todo|更新|补齐|实现/.test(content)) {
    return { prefix: "[更]", color: "magenta" };
  }

  if (/修复|轮次/.test(content)) {
    return { prefix: "[修]", color: "magenta" };
  }

  if (/校验|验证|复核/.test(content)) {
    return { prefix: "[验]", color: "blue" };
  }

  if (/通过|完成|结束|汇总/.test(content)) {
    return { prefix: "[完]", color: "green" };
  }

  return { prefix: "[流]", color: "gray" };
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
  return `Current action: ${translateActionToEnglish(state.narrative)}`;
}

function buildTodoHeader(state: TodoBoardState): string {
  const completedCount = state.todos.filter((todo) => todo.status === "completed").length;
  return formatTodoHeader(completedCount, state.todos.length);
}

export function buildTodoBoardLines(state: TodoBoardState): string[] {
  if (state.todos.length === 0 && state.artifacts.length === 0) {
    return [buildActionLine(state)];
  }

  const lines = [formatWorkflowStageLine(state.stage), "", buildTodoHeader(state)];
  for (const todo of state.todos) {
    lines.push(`  ${renderTodoStatus(todo.status)} ${todo.content}`);
  }
  if (state.artifacts.length > 0) {
    lines.push("");
    lines.push(formatArtifactHeader());
    for (const artifact of state.artifacts) {
      lines.push(`  ${renderArtifactStatus(artifact.status)} ${artifact.label}`);
    }
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

function artifactColorForStatus(status: ArtifactStatus): "yellow" | "blue" | "green" {
  switch (status) {
    case "verified":
      return "green";
    case "validating":
      return "blue";
    default:
      return "yellow";
  }
}

export function renderArtifactStatus(status: ArtifactStatus): string {
  switch (status) {
    case "verified":
      return "[已验证]";
    case "validating":
      return "[验证中]";
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
  if (stage === "计划阶段") {
    return [
      { label: ".deepagents/prd-analysis.md", status },
      { label: ".deepagents/generated-spec.md", status },
      { label: ".deepagents/plan-spec.json", status },
      { label: ".deepagents/plan-validation.json", status },
    ];
  }

  return [
    { label: "app/api/**", status },
    { label: "app/** 页面与布局", status },
    { label: "app-builder-report.md", status },
    { label: ".deepagents/generation-validation.json", status },
  ];
}

function createTodoBoardElement(state: TodoBoardState) {
  const completedCount = state.todos.filter((todo) => todo.status === "completed").length;
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
              key: "progress",
              color: "green",
            },
            `${completedCount}/${state.todos.length}`,
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
              width: "58%",
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
            ],
          ),
          React.createElement(
            Box,
            {
              key: "artifacts-panel",
              flexDirection: "column",
              width: "42%",
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

export async function updateWorkflowBoard(state: TodoBoardState): Promise<void> {
  if (!activeRenderer) {
    activeRenderer = createTodoBoardRenderer();
  }

  activeWorkflowState = {
    ...state,
    logs: state.logs ?? activeWorkflowLogs,
  };
  activeWorkflowLogs = trimWorkflowLogs(activeWorkflowState.logs ?? []);

  await activeRenderer.update(activeWorkflowState);
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

  await activeRenderer.update(activeWorkflowState);
}

export async function closeWorkflowBoard(): Promise<void> {
  if (!activeRenderer) {
    activeWorkflowState = null;
    activeWorkflowLogs = [];
    return;
  }

  await activeRenderer.stop();
  activeRenderer = null;
  activeWorkflowState = null;
  activeWorkflowLogs = [];
}
