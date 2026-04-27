import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  convertMessagesToDeepSeekCompletionsMessageParams,
  normalizeOpenAICompatibleModelName,
  sanitizeDeepSeekCompletionsParams,
  shouldUseDeepSeekReasoningContentCompat,
} from "../src/lib/deepseek-openai.js";
import { loadProjectEnv, parseDotEnv } from "../src/lib/env.js";
import {
  createTodoBoardRenderer,
  releaseWorkflowInputStream,
  resolveWorkflowStdoutMode,
  setWorkflowStdoutMode,
} from "../src/lib/terminal-ui.js";
import type { TextGeneratorRuntime } from "../src/lib/types.js";
import {
  buildRuntimeStatus,
  buildTodoBoardLines,
  createArtifactItemsForStage,
  createStepItemsForLifecycle,
  estimateRenderedRows,
  extractCompatibleStreamErrorReason,
  extractRuntimeStatusPatch,
  formatDeepAgentsTraceEntry,
  formatTodoHeader,
  formatWorkflowStageLine,
  mergeRuntimeStatus,
  renderArtifactStatus,
  formatElapsedTime,
  resolveDeepagentsStreamModes,
  renderTodoBoardToString,
  renderTodoStatus,
  stripAnsi,
  summarizeDeepAgentsAction,
  toVirtualWorkspacePath,
  withActivityTimeout,
} from "../src/lib/text-generator.js";

const require = createRequire(import.meta.url);

async function loadLangChainCoreMessages() {
  const openAiPackagePath = require.resolve("@langchain/openai/package.json");
  const messagesPath = require.resolve("@langchain/core/messages", {
    paths: [path.dirname(openAiPackagePath)],
  });
  return import(pathToFileURL(messagesPath).href) as Promise<{
    AIMessage: new (fields: unknown) => unknown;
    HumanMessage: new (content: unknown) => unknown;
    ToolMessage: new (fields: unknown) => unknown;
  }>;
}

test("parseDotEnv reads simple key-value pairs", () => {
  const parsed = parseDotEnv(`
# comment
OPENAI_API_KEY=test-key
OPENAI_BASE_URL="https://example.com/v1"
APP_BUILDER_MODEL=openai:gpt-4.1-mini
APP_BUILDER_STREAM_MODES=updates,tools,values
`);

  assert.deepEqual(parsed, {
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://example.com/v1",
    APP_BUILDER_MODEL: "openai:gpt-4.1-mini",
    APP_BUILDER_STREAM_MODES: "updates,tools,values",
  });
});

test("resolveDeepagentsStreamModes returns defaults when env is empty", () => {
  assert.deepEqual(resolveDeepagentsStreamModes(undefined), ["updates", "messages", "tools", "values"]);
  assert.deepEqual(resolveDeepagentsStreamModes(""), ["updates", "messages", "tools", "values"]);
});

test("resolveDeepagentsStreamModes parses comma-separated env values", () => {
  assert.deepEqual(resolveDeepagentsStreamModes("updates, tools, values"), ["updates", "tools", "values"]);
  assert.deepEqual(resolveDeepagentsStreamModes("values,values,tools"), ["values", "tools"]);
});

test("resolveDeepagentsStreamModes rejects invalid modes", () => {
  assert.throws(
    () => resolveDeepagentsStreamModes("updates,unknown"),
    /Invalid APP_BUILDER_STREAM_MODES value: unknown/,
  );
});

