import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadProjectEnv, parseDotEnv } from "../src/lib/env.js";
import {
  estimateRenderedRows,
  formatTodoHeader,
  resolveDeepagentsStreamModes,
  renderTodoStatus,
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
  assert.equal(formatTodoHeader(1, 3), "当前计划（1/3）：");
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
