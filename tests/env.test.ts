import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadProjectEnv, parseDotEnv } from "../src/lib/env.js";
import {
  createArtifactItemsForStage,
  estimateRenderedRows,
  formatDeepAgentsTraceEntry,
  formatTodoHeader,
  formatWorkflowStageLine,
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
  }, 120));

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
  assert.match(output, /详细日志：/);
  assert.match(output, /\[12:34:56\] \[FLOW\] 进入计划阶段/);
  assert.match(output, /\[12:34:57\] \[READ\]/);
  assert.match(output, /读取文件：\.deepagents\/source-prd\.md（1-1000行）/);
  assert.match(output, /\[12:34:58\] \[CHECK\] 正在校验计划阶段产出物/);
});

test("renderTodoBoardToString can render the completion stage", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "完成阶段",
    sessionId: "12345678-90ab-cdef-1234-567890abcdef",
    todos: [
      { content: "读取已验证的 planSpec 与 starter", status: "completed" },
      { content: "实现资源模型与 REST API", status: "completed" },
      { content: "补齐页面接线与交付文件", status: "completed" },
      { content: "等待宿主校验生成阶段产物", status: "completed" },
    ],
    artifacts: createArtifactItemsForStage("完成阶段", "verified"),
    narrative: "全部阶段已完成。",
    elapsedMs: 65_000,
  }, 120));

  assert.match(output, /计划阶段 -> 生成阶段 -> 完成阶段/);
  assert.match(output, /当前动作：全部阶段已完成。/);
  assert.doesNotMatch(output, /\[待生成\]/);
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