test("normalizeOpenAICompatibleModelName strips only the OpenAI provider prefix", () => {
  assert.equal(normalizeOpenAICompatibleModelName("openai:deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(normalizeOpenAICompatibleModelName("deepseek-v4-pro"), "deepseek-v4-pro");
  assert.equal(normalizeOpenAICompatibleModelName("anthropic:claude-sonnet-4-5"), "anthropic:claude-sonnet-4-5");
});

test("shouldUseDeepSeekReasoningContentCompat detects DeepSeek model or endpoint", () => {
  assert.equal(shouldUseDeepSeekReasoningContentCompat("openai:deepseek-v4-pro"), true);
  assert.equal(shouldUseDeepSeekReasoningContentCompat("openai:gpt-4.1-mini", "https://api.deepseek.com"), true);
  assert.equal(shouldUseDeepSeekReasoningContentCompat("openai:gpt-4.1-mini", "https://api.openai.com/v1"), false);
});

test("sanitizeDeepSeekCompletionsParams removes forced tool choice", () => {
  const sanitized = sanitizeDeepSeekCompletionsParams({
    model: "deepseek-v4-pro",
    tool_choice: "required",
    tools: [{ type: "function", function: { name: "extract", parameters: { type: "object" } } }],
  });

  assert.equal("tool_choice" in sanitized, false);
  assert.deepEqual(
    sanitizeDeepSeekCompletionsParams({ model: "deepseek-v4-pro", tool_choice: "auto" }),
    { model: "deepseek-v4-pro", tool_choice: "auto" },
  );
});

test("convertMessagesToDeepSeekCompletionsMessageParams keeps reasoning_content for tool turns", async () => {
  const { AIMessage, HumanMessage, ToolMessage } = await loadLangChainCoreMessages();
  const messages = [
    new HumanMessage("How is the weather tomorrow?"),
    new AIMessage({
      content: "Let me check.",
      additional_kwargs: {
        reasoning_content: "Need to fetch the current date before asking weather.",
      },
      tool_calls: [
        {
          id: "call_1",
          name: "get_date",
          args: {},
          type: "tool_call",
        },
      ],
    }),
    new ToolMessage({
      content: "2026-04-27",
      tool_call_id: "call_1",
    }),
    new AIMessage({
      content: "Tomorrow is 2026-04-28.",
      additional_kwargs: {
        reasoning_content: "The tool returned today's date, so tomorrow is one day later.",
      },
    }),
    new HumanMessage("What about Guangzhou?"),
  ];

  const converted = convertMessagesToDeepSeekCompletionsMessageParams({
    messages: messages as any,
    model: "deepseek-v4-pro",
  });
  const resolved = await converted;
  const assistantMessages = resolved.filter((message) => message.role === "assistant") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(assistantMessages[0]?.reasoning_content, "Need to fetch the current date before asking weather.");
  assert.equal(assistantMessages[1]?.reasoning_content, "The tool returned today's date, so tomorrow is one day later.");
});

test("convertMessagesToDeepSeekCompletionsMessageParams drops reasoning_content for non-tool turns", async () => {
  const { AIMessage, HumanMessage } = await loadLangChainCoreMessages();
  const converted = await convertMessagesToDeepSeekCompletionsMessageParams({
    messages: [
      new HumanMessage("Which is bigger, 9.11 or 9.8?"),
      new AIMessage({
        content: "9.8 is bigger.",
        additional_kwargs: {
          reasoning_content: "Compare decimals by writing 9.80 and 9.11.",
        },
      }),
      new HumanMessage("How many Rs are in strawberry?"),
    ] as any,
    model: "deepseek-v4-pro",
  });
  const assistantMessage = converted.find((message) => message.role === "assistant") as {
    reasoning_content?: string;
  } | undefined;

  assert.equal(assistantMessage?.reasoning_content, undefined);
});

test("resolveWorkflowStdoutMode returns dashboard by default", () => {
  assert.equal(resolveWorkflowStdoutMode(undefined), "dashboard");
  assert.equal(resolveWorkflowStdoutMode(""), "dashboard");
});

test("resolveWorkflowStdoutMode parses explicit values", () => {
  assert.equal(resolveWorkflowStdoutMode("dashboard"), "dashboard");
  assert.equal(resolveWorkflowStdoutMode("log"), "log");
});

test("resolveWorkflowStdoutMode rejects invalid values", () => {
  assert.throws(
    () => resolveWorkflowStdoutMode("verbose"),
    /Invalid APP_BUILDER_STDOUT value: verbose/,
  );
});

test("releaseWorkflowInputStream restores and detaches tty stdin", () => {
  const calls: string[] = [];
  const stdin = {
    isTTY: true,
    pause() {
      calls.push("pause");
    },
    setRawMode(mode: boolean) {
      calls.push(`raw:${String(mode)}`);
    },
    unref() {
      calls.push("unref");
    },
  } as unknown as NodeJS.ReadStream;

  releaseWorkflowInputStream(stdin);

  assert.deepEqual(calls, ["raw:false", "pause", "unref"]);
});

test("releaseWorkflowInputStream tolerates plain streams", () => {
  assert.doesNotThrow(() => releaseWorkflowInputStream({} as NodeJS.ReadStream));
});

test("extractCompatibleStreamErrorReason finds nested compatible stream errors", () => {
  const error = new Error("middleware failed") as Error & { cause?: unknown };
  error.cause = {
    message: "output new_sensitive (1027)",
  };

  assert.equal(extractCompatibleStreamErrorReason(error), "output new_sensitive (1027)");
});

test("createTodoBoardRenderer can stream incremental logs in tty log mode", async () => {
  const writes: string[] = [];
  const stdout = {
    isTTY: true,
    write(chunk: string) {
      writes.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WriteStream;

  setWorkflowStdoutMode("log");
  try {
    const renderer = createTodoBoardRenderer(
      stdout,
      {} as NodeJS.ReadStream,
      {} as NodeJS.WriteStream,
    );
    const baseState = {
      stage: "计划阶段" as const,
      todos: createStepItemsForLifecycle("计划阶段", "validating"),
      artifacts: createArtifactItemsForStage("计划阶段", "validating"),
      narrative: "正在验证计划阶段产出物。",
      logs: ["[12:00:00] [FLOW] 进入计划阶段，开始流式生成。"],
    };

    await renderer.update(baseState);
    await renderer.update({
      ...baseState,
      logs: [
        ...baseState.logs,
        "[12:00:01] [READ] 读取文件：.deepagents/source-prd.md（1-1000行）",
      ],
    });
    await renderer.update({
      ...baseState,
      logs: [
        ...baseState.logs,
        "[12:00:01] [READ] 读取文件：.deepagents/source-prd.md（1-1000行）",
      ],
    });
    await renderer.stop();
  } finally {
    setWorkflowStdoutMode(undefined);
  }

  assert.deepEqual(writes, [
    "[12:00:00] [FLOW] 进入计划阶段，开始流式生成。\n",
    "[12:00:01] [READ] 读取文件：.deepagents/source-prd.md（1-1000行）\n",
  ]);
});

test("toVirtualWorkspacePath anchors files at the virtual workspace root", () => {
  const outputDirectory = path.resolve("tmp", "app-builder-output");

  assert.equal(
    toVirtualWorkspacePath(outputDirectory, path.join(outputDirectory, ".deepagents", "plan-spec.json")),
    "/.deepagents/plan-spec.json",
  );
  assert.equal(
    toVirtualWorkspacePath(outputDirectory, path.join(outputDirectory, "app-builder-report.md")),
    "/app-builder-report.md",
  );
  assert.equal(
    toVirtualWorkspacePath(outputDirectory, path.join(outputDirectory, "app", "api", "work-orders", "route.ts")),
    "/app/api/work-orders/route.ts",
  );
});

test("estimateRenderedRows accounts for wrapped ascii lines", () => {
  assert.equal(estimateRenderedRows(["12345", "123456"], 5), 3);
});

test("estimateRenderedRows accounts for wrapped wide characters", () => {
  assert.equal(estimateRenderedRows(["当前计划：", "  [~] 生成详细 spec"], 8), 5);
});

test("renderTodoStatus uses static todo markers", () => {
  assert.equal(renderTodoStatus("pending"), "✴️");
  assert.equal(renderTodoStatus("completed"), "✅");
  assert.equal(renderTodoStatus("in_progress"), "✳️");
});

test("formatTodoHeader uses completed and total counts", () => {
  assert.equal(formatTodoHeader(1, 3), "执行步骤（1/3）：");
});

test("formatWorkflowStageLine highlights the active stage in the pipeline", () => {
  assert.equal(
    formatWorkflowStageLine("生成阶段"),
    "计划阶段 -> [生成阶段] -> 完成阶段",
  );
  assert.equal(
    formatWorkflowStageLine("完成阶段"),
    "计划阶段 -> 生成阶段 -> [完成阶段]",
  );
});

test("formatElapsedTime renders hh:mm:ss", () => {
  assert.equal(formatElapsedTime(0), "00:00:00");
  assert.equal(formatElapsedTime(65_000), "00:01:05");
  assert.equal(formatElapsedTime(3_726_000), "01:02:06");
});

test("renderArtifactStatus shows workflow output states", () => {
  assert.equal(renderArtifactStatus("pending"), "[待生成]");
  assert.equal(renderArtifactStatus("generating"), "[生成中]");
  assert.equal(renderArtifactStatus("generated"), "[已生成]");
  assert.equal(renderArtifactStatus("validating"), "[验证中]");
  assert.equal(renderArtifactStatus("verified"), "[已验证]");
});

test("createArtifactItemsForStage returns key artifacts for each workflow stage", () => {
  assert.deepEqual(
    createArtifactItemsForStage("计划阶段", "generating").map((item) => ({
      label: item.label,
      status: item.status,
    })),
    [
      { label: ".deepagents/prd-analysis.md", status: "generating" },
      { label: ".deepagents/generated-spec.md", status: "generating" },
      { label: ".deepagents/plan-spec.json", status: "generating" },
      { label: ".deepagents/plan-validation.json", status: "generating" },
      { label: "app/api/**", status: "pending" },
      { label: "app/** 页面与布局", status: "pending" },
      { label: "app-builder-report.md", status: "pending" },
      { label: ".deepagents/generation-validation.json", status: "pending" },
    ],
  );

  assert.deepEqual(
    createArtifactItemsForStage("生成阶段", "verified").map((item) => ({
      label: item.label,
      status: item.status,
    })),
    [
      { label: ".deepagents/prd-analysis.md", status: "verified" },
      { label: ".deepagents/generated-spec.md", status: "verified" },
      { label: ".deepagents/plan-spec.json", status: "verified" },
      { label: ".deepagents/plan-validation.json", status: "verified" },
      { label: "app/api/**", status: "verified" },
      { label: "app/** 页面与布局", status: "verified" },
      { label: "app-builder-report.md", status: "verified" },
      { label: ".deepagents/generation-validation.json", status: "verified" },
    ],
  );

  assert.deepEqual(
    createArtifactItemsForStage("完成阶段", "verified").map((item) => ({
      label: item.label,
      status: item.status,
    })),
    [
      { label: ".deepagents/prd-analysis.md", status: "verified" },
      { label: ".deepagents/generated-spec.md", status: "verified" },
      { label: ".deepagents/plan-spec.json", status: "verified" },
      { label: ".deepagents/plan-validation.json", status: "verified" },
      { label: "app/api/**", status: "verified" },
      { label: "app/** 页面与布局", status: "verified" },
      { label: "app-builder-report.md", status: "verified" },
      { label: ".deepagents/generation-validation.json", status: "verified" },
    ],
  );
});

test("createStepItemsForLifecycle returns a verified completion checklist for the complete stage", () => {
  assert.deepEqual(
    createStepItemsForLifecycle("完成阶段", "verified"),
    [
      { content: "计划阶段产物已通过宿主校验", status: "completed" },
      { content: "生成阶段产物已通过宿主校验", status: "completed" },
      { content: "验证记录与交付报告已确认落盘", status: "completed" },
      { content: "工作流状态已切换为 complete", status: "completed" },
    ],
  );
});

test("renderTodoBoardToString preserves todo progress and current action in Ink mode", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "计划阶段",
    sessionId: "12345678-90ab-cdef-1234-567890abcdef",
    todos: [
      { content: "读取 PRD 与模板上下文", status: "completed" },
      { content: "整理分析稿与详细 spec", status: "in_progress" },
      { content: "写入结构化 plan-spec.json", status: "pending" },
    ],
    artifacts: createArtifactItemsForStage("计划阶段", "validating"),
    narrative: "正在整理分析稿。",
    elapsedMs: 65_000,
    logs: [
      "[12:34:56] [FLOW] 进入计划阶段，开始流式生成。",
      "[12:34:57] [READ] 读取文件：.deepagents/source-prd.md（1-1000行）",
      "[12:34:58] [CHECK] 正在校验计划阶段产出物。",
    ],
    runtimeStatus: {
      modelName: "gpt-5.4",
      effort: "high",
      usage: {
        inputTokens: 900,
        outputTokens: 334,
        totalTokens: 1_234,
        reasoningTokens: 120,
        cachedInputTokens: 256,
      },
      contextWindowUsedTokens: 900,
      sessionId: "12345678-90ab-cdef-1234-567890abcdef",
      phase: "plan",
    },
  }, 220));

  assert.match(output, /计划阶段/);
  assert.match(output, /计划阶段 -> 生成阶段 -> 完成阶段/);
  assert.match(output, /会话：12345678/);
  assert.match(output, /总耗时：00:01:05/);
  assert.match(output, /执行步骤（1\/3）：/);
  assert.match(output, /读取 PRD 与模板上下文/);
  assert.match(output, /整理分析稿与详细 spec/);
  assert.match(output, /关键产出物：/);
  assert.match(output, /prd-analysis\.md/);
  assert.match(output, /\[验证中\]/);
  assert.match(output, /app-builder-report\.md/);
  assert.match(output, /\[待生成\]/);
  assert.match(output, /当前动作：正在整理分析稿。/);
  assert.match(output, /执行日志/);
  assert.match(output, /修复进展/);
  assert.match(output, /暂无修复进展/);
  assert.match(output, /\[12:34:56\] \[FLOW\] 进入计划阶段/);
  assert.match(output, /\[12:34:57\] \[READ\]/);
  assert.match(output, /读取文件：\.deepagents\/source-prd\.md（1-1000行）/);
  assert.match(output, /\[12:34:58\] \[CHECK\] 正在校验计划阶段产出物/);
  assert.match(output, /model: gpt-5\.4 \| effort: high \| token used: 978 total \(.+\) \| context used: 900/);
  assert.match(output, /reasoning 120/);
  assert.match(output, /cache 256/);
  assert.match(output, /context used: 900 \| phase: plan/);
});

