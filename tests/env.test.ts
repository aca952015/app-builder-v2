import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type ChatGenerationChunkLike,
  StableAnthropicToolCallChatModel,
  createAnthropicToolCallStreamState,
  flushAnthropicToolCallStreamState,
  stabilizeAnthropicToolCallGenerationChunk,
} from "../src/lib/anthropic-tool-stream.js";
import {
  createOpenAICompatibleModel,
  convertMessagesToOpenAICompatibleCompletionsMessageParams,
  normalizeOpenAICompatibleModelName,
  resolveModelReasoningEffort,
  sanitizeOpenAICompatibleCompletionsParams,
} from "../src/lib/openai-compatible.js";
import {
  createGoogleModel,
  normalizeGoogleModelName,
  resolveGoogleReasoningEffort,
  rewriteGoogleApiRequestUrl,
} from "../src/lib/google-model.js";
import { loadProjectEnv, parseDotEnv } from "../src/lib/env.js";
import {
  DEFAULT_MODEL_MAX_TOKENS,
  DEFAULT_MODEL_NAME,
  PI_MODELS_JSON_ENV,
  resolveModelRoleConfigs,
  sanitizeModelRoleConfigs,
} from "../src/lib/model-config.js";
import {
  closeWorkflowBoard,
  createTodoBoardRenderer,
  mergeWorkflowAgentStatuses,
  mergeWorkflowRuntimeStatus,
  parseTodoMarkdown,
  releaseWorkflowInputStream,
  resolveWorkflowStdoutMode,
  setWorkflowStdoutMode,
  updateWorkflowBoard,
} from "../src/lib/terminal-ui.js";
import type { RuntimeUsageSummary, TextGeneratorRuntime } from "../src/lib/types.js";
import {
  buildRuntimeStatus,
  buildGenerationSubagents,
  buildTodoBoardLines,
  createPiModelRegistry,
  createArtifactItemsForStage,
  createStepItemsForLifecycle,
  estimateRenderedRows,
  extractCompatibleStreamErrorReason,
  extractRuntimeStatusPatch,
  formatDeepAgentsTraceEntry,
  formatTodoHeader,
  formatWorkflowStageLine,
  mergeRuntimeStatus,
  modelRoleForRuntimePhase,
  normalizeWriteTodosToolCallArgs,
  resolvePiModelsJsonPath,
  renderArtifactStatus,
  formatElapsedTime,
  resolveDeepagentsStreamModes,
  renderTodoBoardToString,
  renderTodoStatus,
  stripAnsi,
  shouldAppendDeepAgentsWorkflowLog,
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
    AIMessageChunk: new (fields: unknown) => unknown;
    HumanMessage: new (content: unknown) => unknown;
    ToolMessage: new (fields: unknown) => unknown;
  }>;
}

async function loadLangChainCoreOutputs() {
  const openAiPackagePath = require.resolve("@langchain/openai/package.json");
  const outputsPath = require.resolve("@langchain/core/outputs", {
    paths: [path.dirname(openAiPackagePath)],
  });
  return import(pathToFileURL(outputsPath).href) as Promise<{
    ChatGenerationChunk: new (fields: { text: string; message: unknown }) => unknown;
  }>;
}

test("parseDotEnv reads simple key-value pairs", () => {
  const parsed = parseDotEnv(`
# comment
APP_BUILDER_API_KEY=test-key
APP_BUILDER_BASE_URL="https://example.com/v1"
APP_BUILDER_MODEL=openai:gpt-4.1-mini
APP_BUILDER_STREAM_MODES=updates,tools,values
`);

  assert.deepEqual(parsed, {
    APP_BUILDER_API_KEY: "test-key",
    APP_BUILDER_BASE_URL: "https://example.com/v1",
    APP_BUILDER_MODEL: "openai:gpt-4.1-mini",
    APP_BUILDER_STREAM_MODES: "updates,tools,values",
  });
});

test("resolveModelRoleConfigs falls back to global model, base URL, and API key", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_BASE_URL: "https://proxy.example/v1",
    APP_BUILDER_MODEL: "openai:gpt-5.4-mini",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].modelName, "openai:gpt-5.4-mini");
    assert.equal(configs[role].protocol, "openai-responses");
    assert.equal(configs[role].baseURL, "https://proxy.example/v1");
    assert.equal(configs[role].userAgent, undefined);
    assert.equal(configs[role].maxInputTokens, undefined);
    assert.equal(configs[role].maxTokens, DEFAULT_MODEL_MAX_TOKENS);
    assert.equal(configs[role].apiKey, "global-key");
  }
});

test("resolveModelRoleConfigs applies global protocol to every role", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_PROTOCOL: "anthropic",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].protocol, "anthropic");
  }
});

test("resolveModelRoleConfigs applies role-specific protocol overrides with global fallback", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_PROTOCOL: "openai",
    APP_BUILDER_PLAN_PROTOCOL: "anthropic",
    APP_BUILDER_GENERATE_PROTOCOL: "openai",
    APP_BUILDER_REPAIR_PROTOCOL: "anthropic",
  });

  assert.equal(configs.plan.protocol, "anthropic");
  assert.equal(configs.generate.protocol, "openai-responses");
  assert.equal(configs.repair.protocol, "anthropic");
});

test("resolveModelRoleConfigs accepts explicit OpenAI chat and responses protocols", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_PROTOCOL: "openai-responses",
    APP_BUILDER_GENERATE_PROTOCOL: "openai-chat",
  });

  assert.equal(configs.plan.protocol, "openai-responses");
  assert.equal(configs.generate.protocol, "openai-chat");
  assert.equal(configs.repair.protocol, "openai-responses");
});

test("resolveModelRoleConfigs supports google protocol with GOOGLE_API_KEY precedence", () => {
  const configs = resolveModelRoleConfigs({
    GOOGLE_API_KEY: "google-key",
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_PROTOCOL: "google",
    APP_BUILDER_MODEL: "google:gemini-2.5-flash",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].protocol, "google");
    assert.equal(configs[role].modelName, "google:gemini-2.5-flash");
    assert.equal(configs[role].apiKey, "google-key");
  }
});

test("resolveModelRoleConfigs accepts gemini as a google protocol alias", () => {
  const configs = resolveModelRoleConfigs({
    GOOGLE_API_KEY: "google-key",
    APP_BUILDER_PROTOCOL: "gemini",
  });

  assert.equal(configs.plan.protocol, "google");
  assert.equal(configs.generate.protocol, "google");
  assert.equal(configs.repair.protocol, "google");
});

test("resolveModelRoleConfigs accepts Google provider credentials without app-builder keys", () => {
  const configs = resolveModelRoleConfigs({
    GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google-service-account.json",
    APP_BUILDER_PROTOCOL: "google",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].apiKey, undefined);
    assert.equal(configs[role].usesProviderAuth, true);
  }
});

test("resolvePiModelsJsonPath trims optional custom Pi models path", () => {
  assert.equal(resolvePiModelsJsonPath({}), undefined);
  assert.equal(resolvePiModelsJsonPath({ APP_BUILDER_PI_MODELS_JSON: "  /tmp/models.json  " }), "/tmp/models.json");
});

