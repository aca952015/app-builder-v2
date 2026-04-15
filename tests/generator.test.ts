import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateApplication } from "../src/lib/generator.js";
import { copyStarterScaffold, loadTemplatePack } from "../src/lib/template-pack.js";
import { NormalizedSpec, TextGenerator, TextGeneratorRuntime } from "../src/lib/types.js";

class StubTextGenerator implements TextGenerator {
  async generateProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    await mkdir(path.join(runtime.outputDirectory, "generated"), { recursive: true });
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Stub Report\n\nGenerated during test.\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "generated", "marker.txt"),
      "stub-generator-ran\n",
      "utf8",
    );
    await writeFile(
      runtime.deepagentsAnalysisPath,
      [
        "# Stub 需求分析报告",
        "",
        "## 1. 产品目标",
        "",
        "验证宿主不会再用硬编码 fallback 重写分析稿。",
        "",
        "## 2. 主要对象",
        "",
        "- WorkOrder",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      [
        "# Stub 实施详细设计规格书",
        "",
        "## 1. 产品概述",
        "",
        "这是 generator 自己写入的详细 spec。",
        "",
        "## 3. 数据模型 (Prisma Schema)",
        "",
        "### WorkOrder",
        "",
        "- title",
        "- status",
        "",
        "## 5. 页面清单与功能详情",
        "",
        "- 工单列表 (/work-orders)",
        "",
      ].join("\n"),
      "utf8",
    );

    return {
      summary: "Stub generator updated the starter scaffold.",
      filesWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        "app-builder-report.md",
        "generated/marker.txt",
      ],
      notes: [],
    };
  }
}

class RetryingStubTextGenerator implements TextGenerator {
  attempts = 0;

  async generateProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    this.attempts += 1;

    if (this.attempts === 1) {
      return {
        summary: "过早返回结构化结果。",
        filesWritten: [],
        notes: [],
      };
    }

    await writeFile(
      runtime.deepagentsAnalysisPath,
      "# 重试后的分析稿\n\n已在同一工作目录中补齐 artifacts.analysis。\n",
      "utf8",
    );
    await writeFile(
      runtime.deepagentsDetailedSpecPath,
      "# 重试后的详细 Spec\n\n已在同一工作目录中补齐 artifacts.generatedSpec。\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Retry Report\n\nArtifacts repaired during retry.\n",
      "utf8",
    );

    return {
      summary: "重试后已补齐必需 artifacts。",
      filesWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        "app-builder-report.md",
      ],
      notes: [],
    };
  }
}