test("renderTodoBoardToString preserves animated thinking action text", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "计划阶段",
    todos: [
      { content: "读取 PRD 与模板上下文", status: "in_progress" },
    ],
    artifacts: createArtifactItemsForStage("计划阶段", "generating"),
    narrative: "模型正在工作中",
    elapsedMs: 154_000,
    runtimeStatus: {
      usage: {
        inputTokens: 12_500,
      },
    },
    streamProgress: {
      outputTokens: 1_536,
      outputTokensEstimated: true,
    },
  }, 120));

  assert.match(output, /当前动作：模型正在工作中（2m 34s, in: 12.5 k，out：1.5 k）/);
});

test("renderTodoBoardToString splits execution logs and repair progress into two sections", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "生成阶段",
    sessionId: "12345678-90ab-cdef-1234-567890abcdef",
    todos: [
      { content: "读取已验证的 planSpec 与 starter", status: "completed" },
      { content: "实现资源模型与 REST API", status: "completed" },
      { content: "补齐页面接线与交付文件", status: "in_progress" },
      { content: "等待宿主校验生成阶段产物", status: "pending" },
    ],
    artifacts: createArtifactItemsForStage("生成阶段", "validating"),
    narrative: "正在复核修复后的生成交付物。",
    elapsedMs: 80_000,
    logs: [
      "[12:35:01] [FLOW] 生成阶段流式输出完成，开始宿主校验。",
      "[12:35:02] [FIX] 生成阶段校验失败，待修复问题 2 条。",
      "[12:35:02] [FIX] 待修复错误 1/2: app/api/orders/route.ts 缺少 POST handler",
      "[12:35:02] [FIX] 待修复错误 2/2: 生成阶段未完成：app/orders/page.tsx 未接入 create action",
      "[12:35:02] [FIX] 待修复验证步骤 1/1: pnpm db:init 未通过。",
      "[12:35:02] [FIX] 待修复验证内容 pnpm db:init 1/2: Prisma schema 校验失败。",
      "[12:35:02] [FIX] 待修复验证内容 pnpm db:init 2/2: Unknown field `status` for model `WorkOrder`.",
      "[12:35:03] [FIX] 启动生成修复轮次 1。",
      "[12:35:04] [READ] 读取文件：app/api/orders/route.ts（1-200行）",
      "[12:35:05] [FIX] 生成修复输出完成，开始复核。",
    ],
  }, 140));

  assert.match(output, /执行日志/);
  assert.match(output, /修复进展/);
  assert.match(output, /\[12:35:01\] \[FLOW\] 生成阶段流式输出完成/);
  assert.match(output, /\[12:35:04\] \[READ\]/);
  assert.match(output, /读取文件：app\/api\/orders\/route\.ts/);
  assert.match(output, /待修复错误 2\/2: 生成阶段未完成：app\/orders\/page\.tsx 未接入/);
  assert.match(output, /create action/);
  assert.match(output, /待修复验证步骤 1\/1: pnpm db:init 未通过/);
  assert.match(output, /待修复验证内容 pnpm db:init 1\/2: Prisma schema 校验失败/);
  assert.match(output, /待修复验证内容 pnpm db:init 2\/2: Unknown field `status` for/);
  assert.match(output, /model `WorkOrder`\./);
  assert.match(output, /\[12:35:03\] \[FIX\] 启动生成修复轮次 1/);
  assert.match(output, /\[12:35:05\] \[FIX\] 生成修复输出完成，开始复核/);
  assert.doesNotMatch(output, /暂无修复进展/);
});