test("createPiModelRegistry loads custom Pi models from APP_BUILDER_PI_MODELS_JSON", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-pi-models-"));
  const modelsJsonPath = path.join(tempRoot, "models.json");
  const previousModelsJsonPath = process.env[PI_MODELS_JSON_ENV];

  await writeFile(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        google: {
          models: [
            {
              id: "gemini-3-flash-agent",
              name: "Gemini 3 Flash Agent",
              api: "google-generative-ai",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 1048576,
              maxTokens: 65536,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          ],
        },
      },
    }),
  );

  try {
    process.env[PI_MODELS_JSON_ENV] = modelsJsonPath;

    const { modelRegistry } = createPiModelRegistry({
      role: "generate",
      protocol: "google",
      modelName: "google:gemini-3-flash-agent",
      baseURL: "https://proxy.example/google/v1beta",
      apiKey: "google-proxy-key",
    });
    const model = modelRegistry.find("google", "gemini-3-flash-agent");

    assert.ok(model);
    assert.equal(model.name, "Gemini 3 Flash Agent");
    assert.equal(model.api, "google-generative-ai");
    assert.equal(model.baseUrl, "https://proxy.example/google/v1beta");
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 65536);
    assert.equal(modelRegistry.hasConfiguredAuth(model), true);
  } finally {
    if (previousModelsJsonPath === undefined) {
      delete process.env[PI_MODELS_JSON_ENV];
    } else {
      process.env[PI_MODELS_JSON_ENV] = previousModelsJsonPath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("createPiModelRegistry auto-registers missing Google models when no Pi models file is configured", () => {
  const previousModelsJsonPath = process.env[PI_MODELS_JSON_ENV];

  try {
    delete process.env[PI_MODELS_JSON_ENV];

    const { modelRegistry } = createPiModelRegistry({
      role: "generate",
      protocol: "google",
      modelName: "google:gemini-3-flash-agent",
      baseURL: "https://proxy.example/google/v1beta",
      apiKey: "google-proxy-key",
      maxInputTokens: 1048576,
      maxTokens: 65536,
    });
    const model = modelRegistry.find("google", "gemini-3-flash-agent");

    assert.ok(model);
    assert.equal(model.name, "gemini-3-flash-agent");
    assert.equal(model.api, "google-generative-ai");
    assert.equal(model.baseUrl, "https://proxy.example/google/v1beta");
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxTokens, 65536);
    assert.equal(modelRegistry.hasConfiguredAuth(model), true);
  } finally {
    if (previousModelsJsonPath === undefined) {
      delete process.env[PI_MODELS_JSON_ENV];
    } else {
      process.env[PI_MODELS_JSON_ENV] = previousModelsJsonPath;
    }
  }
});

test("createPiModelRegistry auto-registers missing OpenAI protocol models", () => {
  const previousModelsJsonPath = process.env[PI_MODELS_JSON_ENV];

  try {
    delete process.env[PI_MODELS_JSON_ENV];

    const { modelRegistry } = createPiModelRegistry({
      role: "generate",
      protocol: "openai-responses",
      modelName: "openai:gateway-coder",
      baseURL: "https://proxy.example/v1",
      apiKey: "openai-proxy-key",
      maxInputTokens: 262144,
      maxTokens: 32768,
    });
    const model = modelRegistry.find("openai", "gateway-coder");

    assert.ok(model);
    assert.equal(model.api, "openai-responses");
    assert.equal(model.baseUrl, "https://proxy.example/v1");
    assert.equal(model.contextWindow, 262144);
    assert.equal(model.maxTokens, 32768);
  } finally {
    if (previousModelsJsonPath === undefined) {
      delete process.env[PI_MODELS_JSON_ENV];
    } else {
      process.env[PI_MODELS_JSON_ENV] = previousModelsJsonPath;
    }
  }
});

test("createPiModelRegistry auto-registers missing OpenAI chat protocol models", () => {
  const previousModelsJsonPath = process.env[PI_MODELS_JSON_ENV];

  try {
    delete process.env[PI_MODELS_JSON_ENV];

    const { modelRegistry } = createPiModelRegistry({
      role: "generate",
      protocol: "openai-chat",
      modelName: "openai:gateway-chat-coder",
      baseURL: "https://proxy.example/v1",
      apiKey: "openai-proxy-key",
      maxInputTokens: 262144,
      maxTokens: 32768,
    });
    const model = modelRegistry.find("openai", "gateway-chat-coder");

    assert.ok(model);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, "https://proxy.example/v1");
    assert.equal(model.contextWindow, 262144);
    assert.equal(model.maxTokens, 32768);
  } finally {
    if (previousModelsJsonPath === undefined) {
      delete process.env[PI_MODELS_JSON_ENV];
    } else {
      process.env[PI_MODELS_JSON_ENV] = previousModelsJsonPath;
    }
  }
});

test("createPiModelRegistry accepts gemini model prefix as a google alias for auto-registration", () => {
  const previousModelsJsonPath = process.env[PI_MODELS_JSON_ENV];

  try {
    delete process.env[PI_MODELS_JSON_ENV];

    const { modelRegistry } = createPiModelRegistry({
      role: "generate",
      protocol: "google",
      modelName: "gemini:gemini-3-flash-agent",
      baseURL: "https://proxy.example/google/v1beta",
      apiKey: "google-proxy-key",
    });

    assert.ok(modelRegistry.find("google", "gemini-3-flash-agent"));
    assert.equal(modelRegistry.find("google", "gemini:gemini-3-flash-agent"), undefined);
  } finally {
    if (previousModelsJsonPath === undefined) {
      delete process.env[PI_MODELS_JSON_ENV];
    } else {
      process.env[PI_MODELS_JSON_ENV] = previousModelsJsonPath;
    }
  }
});

test("createPiModelRegistry does not auto-register model names with conflicting provider prefixes", () => {
  const previousModelsJsonPath = process.env[PI_MODELS_JSON_ENV];

  try {
    delete process.env[PI_MODELS_JSON_ENV];

    const { modelRegistry } = createPiModelRegistry({
      role: "generate",
      protocol: "google",
      modelName: "openai:gpt-4.1-mini",
      baseURL: "https://proxy.example/google/v1beta",
      apiKey: "google-proxy-key",
    });

    assert.equal(modelRegistry.find("google", "openai:gpt-4.1-mini"), undefined);
  } finally {
    if (previousModelsJsonPath === undefined) {
      delete process.env[PI_MODELS_JSON_ENV];
    } else {
      process.env[PI_MODELS_JSON_ENV] = previousModelsJsonPath;
    }
  }
});

test("resolveModelRoleConfigs rejects invalid protocol values", () => {
  assert.throws(
    () =>
      resolveModelRoleConfigs({
        APP_BUILDER_API_KEY: "global-key",
        APP_BUILDER_PLAN_PROTOCOL: "claude",
      }),
    /APP_BUILDER_PLAN_PROTOCOL must be one of: openai-chat, openai-responses, anthropic, google\. The aliases openai -> openai-responses and gemini -> google are also accepted\./,
  );
});

test("resolveModelRoleConfigs applies global max tokens to every role", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_MAX_TOKENS: "  16384  ",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].maxTokens, 16384);
  }
});

test("resolveModelRoleConfigs applies global max input tokens to every role", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_MAX_INPUT_TOKENS: "  131072  ",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].maxInputTokens, 131072);
  }
});

test("resolveModelRoleConfigs applies role-specific max input token overrides with global fallback", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_MAX_INPUT_TOKENS: "65536",
    APP_BUILDER_PLAN_MAX_INPUT_TOKENS: "262144",
    APP_BUILDER_GENERATE_MAX_INPUT_TOKENS: "131072",
  });

  assert.equal(configs.plan.maxInputTokens, 262144);
  assert.equal(configs.generate.maxInputTokens, 131072);
  assert.equal(configs.repair.maxInputTokens, 65536);
});

test("resolveModelRoleConfigs rejects invalid max input token values", () => {
  assert.throws(
    () =>
      resolveModelRoleConfigs({
        APP_BUILDER_API_KEY: "global-key",
        APP_BUILDER_PLAN_MAX_INPUT_TOKENS: "large",
      }),
    /APP_BUILDER_PLAN_MAX_INPUT_TOKENS must be a positive integer/,
  );
});

test("resolveModelRoleConfigs applies role-specific max token overrides with global fallback", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_MAX_TOKENS: "8192",
    APP_BUILDER_PLAN_MAX_TOKENS: "32768",
    APP_BUILDER_GENERATE_MAX_TOKENS: "16384",
  });

  assert.equal(configs.plan.maxTokens, 32768);
  assert.equal(configs.generate.maxTokens, 16384);
  assert.equal(configs.repair.maxTokens, 8192);
});

test("resolveModelRoleConfigs rejects invalid max token values", () => {
  assert.throws(
    () =>
      resolveModelRoleConfigs({
        APP_BUILDER_API_KEY: "global-key",
        APP_BUILDER_PLAN_MAX_TOKENS: "4096.5",
      }),
    /APP_BUILDER_PLAN_MAX_TOKENS must be a positive integer/,
  );
});

test("resolveModelRoleConfigs applies global user agent to every role", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_USER_AGENT: "  app-builder-test/1.0  ",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].userAgent, "app-builder-test/1.0");
  }
});

test("resolveModelRoleConfigs applies role-specific user agent overrides with global fallback", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_USER_AGENT: "global-agent/1.0",
    APP_BUILDER_PLAN_USER_AGENT: "  plan-agent/1.0  ",
    APP_BUILDER_GENERATE_USER_AGENT: "generate-agent/1.0",
    APP_BUILDER_REPAIR_USER_AGENT: "repair-agent/1.0",
  });

  assert.equal(configs.plan.userAgent, "plan-agent/1.0");
  assert.equal(configs.generate.userAgent, "generate-agent/1.0");
  assert.equal(configs.repair.userAgent, "repair-agent/1.0");
});

test("resolveModelRoleConfigs falls back to global user agent for roles without an override", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_USER_AGENT: "global-agent/1.0",
    APP_BUILDER_PLAN_USER_AGENT: "plan-agent/1.0",
  });

  assert.equal(configs.plan.userAgent, "plan-agent/1.0");
  assert.equal(configs.generate.userAgent, "global-agent/1.0");
  assert.equal(configs.repair.userAgent, "global-agent/1.0");
});

test("resolveModelRoleConfigs ignores empty user agent values", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_USER_AGENT: "   ",
  });

  for (const role of ["plan", "generate", "repair"] as const) {
    assert.equal(configs[role].userAgent, undefined);
  }
});

test("resolveModelRoleConfigs defaults model names when only a global key is present", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
  });

  assert.equal(configs.plan.modelName, DEFAULT_MODEL_NAME);
  assert.equal(configs.plan.protocol, "openai-responses");
  assert.equal(configs.plan.maxTokens, DEFAULT_MODEL_MAX_TOKENS);
  assert.equal(configs.generate.modelName, DEFAULT_MODEL_NAME);
  assert.equal(configs.generate.protocol, "openai-responses");
  assert.equal(configs.generate.maxTokens, DEFAULT_MODEL_MAX_TOKENS);
  assert.equal(configs.repair.modelName, DEFAULT_MODEL_NAME);
  assert.equal(configs.repair.protocol, "openai-responses");
  assert.equal(configs.repair.maxTokens, DEFAULT_MODEL_MAX_TOKENS);
});