test("generateApplication stages starter scaffold and artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator: new StubTextGenerator(),
    });

    assert.ok(result.files.includes("package.json"));
    assert.ok(result.files.includes("prisma/schema.prisma"));
    assert.ok(result.files.includes("app-builder-report.md"));
    assert.ok(result.files.includes("generated/marker.txt"));

    const packageJson = await readFile(path.join(result.outputDirectory, "package.json"), "utf8");
    const gitHead = await readFile(path.join(result.outputDirectory, ".git/HEAD"), "utf8");
    const npmrc = await readFile(path.join(result.outputDirectory, ".npmrc"), "utf8");
    const gitignore = await readFile(path.join(result.outputDirectory, ".gitignore"), "utf8");
    const envExample = await readFile(path.join(result.outputDirectory, ".env.example"), "utf8");
    const schema = await readFile(path.join(result.outputDirectory, "prisma/schema.prisma"), "utf8");
    const seed = await readFile(path.join(result.outputDirectory, "prisma/seed.ts"), "utf8");
    const sidebarMenu = JSON.parse(
      await readFile(path.join(result.outputDirectory, "config/sidebar-menu.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    const templateLock = await readFile(path.join(result.outputDirectory, "template-lock.json"), "utf8");
    const stagedTemplateManifest = await readFile(
      path.join(result.outputDirectory, ".deepagents/template.json"),
      "utf8",
    );
    const promptSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/system-prompt.md"),
      "utf8",
    );
    const sourcePrdSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/source-prd.md"),
      "utf8",
    );
    const analysisSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/prd-analysis.md"),
      "utf8",
    );
    const generatedSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/generated-spec.md"),
      "utf8",
    );
    const deepagentsConfig = await readFile(
      path.join(result.outputDirectory, ".deepagents/config.json"),
      "utf8",
    );
    const stagedReference = await readFile(
      path.join(result.outputDirectory, ".deepagents/references/generated-app-architecture.md"),
      "utf8",
    );

    assert.match(packageJson, /"next"/);
    assert.match(gitHead, /ref: refs\/heads\/main/);
    assert.match(packageJson, /"db:init"/);
    assert.match(packageJson, /"@tailwindcss\/postcss"/);
    assert.match(npmrc, /workspaces=false/);
    assert.match(gitignore, /node_modules/);
    assert.match(envExample, /file:\.\/dev\.db/);
    assert.match(schema, /provider = "sqlite"/);
    assert.match(seed, /demo@example\.com/);
    assert.equal(sidebarMenu.length > 0, true);
    assert.equal(sidebarMenu.some((item) => item.label === "Workspace"), true);
    assert.match(templateLock, /"id": "full-stack"/);
    assert.match(stagedTemplateManifest, /"projectRenderer": "full-stack"/);
    assert.match(promptSnapshot, /write_todos/);
    assert.match(promptSnapshot, /starter/);
    assert.match(promptSnapshot, /TailAdmin/);
    assert.match(promptSnapshot, /config\/sidebar-menu\.json/);
    assert.match(sourcePrdSnapshot, /# Field Ops Planner/);
    assert.match(analysisSnapshot, /# Stub 需求分析报告/);
    assert.match(analysisSnapshot, /## 1\. 产品目标/);
    assert.match(generatedSpecSnapshot, /# Stub 实施详细设计规格书/);
    assert.match(generatedSpecSnapshot, /## 3\. 数据模型 \(Prisma Schema\)/);
    assert.match(generatedSpecSnapshot, /WorkOrder/);
    assert.match(generatedSpecSnapshot, /## 5\. 页面清单与功能详情/);
    assert.doesNotMatch(deepagentsConfig, /\/Users\/aca\/dev\/app-builder-v2/);
    assert.doesNotMatch(stagedReference, /\/Users\/aca\/dev\/app-builder-v2/);
    assert.equal(result.files.some((file) => file.startsWith(".git/")), false);
    await assert.rejects(() => access(path.join(result.outputDirectory, ".deepagents/normalized-spec.json")));
    await assert.rejects(() => access(path.join(result.outputDirectory, ".deepagents/prompts")));
    await assert.rejects(() => access(path.join(result.outputDirectory, ".deepagents/starter")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication retries when the agent returns before required artifacts are written", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-retry-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const generator = new RetryingStubTextGenerator();

  try {
    const result = await generateApplication({
      specPath,
      outputDirectory: path.join(tempRoot, "output"),
      generator,
    });

    assert.equal(generator.attempts, 2);
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/prd-analysis.md"), "utf8"),
      /重试后的分析稿/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/generated-spec.md"), "utf8"),
      /重试后的详细 Spec/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"),
      /Artifacts repaired during retry/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/error.log"), "utf8"),
      /artifacts\.analysis|artifacts\.generatedSpec|filesWritten/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("full-stack template starter copies scaffold files into the output root", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-starter-"));

  try {
    const template = await loadTemplatePack("full-stack");
    const copied = await copyStarterScaffold(template, tempRoot);

    assert.ok(copied.includes("package.json"));
    assert.ok(copied.includes("app/layout.tsx"));
    assert.ok(copied.includes("lib/session.ts"));
    assert.ok(copied.includes("prisma/schema.prisma"));
    assert.ok(copied.includes("prisma/seed.ts"));
    assert.ok(copied.includes("config/sidebar-menu.json"));

    const starterPackage = await readFile(path.join(tempRoot, "package.json"), "utf8");
    const starterLayout = await readFile(path.join(tempRoot, "app/layout.tsx"), "utf8");
    const starterEnv = await readFile(path.join(tempRoot, ".env.example"), "utf8");
    const starterSchema = await readFile(path.join(tempRoot, "prisma/schema.prisma"), "utf8");
    const starterMenu = JSON.parse(
      await readFile(path.join(tempRoot, "config/sidebar-menu.json"), "utf8"),
    ) as Array<Record<string, unknown>>;

    assert.match(starterPackage, /"next"/);
    assert.match(starterPackage, /"db:init"/);
    assert.match(starterPackage, /"@tailwindcss\/postcss"/);
    assert.match(starterLayout, /Generated App/);
    assert.match(starterEnv, /file:\.\/dev\.db/);
    assert.match(starterSchema, /provider = "sqlite"/);
    assert.equal(Array.isArray(starterMenu), true);
    assert.equal(starterMenu.some((item) => item.label === "Dashboard"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("generateApplication creates a session workspace under .out by default", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-session-"));
  const specPath = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
  const previousCwd = process.cwd();

  process.chdir(tempRoot);

  try {
    const result = await generateApplication({
      specPath,
      generator: new StubTextGenerator(),
    });

    assert.match(result.outputDirectory, /[\\/]\.out[\\/][^\\/]+$/);
    assert.equal(path.basename(result.outputDirectory), result.sessionId);

    const deepagentsConfig = await readFile(
      path.join(result.outputDirectory, ".deepagents/config.json"),
      "utf8",
    );
    const outputEntries = await readdir(result.outputDirectory);

    assert.match(deepagentsConfig, new RegExp(result.sessionId));
    assert.equal(outputEntries.includes(".git"), true);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("starter sidebar source explicitly guards against third-level navigation", async () => {
  const sidebarSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/starter/config/sidebar-menu.ts"),
    "utf8",
  );

  assert.match(sidebarSource, /supports at most two menu levels/);
  assert.match(sidebarSource, /import sidebarMenu from "\.\/sidebar-menu\.json"/);
});

test("system prompt requires retries to continue the unfinished stage in place", async () => {
  const promptSource = await readFile(
    path.resolve(process.cwd(), "templates/full-stack/prompts/system-prompt.md"),
    "utf8",
  );

  assert.match(promptSource, /generationPolicy\.retryStage/);
  assert.match(promptSource, /继续完成该阶段未完成的工作/);
  assert.match(promptSource, /不要删除、覆盖或重建整个会话目录/);
});