test("renderTodoBoardToString can render the completion stage", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "完成阶段",
    sessionId: "12345678-90ab-cdef-1234-567890abcdef",
    todos: [
      { content: "计划阶段产物已通过宿主校验", status: "completed" },
      { content: "生成阶段产物已通过宿主校验", status: "completed" },
      { content: "验证记录与交付报告已确认落盘", status: "completed" },
      { content: "工作流状态已切换为 complete", status: "completed" },
    ],
    artifacts: createArtifactItemsForStage("完成阶段", "verified"),
    narrative: "全部阶段已完成。",
    elapsedMs: 65_000,
  }, 120));

  assert.match(output, /计划阶段 -> 生成阶段 -> 完成阶段/);
  assert.match(output, /当前动作：全部阶段已完成。/);
  assert.match(output, /计划阶段产物已通过宿主校验/);
  assert.match(output, /生成阶段产物已通过宿主校验/);
  assert.match(output, /工作流状态已切换为 complete/);
  assert.doesNotMatch(output, /\[待生成\]/);
});

test("buildTodoBoardLines appends a horizontal runtime bar for plain-text rendering", () => {
  const lines = buildTodoBoardLines({
    stage: "生成阶段",
    sessionId: "plain-session-123",
    todos: [
      { content: "读取已验证的 planSpec 与 starter", status: "completed" },
    ],
    artifacts: createArtifactItemsForStage("生成阶段", "validating"),
    narrative: "正在验证生成阶段交付物。",
    runtimeStatus: {
      modelName: "gpt-5.4-mini",
      effort: "medium",
      usage: {
        inputTokens: 2_048,
        outputTokens: 512,
        totalTokens: 2_560,
      },
      contextWindowUsedTokens: 2_048,
      sessionId: "plain-session-123",
      phase: "generate",
    },
  });

  assert.deepEqual(lines.slice(-2), [
    "",
    "model: gpt-5.4-mini | effort: medium | token used: 2.5K total (in 2K, out 512) | context used: 2K | phase: generate",
  ]);
});