test("resolveModelRoleConfigs applies role-specific model, base URL, and API key overrides", () => {
  const configs = resolveModelRoleConfigs({
    APP_BUILDER_API_KEY: "global-key",
    APP_BUILDER_BASE_URL: "https://global.example/v1",
    APP_BUILDER_MODEL: "openai:global-model",
    APP_BUILDER_PLAN_MODEL: "openai:plan-model",
    APP_BUILDER_GENERATE_MODEL: "openai:generate-model",
    APP_BUILDER_REPAIR_MODEL: "openai:repair-model",
    APP_BUILDER_PLAN_PROTOCOL: "anthropic",
    APP_BUILDER_GENERATE_PROTOCOL: "openai",
    APP_BUILDER_REPAIR_PROTOCOL: "anthropic",
    APP_BUILDER_PLAN_BASE_URL: "https://plan.example/v1",
    APP_BUILDER_GENERATE_BASE_URL: "https://generate.example/v1",
    APP_BUILDER_REPAIR_BASE_URL: "https://repair.example/v1",
    APP_BUILDER_PLAN_MAX_TOKENS: "32768",
    APP_BUILDER_GENERATE_MAX_TOKENS: "16384",
    APP_BUILDER_REPAIR_MAX_TOKENS: "8192",
    APP_BUILDER_PLAN_API_KEY: "plan-key",
    APP_BUILDER_GENERATE_API_KEY: "generate-key",
    APP_BUILDER_REPAIR_API_KEY: "repair-key",
  });

  assert.equal(configs.plan.modelName, "openai:plan-model");
  assert.equal(configs.generate.modelName, "openai:generate-model");
  assert.equal(configs.repair.modelName, "openai:repair-model");
  assert.equal(configs.plan.protocol, "anthropic");
  assert.equal(configs.generate.protocol, "openai-responses");
  assert.equal(configs.repair.protocol, "anthropic");
  assert.equal(configs.plan.baseURL, "https://plan.example/v1");
  assert.equal(configs.generate.baseURL, "https://generate.example/v1");
  assert.equal(configs.repair.baseURL, "https://repair.example/v1");
  assert.equal(configs.plan.maxTokens, 32768);
  assert.equal(configs.generate.maxTokens, 16384);
  assert.equal(configs.repair.maxTokens, 8192);
  assert.equal(configs.plan.apiKey, "plan-key");
  assert.equal(configs.generate.apiKey, "generate-key");
  assert.equal(configs.repair.apiKey, "repair-key");
});

test("buildGenerationSubagents exposes subagents only for generation phases", () => {
  assert.deepEqual(buildGenerationSubagents("plan", true), []);
  assert.deepEqual(buildGenerationSubagents("plan_repair", true), []);

  const generateSubagents = buildGenerationSubagents("generate", true);
  assert.deepEqual(
    generateSubagents.map((subagent) => subagent.name),
    ["fe-dev", "be-dev", "qa-dev"],
  );
  assert.deepEqual(generateSubagents[0]?.skills, ["/.workspace/skills"]);
  assert.match(String(generateSubagents[0]?.description), /parallel/);
  assert.match(String(generateSubagents[0]?.systemPrompt), /throughput optimization/);
  assert.match(String(generateSubagents[0]?.systemPrompt), /Do not edit files outside your assigned ownership/);

  const guardedSubagents = buildGenerationSubagents(
    "generate",
    false,
    "## Host-Enforced Project Config Guard\nDo not edit `next.config.ts`.",
  );
  assert.equal(guardedSubagents.length, 3);
  assert.match(String(guardedSubagents[0]?.systemPrompt), /Host-Enforced Project Config Guard/);
  assert.match(String(guardedSubagents[1]?.systemPrompt), /next\.config\.ts/);
  assert.match(String(guardedSubagents[2]?.systemPrompt), /Do not edit `next\.config\.ts`/);

  const repairSubagents = buildGenerationSubagents("generateRepair", false);
  assert.equal(repairSubagents.length, 3);
  assert.equal("skills" in repairSubagents[0]!, false);

  const middleware = [{ name: "compatibility" }];
  const middlewareSubagents = buildGenerationSubagents("generate", false, "", middleware);
  assert.equal(middlewareSubagents[0]?.middleware, middleware);
});

test("normalizeWriteTodosToolCallArgs accepts stringified and loose todo arrays", () => {
  const malformedSessionTodos = [
    '{"content": "Read existing files (globals.css, layout.tsx, page.tsx, types)", "status": "in_progress", "pending": "pending"}',
    '{"content": "Update /app/globals.css with design system styles", "status": "pending", "pending"}',
  ].join(", ");

  assert.deepEqual(
    normalizeWriteTodosToolCallArgs({
      todos: `[${malformedSessionTodos}]`,
    }),
    {
      todos: [
        { content: "Read existing files (globals.css, layout.tsx, page.tsx, types)", status: "in_progress" },
        { content: "Update /app/globals.css with design system styles", status: "pending" },
      ],
    },
  );

  assert.deepEqual(
    normalizeWriteTodosToolCallArgs(JSON.stringify({
      todos: [
        { content: "分析需求", status: "completed" },
        { content: "生成计划", status: "in_progress" },
      ],
    })),
    {
      todos: [
        { content: "分析需求", status: "completed" },
        { content: "生成计划", status: "in_progress" },
      ],
    },
  );
  assert.deepEqual(
    normalizeWriteTodosToolCallArgs({
      todos: [
        { content: "Create Account page", status: "pending" },
        { content: "Create Role page" },
      ],
    }),
    {
      todos: [
        { content: "Create Account page", status: "pending" },
        { content: "Create Role page", status: "pending" },
      ],
    },
  );
});

test("resolveModelRoleConfigs rejects missing role API key coverage without a global key", () => {
  assert.throws(
    () =>
      resolveModelRoleConfigs({
        APP_BUILDER_PLAN_API_KEY: "plan-key",
      }),
    /Missing: APP_BUILDER_GENERATE_API_KEY, APP_BUILDER_REPAIR_API_KEY/,
  );
});

test("resolveModelRoleConfigs can merge persisted model metadata with current secrets", () => {
  const configs = resolveModelRoleConfigs(
    {
      APP_BUILDER_API_KEY: "runtime-key",
    },
    {
      fallbackModelName: "openai:legacy-model",
      persisted: {
        plan: {
          role: "plan",
          modelName: "openai:persisted-plan",
          protocol: "anthropic",
          baseURL: "https://persisted-plan.example/v1",
          maxInputTokens: 131072,
          maxTokens: 24576,
        },
        repair: {
          role: "repair",
          modelName: "openai:persisted-repair",
          protocol: "openai-responses",
        },
      },
    },
  );

  assert.equal(configs.plan.modelName, "openai:persisted-plan");
  assert.equal(configs.plan.protocol, "anthropic");
  assert.equal(configs.plan.baseURL, "https://persisted-plan.example/v1");
  assert.equal(configs.plan.maxInputTokens, 131072);
  assert.equal(configs.plan.maxTokens, 24576);
  assert.equal(configs.generate.modelName, "openai:legacy-model");
  assert.equal(configs.generate.protocol, "openai-responses");
  assert.equal(configs.generate.maxInputTokens, undefined);
  assert.equal(configs.generate.maxTokens, DEFAULT_MODEL_MAX_TOKENS);
  assert.equal(configs.repair.modelName, "openai:persisted-repair");
  assert.equal(configs.repair.protocol, "openai-responses");
  assert.equal(configs.repair.maxTokens, DEFAULT_MODEL_MAX_TOKENS);
  assert.equal(configs.repair.apiKey, "runtime-key");
});

test("sanitizeModelRoleConfigs strips API keys", () => {
  const sanitized = sanitizeModelRoleConfigs(
    resolveModelRoleConfigs({
      APP_BUILDER_API_KEY: "global-secret",
      APP_BUILDER_MODEL: "openai:gpt-5.4-mini",
      APP_BUILDER_PROTOCOL: "anthropic",
      APP_BUILDER_BASE_URL: "https://proxy.example/v1",
      APP_BUILDER_USER_AGENT: "app-builder-test/1.0",
      APP_BUILDER_MAX_INPUT_TOKENS: "131072",
      APP_BUILDER_MAX_TOKENS: "32768",
    }),
  );
  const serialized = JSON.stringify(sanitized);

  assert.equal("apiKey" in sanitized.plan, false);
  assert.equal("apiKey" in sanitized.generate, false);
  assert.equal("apiKey" in sanitized.repair, false);
  assert.equal(sanitized.plan.protocol, "anthropic");
  assert.equal(sanitized.plan.userAgent, "app-builder-test/1.0");
  assert.equal(sanitized.plan.maxInputTokens, 131072);
  assert.equal(sanitized.plan.maxTokens, 32768);
  assert.doesNotMatch(serialized, /global-secret/);
  assert.match(serialized, /openai:gpt-5\.4-mini/);
});

test("modelRoleForRuntimePhase maps workflow phases to model roles", () => {
  assert.equal(modelRoleForRuntimePhase("plan"), "plan");
  assert.equal(modelRoleForRuntimePhase("generate"), "generate");
  assert.equal(modelRoleForRuntimePhase("planRepair"), "repair");
  assert.equal(modelRoleForRuntimePhase("plan_repair"), "repair");
  assert.equal(modelRoleForRuntimePhase("generateRepair"), "repair");
  assert.equal(modelRoleForRuntimePhase("generate_repair"), "repair");
  assert.equal(modelRoleForRuntimePhase("complete"), undefined);
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

test("normalizeGoogleModelName strips google and gemini provider prefixes", () => {
  assert.equal(normalizeGoogleModelName("google:gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(normalizeGoogleModelName("gemini:gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(normalizeGoogleModelName("gemini-2.5-flash"), "gemini-2.5-flash");
});

test("resolveGoogleReasoningEffort maps template max to google high", () => {
  assert.equal(resolveGoogleReasoningEffort("low"), "low");
  assert.equal(resolveGoogleReasoningEffort("medium"), "medium");
  assert.equal(resolveGoogleReasoningEffort("high"), "high");
  assert.equal(resolveGoogleReasoningEffort("max"), "high");
});

test("createGoogleModel configures Gemini model generation params", () => {
  const model = createGoogleModel({
    modelName: "google:gemini-2.5-flash",
    effort: "high",
    userAgent: "app-builder-test/1.0",
    maxTokens: 8192,
    apiKey: "test-key",
  }) as unknown as {
    model: string;
    _llmType: () => string;
    invocationParams: (options: Record<string, unknown>) => {
      generationConfig?: {
        temperature?: number;
        maxOutputTokens?: number;
        thinkingConfig?: unknown;
      };
    };
  };

  assert.equal(model.model, "gemini-2.5-flash");
  assert.equal(model._llmType(), "google");
  const params = model.invocationParams({});
  assert.equal(params.generationConfig?.temperature, 0);
  assert.equal(params.generationConfig?.maxOutputTokens, 8192);
  assert.ok(params.generationConfig?.thinkingConfig);
});

test("rewriteGoogleApiRequestUrl maps Gemini requests onto a configured base URL", () => {
  assert.equal(
    rewriteGoogleApiRequestUrl(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      "http://127.0.0.1:8045",
    ),
    "http://127.0.0.1:8045/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  );

  assert.equal(
    rewriteGoogleApiRequestUrl(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      "https://proxy.example/google/v1beta",
    ),
    "https://proxy.example/google/v1beta/models/gemini-2.5-flash:generateContent",
  );
});

test("createGoogleModel routes Gemini protocol fetches through configured base URL", async () => {
  const originalFetch = globalThis.fetch;
  let capturedRequest: Request | undefined;
  globalThis.fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    capturedRequest = request instanceof Request ? request : new Request(request, init);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  try {
    const model = createGoogleModel({
      modelName: "gemini-2.5-flash",
      baseURL: "http://127.0.0.1:8045",
      apiKey: "proxy-key",
    }) as unknown as {
      apiClient: {
        fetch: (request: Request) => Promise<Response>;
      };
    };

    await model.apiClient.fetch(new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
      { method: "POST", body: "{}" },
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    capturedRequest?.url,
    "http://127.0.0.1:8045/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  );
  assert.equal(capturedRequest?.headers.get("x-goog-api-key"), "proxy-key");
});

test("createOpenAICompatibleModel enables reasoning_content compat for every provider", () => {
  const openaiModel = createOpenAICompatibleModel({
    modelName: "openai:gpt-4.1-mini",
    baseURL: "https://api.openai.com/v1",
    apiKey: "test-key",
  }) as unknown as { completions?: { constructor?: { name?: string } } };
  const compatibleProviderModel = createOpenAICompatibleModel({
    modelName: "openai:qwen-plus",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKey: "test-key",
  }) as unknown as { completions?: { constructor?: { name?: string } } };

  assert.match(openaiModel.completions?.constructor?.name ?? "", /ReasoningContent/);
  assert.match(compatibleProviderModel.completions?.constructor?.name ?? "", /ReasoningContent/);
});

test("createOpenAICompatibleModel preserves base URL when setting user agent header", () => {
  const model = createOpenAICompatibleModel({
    modelName: "openai:test-model",
    baseURL: "https://proxy.example/v1",
    userAgent: "app-builder-test/1.0",
    maxTokens: 16384,
    apiKey: "test-key",
  }) as unknown as {
    identifyingParams: () => {
      baseURL?: string;
      defaultHeaders?: Record<string, string>;
      max_tokens?: number;
    };
  };

  const identifyingParams = model.identifyingParams();
  assert.equal(identifyingParams.baseURL, "https://proxy.example/v1");
  assert.equal(identifyingParams.defaultHeaders?.["User-Agent"], "app-builder-test/1.0");
  assert.equal(identifyingParams.max_tokens, 16384);
});

test("StableAnthropicToolCallChatModel applies configured max tokens", () => {
  const model = new StableAnthropicToolCallChatModel({
    model: "kimi-k2",
    maxTokens: 16384,
    apiKey: "test-key",
  }) as unknown as {
    identifyingParams: () => {
      max_tokens?: number;
    };
  };

  assert.equal(model.identifyingParams().max_tokens, 16384);
});

test("anthropic tool stream stabilizer suppresses partial tool arg chunks until complete JSON", async () => {
  const { AIMessageChunk } = await loadLangChainCoreMessages();
  const { ChatGenerationChunk } = await loadLangChainCoreOutputs();
  const createAnthropicGenerationChunk = (fields: unknown): ChatGenerationChunkLike => new ChatGenerationChunk({
    text: "",
    message: new AIMessageChunk(fields),
  }) as ChatGenerationChunkLike;
  const state = createAnthropicToolCallStreamState();

  const partialOutputs = [
    stabilizeAnthropicToolCallGenerationChunk(
      createAnthropicGenerationChunk({
        id: "msg_1",
        content: [{ index: 0, type: "tool_use", id: "tool_1", name: "read_file", input: "" }],
        response_metadata: { model_provider: "anthropic" },
        tool_call_chunks: [{ id: "tool_1", index: 0, name: "read_file", args: "" }],
      }),
      state,
    ),
    stabilizeAnthropicToolCallGenerationChunk(
      createAnthropicGenerationChunk({
        content: [{ index: 0, type: "input_json_delta", input: "{\"" }],
        response_metadata: { model_provider: "anthropic" },
        tool_call_chunks: [{ index: 0, args: "{\"" }],
      }),
      state,
    ),
    stabilizeAnthropicToolCallGenerationChunk(
      createAnthropicGenerationChunk({
        content: [{ index: 0, type: "input_json_delta", input: "file_path" }],
        response_metadata: { model_provider: "anthropic" },
        tool_call_chunks: [{ index: 0, args: "file_path" }],
      }),
      state,
    ),
    stabilizeAnthropicToolCallGenerationChunk(
      createAnthropicGenerationChunk({
        content: [{ index: 0, type: "input_json_delta", input: "\":\"README.md\"}" }],
        response_metadata: { model_provider: "anthropic" },
        tool_call_chunks: [{ index: 0, args: "\":\"README.md\"}" }],
      }),
      state,
    ),
  ].flat();

  assert.equal(partialOutputs.length, 0);

  const flushed = flushAnthropicToolCallStreamState(state);
  assert.equal(flushed.length, 1);

  const message = flushed[0]?.message as { invalid_tool_calls?: unknown[]; tool_calls?: unknown[] };
  assert.deepEqual(message.invalid_tool_calls, []);
  assert.deepEqual(message.tool_calls, [
    {
      name: "read_file",
      args: { file_path: "README.md" },
      id: "tool_1",
      type: "tool_call",
    },
  ]);
});

test("anthropic tool stream stabilizer drops incomplete final tool args without invalid calls", async () => {
  const { AIMessageChunk } = await loadLangChainCoreMessages();
  const { ChatGenerationChunk } = await loadLangChainCoreOutputs();
  const createAnthropicGenerationChunk = (fields: unknown): ChatGenerationChunkLike => new ChatGenerationChunk({
    text: "",
    message: new AIMessageChunk(fields),
  }) as ChatGenerationChunkLike;
  const state = createAnthropicToolCallStreamState();

  stabilizeAnthropicToolCallGenerationChunk(
    createAnthropicGenerationChunk({
      id: "msg_1",
      content: [{ index: 0, type: "tool_use", id: "tool_1", name: "read_file", input: "" }],
      response_metadata: { model_provider: "anthropic" },
      tool_call_chunks: [{ id: "tool_1", index: 0, name: "read_file", args: "" }],
    }),
    state,
  );
  stabilizeAnthropicToolCallGenerationChunk(
    createAnthropicGenerationChunk({
      content: [{ index: 0, type: "input_json_delta", input: "{\"file" }],
      response_metadata: { model_provider: "anthropic" },
      tool_call_chunks: [{ index: 0, args: "{\"file" }],
    }),
    state,
  );

  assert.deepEqual(flushAnthropicToolCallStreamState(state), []);
});

test("anthropic tool stream stabilizer leaves non-tool chunks unchanged", async () => {
  const { AIMessageChunk } = await loadLangChainCoreMessages();
  const { ChatGenerationChunk } = await loadLangChainCoreOutputs();
  const createAnthropicGenerationChunk = (fields: unknown): ChatGenerationChunkLike => new ChatGenerationChunk({
    text: "",
    message: new AIMessageChunk(fields),
  }) as ChatGenerationChunkLike;
  const state = createAnthropicToolCallStreamState();
  const chunk = createAnthropicGenerationChunk({
    content: "hello",
    response_metadata: { model_provider: "anthropic" },
  });

  assert.deepEqual(stabilizeAnthropicToolCallGenerationChunk(chunk, state), [chunk]);
});

test("resolveModelReasoningEffort maps template max to model xhigh", () => {
  assert.equal(resolveModelReasoningEffort("low"), "low");
  assert.equal(resolveModelReasoningEffort("high"), "high");
  assert.equal(resolveModelReasoningEffort("max"), "xhigh");
});

test("openai-compatible streaming ignores closed stream controller callback errors", async () => {
  const model = createOpenAICompatibleModel({
    modelName: "openai:test-model",
    apiKey: "test-key",
  }) as unknown as {
    completions: {
      completionWithRetry: unknown;
      _streamResponseChunks: (
        messages: unknown[],
        options: Record<string, unknown>,
        runManager: { handleLLMNewToken: () => Promise<void> },
      ) => AsyncIterable<{ text?: string }>;
    };
  };
  model.completions.completionWithRetry = async () => (async function* () {
    yield {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "hello" },
        },
      ],
    };
  })();
  const closedControllerError = new TypeError("Invalid state: Controller is already closed") as TypeError & {
    code: string;
  };
  closedControllerError.code = "ERR_INVALID_STATE";

  const chunks: string[] = [];
  for await (const chunk of model.completions._streamResponseChunks([], {}, {
    handleLLMNewToken: async () => {
      throw closedControllerError;
    },
  })) {
    chunks.push(chunk.text ?? "");
  }

  assert.deepEqual(chunks, ["hello"]);
});

test("sanitizeOpenAICompatibleCompletionsParams removes forced tool choice", () => {
  const sanitized = sanitizeOpenAICompatibleCompletionsParams({
    model: "qwen-plus",
    tool_choice: "required",
    tools: [{ type: "function", function: { name: "extract", parameters: { type: "object" } } }],
  });

  assert.equal("tool_choice" in sanitized, false);
  assert.deepEqual(
    sanitizeOpenAICompatibleCompletionsParams({ model: "qwen-plus", tool_choice: "auto" }),
    { model: "qwen-plus", tool_choice: "auto" },
  );
});

test("convertMessagesToOpenAICompatibleCompletionsMessageParams keeps reasoning_content for tool turns", async () => {
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

  const converted = convertMessagesToOpenAICompatibleCompletionsMessageParams({
    messages: messages as any,
    model: "qwen-plus",
  });
  const resolved = await converted;
  const assistantMessages = resolved.filter((message) => message.role === "assistant") as Array<{
    reasoning_content?: string;
  }>;

  assert.equal(assistantMessages[0]?.reasoning_content, "Need to fetch the current date before asking weather.");
  assert.equal(assistantMessages[1]?.reasoning_content, "The tool returned today's date, so tomorrow is one day later.");
});

test("convertMessagesToOpenAICompatibleCompletionsMessageParams preserves empty reasoning_content for tool turns", async () => {
  const { AIMessage, HumanMessage, ToolMessage } = await loadLangChainCoreMessages();
  const converted = await convertMessagesToOpenAICompatibleCompletionsMessageParams({
    messages: [
      new HumanMessage("Read the project file."),
      new AIMessage({
        content: "",
        additional_kwargs: {
          reasoning_content: "",
        },
        tool_calls: [
          {
            id: "call_1",
            name: "read_file",
            args: { path: "package.json" },
            type: "tool_call",
          },
        ],
      }),
      new ToolMessage({
        content: "{}",
        tool_call_id: "call_1",
      }),
    ] as any,
    model: "qwen-plus",
  });
  const assistantMessage = converted.find((message) => message.role === "assistant") as {
    reasoning_content?: string;
  } | undefined;

  assert.notEqual(assistantMessage, undefined);
  assert.equal("reasoning_content" in assistantMessage!, true);
  assert.equal(assistantMessage?.reasoning_content, "");
});

test("convertMessagesToOpenAICompatibleCompletionsMessageParams drops reasoning_content for non-tool turns", async () => {
  const { AIMessage, HumanMessage } = await loadLangChainCoreMessages();
  const converted = await convertMessagesToOpenAICompatibleCompletionsMessageParams({
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
    model: "qwen-plus",
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

test("extractCompatibleStreamErrorReason finds OpenAI SDK connection errors", () => {
  const error = new Error("middleware failed") as Error & { cause?: unknown };
  error.cause = new Error("Connection error.");

  assert.equal(extractCompatibleStreamErrorReason(error), "connection error");
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
        "[12:00:01] [READ] 读取文件：.workspace/source-prd.md（1-1000行）",
      ],
    });
    await renderer.update({
      ...baseState,
      logs: [
        ...baseState.logs,
        "[12:00:01] [READ] 读取文件：.workspace/source-prd.md（1-1000行）",
      ],
    });
    await renderer.stop();
  } finally {
    setWorkflowStdoutMode(undefined);
  }

  assert.deepEqual(writes, [
    "[12:00:00] [FLOW] 进入计划阶段，开始流式生成。\n",
    "[12:00:01] [READ] 读取文件：.workspace/source-prd.md（1-1000行）\n",
  ]);
});

test("toVirtualWorkspacePath anchors files at the virtual workspace root", () => {
  const outputDirectory = path.resolve("tmp", "app-builder-output");

  assert.equal(
    toVirtualWorkspacePath(outputDirectory, path.join(outputDirectory, ".workspace", "plan-spec.json")),
    "/.workspace/plan-spec.json",
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

test("parseTodoMarkdown reads the host-monitored workspace todo board", () => {
  assert.deepEqual(
    parseTodoMarkdown([
      "# App Builder TODO",
      "",
      "- [x] 读取 PRD",
      "- [~] 组装计划",
      "- [ ] 等待校验",
      "- [in_progress] 修复失败项",
    ].join("\n")),
    [
      { content: "读取 PRD", status: "completed" },
      { content: "组装计划", status: "in_progress" },
      { content: "等待校验", status: "pending" },
      { content: "修复失败项", status: "in_progress" },
    ],
  );
  assert.equal(parseTodoMarkdown("# empty\n"), null);
});

test("updateWorkflowBoard clears the monitored todo file before phase changes", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "app-builder-todo-phase-"));
  const workspaceDirectory = path.join(outputDirectory, ".workspace");
  const todoPath = path.join(workspaceDirectory, "todo.md");

  try {
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(todoPath, "- [~] stale plan todo\n", "utf8");

    await updateWorkflowBoard({
      stage: "计划阶段",
      todos: [{ content: "读取 PRD 与模板上下文", status: "in_progress" }],
      artifacts: [],
      narrative: "进入计划阶段。",
      outputDirectory,
      runtimeStatus: { phase: "plan" },
    });

    assert.equal(parseTodoMarkdown(await readFile(todoPath, "utf8")), null);

    await writeFile(todoPath, "- [~] live plan todo\n", "utf8");
    await updateWorkflowBoard({
      stage: "计划阶段",
      todos: [{ content: "读取 PRD 与模板上下文", status: "in_progress" }],
      artifacts: [],
      narrative: "计划阶段继续。",
      outputDirectory,
      runtimeStatus: { phase: "plan" },
    });

    assert.deepEqual(parseTodoMarkdown(await readFile(todoPath, "utf8")), [
      { content: "live plan todo", status: "in_progress" },
    ]);

    await writeFile(todoPath, "- [~] stale before plan repair\n", "utf8");
    await updateWorkflowBoard({
      stage: "计划阶段",
      todos: [{ content: "修复计划阶段产物", status: "in_progress" }],
      artifacts: [],
      narrative: "进入计划修复。",
      outputDirectory,
      runtimeStatus: { phase: "planRepair" },
    });

    assert.equal(parseTodoMarkdown(await readFile(todoPath, "utf8")), null);

    await writeFile(todoPath, "- [~] live plan repair todo\n", "utf8");
    await updateWorkflowBoard({
      stage: "计划阶段",
      todos: [{ content: "修复计划阶段产物", status: "in_progress" }],
      artifacts: [],
      narrative: "计划修复继续。",
      outputDirectory,
      runtimeStatus: { phase: "planRepair" },
    });

    assert.deepEqual(parseTodoMarkdown(await readFile(todoPath, "utf8")), [
      { content: "live plan repair todo", status: "in_progress" },
    ]);

    await updateWorkflowBoard({
      stage: "生成阶段",
      todos: [{ content: "读取已验证的 planSpec 与 starter", status: "in_progress" }],
      artifacts: [],
      narrative: "进入生成阶段。",
      outputDirectory,
      runtimeStatus: { phase: "generate" },
    });

    assert.equal(parseTodoMarkdown(await readFile(todoPath, "utf8")), null);
  } finally {
    await closeWorkflowBoard();
    await rm(outputDirectory, { recursive: true, force: true });
  }
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
      { label: ".workspace/prd-analysis.md", status: "generating" },
      { label: ".workspace/generated-spec.md", status: "generating" },
      { label: ".workspace/plan-spec.json", status: "generating" },
      { label: ".workspace/interaction-contract.json", status: "generating" },
      { label: ".workspace/plan-validation.json", status: "generating" },
      { label: "app/api/**", status: "pending" },
      { label: "app/** 页面与布局", status: "pending" },
      { label: "app-builder-report.md", status: "pending" },
      { label: ".workspace/generation-validation.json", status: "pending" },
    ],
  );

  assert.deepEqual(
    createArtifactItemsForStage("生成阶段", "verified").map((item) => ({
      label: item.label,
      status: item.status,
    })),
    [
      { label: ".workspace/prd-analysis.md", status: "verified" },
      { label: ".workspace/generated-spec.md", status: "verified" },
      { label: ".workspace/plan-spec.json", status: "verified" },
      { label: ".workspace/interaction-contract.json", status: "verified" },
      { label: ".workspace/plan-validation.json", status: "verified" },
      { label: "app/api/**", status: "verified" },
      { label: "app/** 页面与布局", status: "verified" },
      { label: "app-builder-report.md", status: "verified" },
      { label: ".workspace/generation-validation.json", status: "verified" },
    ],
  );

  assert.deepEqual(
    createArtifactItemsForStage("完成阶段", "verified").map((item) => ({
      label: item.label,
      status: item.status,
    })),
    [
      { label: ".workspace/prd-analysis.md", status: "verified" },
      { label: ".workspace/generated-spec.md", status: "verified" },
      { label: ".workspace/plan-spec.json", status: "verified" },
      { label: ".workspace/interaction-contract.json", status: "verified" },
      { label: ".workspace/plan-validation.json", status: "verified" },
      { label: "app/api/**", status: "verified" },
      { label: "app/** 页面与布局", status: "verified" },
      { label: "app-builder-report.md", status: "verified" },
      { label: ".workspace/generation-validation.json", status: "verified" },
    ],
  );

  assert.deepEqual(
    createArtifactItemsForStage("运行验证阶段", "validating").map((item) => ({
      label: item.label,
      status: item.status,
    })),
    [
      { label: ".workspace/prd-analysis.md", status: "verified" },
      { label: ".workspace/generated-spec.md", status: "verified" },
      { label: ".workspace/plan-spec.json", status: "verified" },
      { label: ".workspace/interaction-contract.json", status: "verified" },
      { label: ".workspace/plan-validation.json", status: "verified" },
      { label: "app/api/**", status: "verified" },
      { label: "app/** 页面与布局", status: "verified" },
      { label: "app-builder-report.md", status: "verified" },
      { label: ".workspace/generation-validation.json", status: "verified" },
      { label: ".workspace/runtime-interaction-validation.json", status: "validating" },
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
      "[12:34:57] [READ] 读取文件：.workspace/source-prd.md（1-1000行）",
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
  assert.doesNotMatch(output, /修复进展/);
  assert.doesNotMatch(output, /暂无修复进展/);
  assert.match(output, /\[12:34:56\] \[FLOW\] 进入计划阶段/);
  assert.match(output, /\[12:34:57\] \[READ\]/);
  assert.match(output, /读取文件：\.workspace\/source-prd\.md（1-1000行）/);
  assert.match(output, /\[12:34:58\] \[CHECK\] 正在校验计划阶段产出物/);
  assert.match(output, /model: gpt-5\.4 \| effort: high \| token used: 1\.2K total \(.+\) \| context used: 900/);
  assert.match(output, /reasoning 120/);
  assert.match(output, /cache 256/);
  assert.match(output, /context used: 900 \| phase: plan/);
});

test("renderTodoBoardToString shows configured context window size", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "计划阶段",
    todos: createStepItemsForLifecycle("计划阶段", "generating"),
    artifacts: createArtifactItemsForStage("计划阶段", "generating"),
    narrative: "正在分析 PRD。",
    runtimeStatus: {
      modelName: "gpt-5.4",
      effort: "high",
      phase: "plan",
      contextWindowUsedTokens: 41_600,
      contextWindowTokens: 131_072,
    },
  }, 180));

  assert.match(output, /context used: 41K\/128K \| phase: plan/);
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

test("renderTodoBoardToString does not reset token progress with zero output", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "计划阶段",
    todos: [
      { content: "读取 PRD 与模板上下文", status: "in_progress" },
    ],
    artifacts: createArtifactItemsForStage("计划阶段", "generating"),
    narrative: "模型正在工作中",
    elapsedMs: 2_000,
    runtimeStatus: {
      usage: {
        inputTokens: 8_192,
      },
    },
    streamProgress: {
      inputTokens: 8_192,
    },
  }, 120));

  assert.match(output, /当前动作：模型正在工作中（2s, in: 8.2 k）/);
  assert.doesNotMatch(output, /out：0/);
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