test("renderTodoBoardToString falls back to n/a for missing runtime status values", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "计划阶段",
    todos: [
      { content: "读取 PRD 与模板上下文", status: "in_progress" },
    ],
    artifacts: [],
    narrative: "等待模型开始处理。",
    runtimeStatus: {},
  }, 120));

  assert.match(output, /model: n\/a \| effort: n\/a \| token used: n\/a \| context used: n\/a \| phase: n\/a/);
});

test("formatDeepAgentsTraceEntry renders readable tool call details without console board text", () => {
  const entry = formatDeepAgentsTraceEntry(
    "tools",
    {
      tool_calls: [
        {
          id: "call_123",
          name: "write_file",
          args: {
            path: "app/page.tsx",
            content: "hello",
          },
          status: "completed",
          result: {
            ok: true,
          },
        },
      ],
    },
    "正在调用工具：write_file。",
  );

  assert.match(entry, /\| TOOLS ===/);
  assert.match(entry, /Summary/);
  assert.match(entry, /正在调用工具：write_file。/);
  assert.match(entry, /Tool Calls/);
  assert.match(entry, /1\. write_file/);
  assert.match(entry, /id: call_123/);
  assert.match(entry, /status: completed/);
  assert.match(entry, /path: 'app\/page\.tsx'/);
  assert.match(entry, /content: 'hello'/);
  assert.match(entry, /ok: true/);
  assert.match(entry, /Payload/);
  assert.doesNotMatch(entry, /当前计划（/);
  assert.doesNotMatch(entry, /当前动作：/);
});

test("summarizeDeepAgentsAction exposes concrete tool events", () => {
  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_start",
      name: "read_file",
      input: "{\"file_path\":\".deepagents/source-prd.md\",\"offset\":0,\"limit\":1000}",
    }),
    "读取文件：.deepagents/source-prd.md（1-1000行）",
  );

  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_end",
      name: "write_todos",
      input: JSON.stringify({
        todos: [
          { content: "读取原始 PRD", status: "in_progress" },
          { content: "编写分析稿", status: "pending" },
        ],
      }),
    }),
    "读取原始 PRD工作开始。",
  );

  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_end",
      name: "write_todos",
      input: JSON.stringify({
        todos: [
          { content: "读取原始 PRD", status: "completed" },
          { content: "编写分析稿", status: "in_progress" },
        ],
      }),
    }),
    "读取原始 PRD工作完成。",
  );
});

test("summarizeDeepAgentsAction marks whole-file reads explicitly", () => {
  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_start",
      name: "read_file",
      input: "{\"file_path\":\".deepagents/plan-system-prompt.md\"}",
    }),
    "读取文件：.deepagents/plan-system-prompt.md（全量）",
  );
});

test("summarizeDeepAgentsAction exposes message tool-call intent", () => {
  assert.equal(
    summarizeDeepAgentsAction("messages", [
      {
        tool_calls: [
          {
            name: "write_file",
            args: {
              path: "app/page.tsx",
            },
          },
        ],
      },
    ]),
    "准备写入文件：app/page.tsx",
  );
});