test("renderTodoBoardToString shows an empty repair column only during repair context", () => {
  const normalOutput = stripAnsi(renderTodoBoardToString({
    stage: "生成阶段",
    todos: [
      { content: "读取已验证的 planSpec 与 starter", status: "completed" },
      { content: "实现资源模型与 REST API", status: "in_progress" },
    ],
    artifacts: createArtifactItemsForStage("生成阶段", "generating"),
    narrative: "正在实现页面。",
    logs: [
      "[12:36:01] [FLOW] 生成阶段流式输出完成，开始宿主校验。",
      "[12:36:02] [READ] 读取文件：app/page.tsx（1-120行）",
    ],
    runtimeStatus: {
      phase: "generate",
    },
  }, 140));

  const repairOutput = stripAnsi(renderTodoBoardToString({
    stage: "生成阶段",
    todos: [
      { content: "读取已验证的 planSpec 与 starter", status: "completed" },
      { content: "修复生成阶段交付物", status: "in_progress" },
    ],
    artifacts: createArtifactItemsForStage("生成阶段", "generating"),
    narrative: "正在等待修复输出。",
    logs: [
      "[12:37:01] [FLOW] 读取已验证产物。",
    ],
    runtimeStatus: {
      phase: "generate_repair",
    },
  }, 140));

  assert.match(normalOutput, /执行日志/);
  assert.doesNotMatch(normalOutput, /修复进展/);
  assert.doesNotMatch(normalOutput, /暂无修复进展/);
  assert.match(repairOutput, /修复进展/);
  assert.match(repairOutput, /暂无修复进展/);
});