test("summarizeDeepAgentsAction shows received token progress while thinking", () => {
  assert.equal(
    summarizeDeepAgentsAction("messages", { content: "" }, { receivedOutputTokens: 1_536 }),
    "模型正在工作中",
  );

  assert.equal(
    summarizeDeepAgentsAction("messages", { content: [] }, {
      receivedOutputTokens: 42,
      receivedOutputTokensEstimated: true,
    }),
    "模型正在工作中",
  );

  assert.equal(
    summarizeDeepAgentsAction("messages", [
      { role: "user", content: "{\"stage\":\"plan\",\"sourcePrdMarkdown\":\"do not print input payload\"}" },
      { content: [{ text: "partial output" }] },
      { response_metadata: { model_name: "gpt-5.4" } },
    ]),
    "partial output",
  );

  assert.equal(
    summarizeDeepAgentsAction("messages", [
      { id: ["langchain_core", "messages", "HumanMessage"], content: "{\"stage\":\"plan\"}" },
    ]),
    "模型正在工作中",
  );
});

test("extractRuntimeStatusPatch reads model and usage metadata from stream payload", () => {
  const patch = extractRuntimeStatusPatch({
    message: {
      response_metadata: {
        model_name: "gpt-5.4-actual",
      },
      usage_metadata: {
        input_tokens: 120,
        output_tokens: 30,
        total_tokens: 150,
        output_token_details: {
          reasoning: 12,
        },
        input_token_details: {
          cache_read: 40,
        },
      },
    },
  });

  assert.equal(patch.modelName, "gpt-5.4-actual");
  assert.equal(patch.contextWindowUsedTokens, 120);
  assert.deepEqual(patch.usage, {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
    reasoningTokens: 12,
    cachedInputTokens: 40,
  });
});