test("buildTodoBoardLines hides the empty repair section outside repair context", () => {
  const normalLines = buildTodoBoardLines({
    stage: "生成阶段",
    todos: [
      { content: "读取已验证的 planSpec 与 starter", status: "completed" },
    ],
    artifacts: createArtifactItemsForStage("生成阶段", "generating"),
    narrative: "正在实现页面。",
    logs: [
      "[12:36:01] [FLOW] 生成阶段流式输出完成，开始宿主校验。",
    ],
    runtimeStatus: {
      phase: "generate",
    },
  });
  const repairLines = buildTodoBoardLines({
    stage: "生成阶段",
    todos: [
      { content: "修复生成阶段交付物", status: "in_progress" },
    ],
    artifacts: createArtifactItemsForStage("生成阶段", "generating"),
    narrative: "正在等待修复输出。",
    logs: [
      "[12:37:01] [FLOW] 读取已验证产物。",
    ],
    runtimeStatus: {
      phase: "generate_repair",
    },
  });

  assert.equal(normalLines.some((line) => /修复进展|暂无修复进展/.test(line)), false);
  assert.equal(repairLines.some((line) => /修复进展：/.test(line)), true);
  assert.equal(repairLines.some((line) => /暂无修复进展/.test(line)), true);
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

test("renderTodoBoardToString can render interactive runtime validation details", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "运行验证阶段",
    sessionId: "12345678-90ab-cdef-1234-567890abcdef",
    todos: createStepItemsForLifecycle("运行验证阶段", "validating"),
    artifacts: createArtifactItemsForStage("运行验证阶段", "validating"),
    narrative: "正在监听 dev server 输出。",
    runtimeInteraction: {
      validationUrl: "http://127.0.0.1:4321/validate",
      proxyUrl: "http://127.0.0.1:4321",
      devServerUrl: "http://127.0.0.1:4321",
      browserOpenAttempted: true,
      browserOpened: true,
      implementationRequest: "把详情页增加状态更新时间字段",
      devServerOutputSummary: "ready - started server",
      recentDevServerOutput: ["ready - started server"],
    },
  }, 140));

  assert.match(output, /计划阶段 -> 生成阶段 -> 运行验证阶段 -> 完成阶段/);
  assert.match(output, /运行验证：/);
  assert.match(output, /验证 URL：http:\/\/127\.0\.0\.1:4321\/validate/);
  assert.match(output, /Dev server URL：http:\/\/127\.0\.0\.1:4321/);
  assert.match(output, /代理 URL：http:\/\/127\.0\.0\.1:4321/);
  assert.match(output, /浏览器：已自动打开默认浏览器/);
  assert.match(output, /用户要求：把详情页增加状态更新时间字段/);
  assert.match(output, /输出摘要：ready - started server/);
  assert.match(output, /runtime-interaction-validation\.json/);
  assert.match(output, /ready - started server/);
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

test("mergeWorkflowRuntimeStatus aggregates usage snapshots without repeated frame inflation", () => {
  const usageSnapshots = new Map<string, RuntimeUsageSummary>();
  const state = {
    stage: "计划阶段" as const,
    todos: [],
    artifacts: [],
    narrative: "模型正在工作中",
  };

  const firstPlanFrame = mergeWorkflowRuntimeStatus(
    undefined,
    {
      phase: "plan",
      attempt: 1,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 10,
      },
    },
    state,
    usageSnapshots,
  );
  const secondPlanFrame = mergeWorkflowRuntimeStatus(
    firstPlanFrame,
    {
      phase: "plan",
      attempt: 1,
      usage: {
        inputTokens: 150,
        outputTokens: 30,
        totalTokens: 180,
        cachedInputTokens: 10,
      },
    },
    state,
    usageSnapshots,
  );
  const firstRepairFrame = mergeWorkflowRuntimeStatus(
    secondPlanFrame,
    {
      phase: "planRepair",
      attempt: 2,
      usage: {
        inputTokens: 50,
        outputTokens: 10,
        totalTokens: 60,
        cachedInputTokens: 5,
      },
    },
    state,
    usageSnapshots,
  );
  const secondRepairFrame = mergeWorkflowRuntimeStatus(
    firstRepairFrame,
    {
      phase: "planRepair",
      attempt: 2,
      usage: {
        inputTokens: 70,
        outputTokens: 15,
        totalTokens: 85,
        cachedInputTokens: 8,
      },
    },
    state,
    usageSnapshots,
  );
  const nextRepairAttempt = mergeWorkflowRuntimeStatus(
    secondRepairFrame,
    {
      phase: "planRepair",
      attempt: 3,
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cachedInputTokens: 7,
      },
    },
    state,
    usageSnapshots,
  );

  assert.deepEqual(firstPlanFrame?.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 10,
  });
  assert.deepEqual(secondPlanFrame?.usage, {
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 180,
    cachedInputTokens: 10,
  });
  assert.deepEqual(firstRepairFrame?.usage, {
    inputTokens: 200,
    outputTokens: 40,
    totalTokens: 240,
    cachedInputTokens: 15,
  });
  assert.deepEqual(secondRepairFrame?.usage, {
    inputTokens: 220,
    outputTokens: 45,
    totalTokens: 265,
    cachedInputTokens: 18,
  });
  assert.deepEqual(nextRepairAttempt?.usage, {
    inputTokens: 300,
    outputTokens: 65,
    totalTokens: 365,
    cachedInputTokens: 25,
  });
});


test("renderTodoBoardToString renders agent statuses below runtime status bar", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "生成阶段",
    todos: [
      { content: "读取已验证的 planSpec 与 starter", status: "in_progress" },
    ],
    artifacts: createArtifactItemsForStage("生成阶段", "generating"),
    narrative: "模型正在工作中",
    runtimeStatus: {
      modelName: "gpt-5.4",
      phase: "generate",
    },
    agentStatuses: [
      { name: "leader", status: "working", userAgent: "app-builder-test/1.0" },
      { name: "fe-dev", status: "working", activeInstanceCount: 2 },
      { name: "be-dev", status: "done" },
      { name: "qa-dev", status: "working" },
    ],
  }, 140));

  assert.match(output, /model: gpt-5\.4 .* phase: generate/);
  assert.match(output, /subagents: 3/);
  assert.match(
    output,
    /leader\(app-builder-test\/1\.0\): working \| fe-dev: 2 instances working \| be-dev: worked 1 time \|[\s\S]*qa-dev: 1 instance working/,
  );
  assert.ok(
    output.indexOf("leader(app-builder-test/1.0): working") > output.indexOf("phase: generate"),
    "agent status row should render below the runtime status bar",
  );
});

test("renderTodoBoardToString keeps worked agents from reverting to idle", () => {
  const output = stripAnsi(renderTodoBoardToString({
    stage: "生成阶段",
    todos: [],
    artifacts: createArtifactItemsForStage("生成阶段", "generating"),
    narrative: "模型正在工作中",
    runtimeStatus: {
      modelName: "gpt-5.4",
      phase: "generate",
    },
    agentStatuses: [
      { name: "fe-dev", status: "idle", workCount: 3 },
      { name: "be-dev", status: "idle" },
      { name: "qa-dev", status: "idle", activeInstanceCount: 2 },
    ],
  }, 140));

  assert.match(output, /fe-dev: worked 3 times/);
  assert.match(output, /be-dev: idle/);
  assert.match(output, /qa-dev: 2 instances working/);
  assert.doesNotMatch(output, /fe-dev: idle/);
});

test("mergeWorkflowAgentStatuses preserves worked counts across phase resets", () => {
  assert.deepEqual(
    mergeWorkflowAgentStatuses(
      [
        { name: "leader", status: "done", workCount: 1 },
        { name: "fe-dev", status: "done", workCount: 3 },
        { name: "be-dev", status: "idle" },
        { name: "qa-dev", status: "working", activeInstanceCount: 2 },
      ],
      [
        { name: "leader", status: "working" },
        { name: "fe-dev", status: "idle" },
        { name: "be-dev", status: "idle" },
      ],
    ),
    [
      { name: "leader", status: "working", workCount: 1 },
      { name: "fe-dev", status: "done", workCount: 3, activeInstanceCount: undefined },
      { name: "be-dev", status: "idle" },
      { name: "qa-dev", status: "done", workCount: 1, activeInstanceCount: undefined },
    ],
  );

  assert.deepEqual(
    mergeWorkflowAgentStatuses(
      [{ name: "fe-dev", status: "working", workCount: 3, activeInstanceCount: 1 }],
      [{ name: "fe-dev", status: "done", workCount: 1 }],
    ),
    [{ name: "fe-dev", status: "done", workCount: 4, activeInstanceCount: undefined }],
  );

  assert.deepEqual(
    mergeWorkflowAgentStatuses(
      [
        { name: "fe-dev", status: "done", workCount: 2 },
        { name: "be-dev", status: "working", activeInstanceCount: 1 },
        { name: "qa-dev", status: "idle" },
      ],
      [],
    ),
    [
      { name: "fe-dev", status: "done", workCount: 2, activeInstanceCount: undefined },
      { name: "be-dev", status: "done", workCount: 1, activeInstanceCount: undefined },
    ],
  );
});

test("renderTodoBoardToString shows subagent count only when multiple subagents exist", () => {
  const multipleOutput = stripAnsi(renderTodoBoardToString({
    stage: "生成阶段",
    todos: [],
    artifacts: [],
    narrative: "模型正在工作中",
    runtimeStatus: {
      phase: "generate",
      subagentCount: 3,
    },
  }, 120));
  const singleOutput = stripAnsi(renderTodoBoardToString({
    stage: "生成阶段",
    todos: [],
    artifacts: [],
    narrative: "模型正在工作中",
    runtimeStatus: {
      phase: "generate",
      subagentCount: 1,
    },
  }, 120));

  assert.match(multipleOutput, /phase: generate \| subagents: 3/);
  assert.doesNotMatch(singleOutput, /subagents:/);
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
      input: "{\"file_path\":\".workspace/source-prd.md\",\"offset\":0,\"limit\":1000}",
    }),
    "读取文件：.workspace/source-prd.md（1-1000行）",
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

test("summarizeDeepAgentsAction describes task events when useful and suppresses low-information task completion", () => {
  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_start",
      name: "task",
      input: JSON.stringify({
        subagent_type: "fe-dev",
        description: "实现订单列表页面并接入筛选交互",
      }),
    }),
    "fe-dev：实现订单列表页面并接入筛选交互",
  );

  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_start",
      name: "task",
      input: JSON.stringify({
        subagent_type: "frontend-fixer",
        description: "修复订单页面渲染",
      }),
    }),
    "fe-dev：修复订单页面渲染",
  );

  const runningSummary = summarizeDeepAgentsAction("tools", {
    event: "on_tool_update",
    name: "task",
    input: JSON.stringify({
      subagent_type: "fe-dev",
      description: "实现订单列表页面并接入筛选交互",
    }),
    output: "child progress",
  });

  assert.equal(runningSummary, "fe-dev运行中：实现订单列表页面并接入筛选交互");
  assert.equal(shouldAppendDeepAgentsWorkflowLog("tools", runningSummary), false);

  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_start",
      name: "task",
      input: JSON.stringify({
        subagent_type: "be-dev",
        description: [
          "Implement the backend/API slice for the validated planSpec.",
          "",
          "Owned scope:",
          "- Assigned API route files:",
          "- app/api/orders/route.ts resource=Order methods=GET,POST",
          "- app/api/invoices/route.ts resource=Invoice methods=GET",
          "- app/api/customers/route.ts resource=Customer methods=GET",
          "- Assigned resources:",
          "- Order route=orders usage=direct",
        ].join("\n"),
      }),
    }),
    "be-dev：实现 API app/api/orders/route.ts、app/api/invoices/route.ts 等 3 项",
  );

  const lowInformationSummary = summarizeDeepAgentsAction("tools", {
    event: "on_tool_end",
    name: "task",
    input: "{}",
  });

  assert.equal(lowInformationSummary, "收到工具调用事件。");
  assert.equal(shouldAppendDeepAgentsWorkflowLog("tools", lowInformationSummary), false);
});

test("summarizeDeepAgentsAction marks whole-file reads explicitly", () => {
  assert.equal(
    summarizeDeepAgentsAction("tools", {
      event: "on_tool_start",
      name: "read_file",
      input: "{\"file_path\":\".workspace/plan-system-prompt.md\"}",
    }),
    "读取文件：.workspace/plan-system-prompt.md（全量）",
  );
});