test("mergeRuntimeStatus accumulates usage across multiple chunks", () => {
  const runtime: Pick<TextGeneratorRuntime, "sessionId" | "templatePhases"> = {
    sessionId: "runtime-session-1",
    templatePhases: {
      plan: { effort: "high" },
      planRepair: { effort: "high" },
      generate: { effort: "medium" },
      generateRepair: { effort: "low" },
    },
  };

  const merged = mergeRuntimeStatus(
    mergeRuntimeStatus(
      buildRuntimeStatus({
        runtime,
        phase: "plan",
        fallbackModelName: "openai:gpt-4.1-mini",
      }),
      extractRuntimeStatusPatch({
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        },
      }),
    ),
    extractRuntimeStatusPatch({
      response_metadata: {
        model_name: "gpt-5.4-stream",
      },
      usage_metadata: {
        input_tokens: 50,
        output_tokens: 10,
        total_tokens: 60,
        output_token_details: {
          reasoning: 8,
        },
        input_token_details: {
          cache_read: 12,
        },
      },
    }),
  );

  assert.equal(merged.modelName, "gpt-5.4-stream");
  assert.equal(merged.contextWindowUsedTokens, 50);
  assert.deepEqual(merged.usage, {
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 180,
    reasoningTokens: 8,
    cachedInputTokens: 12,
  });
});

test("buildRuntimeStatus maps effort to the active phase", () => {
  const runtime: Pick<TextGeneratorRuntime, "sessionId" | "templatePhases"> = {
    sessionId: "runtime-session-2",
    templatePhases: {
      plan: { effort: "high" },
      planRepair: { effort: "low" },
      generate: { effort: "medium" },
      generateRepair: { effort: "high" },
    },
  };

  assert.equal(buildRuntimeStatus({ runtime, phase: "planRepair" }).effort, "low");
  assert.equal(buildRuntimeStatus({ runtime, phase: "generate" }).effort, "medium");
  assert.equal(buildRuntimeStatus({ runtime, phase: "complete" }).effort, undefined);
});

test("withActivityTimeout keeps extending while activity continues", async () => {
  const result = await withActivityTimeout(
    async (signalActivity) => {
      for (let index = 0; index < 3; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        signalActivity();
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      return "ok";
    },
    30,
    "stream",
  );

  assert.equal(result, "ok");
});

test("withActivityTimeout rejects after prolonged inactivity", async () => {
  await assert.rejects(
    () =>
      withActivityTimeout(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return "late";
        },
        20,
        "stream",
      ),
    /stream timed out after 20ms without activity\./,
  );
});

test("loadProjectEnv populates missing process env values from .env", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-env-"));
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;

  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;

  try {
    await writeFile(
      path.join(tempRoot, ".env"),
      "OPENAI_API_KEY=from-file\nOPENAI_BASE_URL=https://proxy.example/v1\n",
      "utf8",
    );

    await loadProjectEnv(tempRoot);

    assert.equal(process.env.OPENAI_API_KEY, "from-file");
    assert.equal(process.env.OPENAI_BASE_URL, "https://proxy.example/v1");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("loadProjectEnv does not override existing process env values", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-env-"));
  const originalApiKey = process.env.OPENAI_API_KEY;

  process.env.OPENAI_API_KEY = "already-set";

  try {
    await writeFile(path.join(tempRoot, ".env"), "OPENAI_API_KEY=from-file\n", "utf8");
    await loadProjectEnv(tempRoot);
    assert.equal(process.env.OPENAI_API_KEY, "already-set");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});