test("summarizeDeepAgentsAction exposes message tool-call intent", () => {
  const writeIntent = summarizeDeepAgentsAction("messages", [
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
  ]);
  const readIntent = summarizeDeepAgentsAction("messages", [
    {
      tool_calls: [
        {
          name: "read_file",
          args: {
            file_path: "app/page.tsx",
            offset: 0,
            limit: 120,
          },
        },
      ],
    },
  ]);

  assert.equal(writeIntent, "准备写入文件：app/page.tsx");
  assert.equal(readIntent, "准备读取文件：app/page.tsx（1-120行）");
  assert.equal(shouldAppendDeepAgentsWorkflowLog("messages", writeIntent), true);
  assert.equal(shouldAppendDeepAgentsWorkflowLog("messages", readIntent), true);

  const taskIntent = summarizeDeepAgentsAction("messages", [
    {
      tool_calls: [
        {
          name: "task",
          args: {
            subagent_type: "fe-dev",
            description: "实现订单页面",
          },
        },
      ],
    },
  ]);
  assert.equal(taskIntent, "模型正在工作中");
  assert.equal(shouldAppendDeepAgentsWorkflowLog("messages", taskIntent), false);
});

test("shouldAppendDeepAgentsWorkflowLog suppresses message text deltas", () => {
  const shortFragment = summarizeDeepAgentsAction("messages", { content: "have" });
  const textFragment = summarizeDeepAgentsAction("messages", { content: "corresponding resource type" });

  assert.equal(shortFragment, "have");
  assert.equal(textFragment, "corresponding resource type");
  assert.equal(shouldAppendDeepAgentsWorkflowLog("messages", shortFragment), false);
  assert.equal(shouldAppendDeepAgentsWorkflowLog("messages", textFragment), false);
  assert.equal(
    shouldAppendDeepAgentsWorkflowLog(
      "tools",
      summarizeDeepAgentsAction("tools", {
        event: "on_tool_start",
        name: "write_file",
        input: "{\"file_path\":\"app/page.tsx\"}",
      }),
    ),
    true,
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

test("extractRuntimeStatusPatch deduplicates OpenAI response usage and LangChain usage metadata", () => {
  const patch = extractRuntimeStatusPatch({
    message: {
      response_metadata: {
        model_name: "gpt-5.4-actual",
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
        },
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

test("extractRuntimeStatusPatch parses OpenAI response usage without usage metadata", () => {
  const patch = extractRuntimeStatusPatch({
    response_metadata: {
      usage: {
        prompt_tokens: 200,
        completion_tokens: 50,
        total_tokens: 250,
        prompt_tokens_details: {
          cached_tokens: 64,
        },
        completion_tokens_details: {
          reasoning_tokens: 16,
        },
      },
    },
  });

  assert.equal(patch.contextWindowUsedTokens, 200);
  assert.deepEqual(patch.usage, {
    inputTokens: 200,
    outputTokens: 50,
    totalTokens: 250,
    reasoningTokens: 16,
    cachedInputTokens: 64,
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
  assert.equal(merged.contextWindowUsedTokens, 100);
  assert.deepEqual(merged.usage, {
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 180,
    reasoningTokens: 8,
    cachedInputTokens: 12,
  });
});

test("extractRuntimeStatusPatch deduplicates repeated usage snapshots", () => {
  const seenUsageSignatures = new Set<string>();
  const repeatedPayload = {
    messages: [
      {
        usage_metadata: {
          input_tokens: 75_000,
          output_tokens: 859,
          total_tokens: 75_859,
          output_token_details: {
            reasoning: 572,
          },
          input_token_details: {
            cache_read: 70_000,
          },
        },
      },
    ],
  };

  const firstPatch = extractRuntimeStatusPatch(repeatedPayload, { seenUsageSignatures });
  const repeatedPatch = extractRuntimeStatusPatch(repeatedPayload, { seenUsageSignatures });
  const merged = mergeRuntimeStatus(
    mergeRuntimeStatus(
      buildRuntimeStatus({
        runtime: {
          sessionId: "runtime-session-dedupe",
          templatePhases: {
            plan: { effort: "high" },
            planRepair: { effort: "high" },
            generate: { effort: "medium" },
            generateRepair: { effort: "low" },
          },
        },
        phase: "generate",
        fallbackModelName: "gpt-5.4",
      }),
      firstPatch,
    ),
    repeatedPatch,
  );

  assert.deepEqual(merged.usage, {
    inputTokens: 75_000,
    outputTokens: 859,
    totalTokens: 75_859,
    reasoningTokens: 572,
    cachedInputTokens: 70_000,
  });
  assert.equal(merged.contextWindowUsedTokens, 75_000);
});

test("buildRuntimeStatus maps effort and attempt to the active phase", () => {
  const runtime: Pick<TextGeneratorRuntime, "sessionId" | "templatePhases" | "planAttempt" | "generateAttempt"> = {
    sessionId: "runtime-session-2",
    planAttempt: 2,
    generateAttempt: 3,
    templatePhases: {
      plan: { effort: "high" },
      planRepair: { effort: "low" },
      generate: { effort: "medium" },
      generateRepair: { effort: "high" },
    },
  };

  assert.equal(buildRuntimeStatus({ runtime, phase: "planRepair" }).effort, "low");
  assert.equal(buildRuntimeStatus({ runtime, phase: "planRepair" }).attempt, 2);
  assert.equal(buildRuntimeStatus({ runtime, phase: "generate" }).effort, "medium");
  assert.equal(buildRuntimeStatus({ runtime, phase: "generate" }).attempt, 3);
  assert.equal(buildRuntimeStatus({ runtime, phase: "generate" }).subagentCount, 9);
  assert.equal(buildRuntimeStatus({ runtime, phase: "planRepair" }).subagentCount, undefined);
  assert.equal(buildRuntimeStatus({ runtime, phase: "complete" }).effort, undefined);
  assert.equal(buildRuntimeStatus({ runtime, phase: "complete" }).attempt, undefined);
});

test("buildRuntimeStatus reports the active role model name", () => {
  const runtime: Pick<TextGeneratorRuntime, "sessionId" | "templatePhases" | "modelRoles"> = {
    sessionId: "runtime-session-3",
    templatePhases: {
      plan: { effort: "high" },
      planRepair: { effort: "low" },
      generate: { effort: "medium" },
      generateRepair: { effort: "high" },
    },
    modelRoles: resolveModelRoleConfigs({
      APP_BUILDER_API_KEY: "global-key",
      APP_BUILDER_MAX_INPUT_TOKENS: "65536",
      APP_BUILDER_PLAN_MODEL: "openai:plan-model",
      APP_BUILDER_GENERATE_MODEL: "openai:generate-model",
      APP_BUILDER_REPAIR_MODEL: "openai:repair-model",
      APP_BUILDER_PLAN_MAX_INPUT_TOKENS: "131072",
    }),
  };

  assert.equal(buildRuntimeStatus({ runtime, phase: "plan" }).modelName, "openai:plan-model");
  assert.equal(buildRuntimeStatus({ runtime, phase: "plan" }).contextWindowTokens, 131072);
  assert.equal(buildRuntimeStatus({ runtime, phase: "generate" }).modelName, "openai:generate-model");
  assert.equal(buildRuntimeStatus({ runtime, phase: "generate" }).contextWindowTokens, 65536);
  assert.equal(buildRuntimeStatus({ runtime, phase: "planRepair" }).modelName, "openai:repair-model");
  assert.equal(buildRuntimeStatus({ runtime, phase: "generate_repair" }).modelName, "openai:repair-model");
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
  const originalApiKey = process.env.APP_BUILDER_API_KEY;
  const originalBaseUrl = process.env.APP_BUILDER_BASE_URL;

  delete process.env.APP_BUILDER_API_KEY;
  delete process.env.APP_BUILDER_BASE_URL;

  try {
    await writeFile(
      path.join(tempRoot, ".env"),
      "APP_BUILDER_API_KEY=from-file\nAPP_BUILDER_BASE_URL=https://proxy.example/v1\n",
      "utf8",
    );

    await loadProjectEnv(tempRoot);

    assert.equal(process.env.APP_BUILDER_API_KEY, "from-file");
    assert.equal(process.env.APP_BUILDER_BASE_URL, "https://proxy.example/v1");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.APP_BUILDER_API_KEY;
    } else {
      process.env.APP_BUILDER_API_KEY = originalApiKey;
    }

    if (originalBaseUrl === undefined) {
      delete process.env.APP_BUILDER_BASE_URL;
    } else {
      process.env.APP_BUILDER_BASE_URL = originalBaseUrl;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("loadProjectEnv does not override existing process env values", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-env-"));
  const originalApiKey = process.env.APP_BUILDER_API_KEY;

  process.env.APP_BUILDER_API_KEY = "already-set";

  try {
    await writeFile(path.join(tempRoot, ".env"), "APP_BUILDER_API_KEY=from-file\n", "utf8");
    await loadProjectEnv(tempRoot);
    assert.equal(process.env.APP_BUILDER_API_KEY, "already-set");
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.APP_BUILDER_API_KEY;
    } else {
      process.env.APP_BUILDER_API_KEY = originalApiKey;
    }

    await rm(tempRoot, { recursive: true, force: true });
  }
});
