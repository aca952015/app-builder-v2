import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

    return {
      summary: "Stub generator updated the starter scaffold.",
      filesWritten: ["app-builder-report.md", "generated/marker.txt"],
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
    const npmrc = await readFile(path.join(result.outputDirectory, ".npmrc"), "utf8");
    const gitignore = await readFile(path.join(result.outputDirectory, ".gitignore"), "utf8");
    const envExample = await readFile(path.join(result.outputDirectory, ".env.example"), "utf8");
    const schema = await readFile(path.join(result.outputDirectory, "prisma/schema.prisma"), "utf8");
    const seed = await readFile(path.join(result.outputDirectory, "prisma/seed.ts"), "utf8");
    const templateLock = await readFile(path.join(result.outputDirectory, "template-lock.json"), "utf8");
    const stagedTemplateManifest = await readFile(
      path.join(result.outputDirectory, ".deepagents/template.json"),
      "utf8",
    );
    const stagedSystemPrompt = await readFile(
      path.join(result.outputDirectory, ".deepagents/prompts/system-prompt.md"),
      "utf8",
    );
    const sourcePrdSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/source-prd.md"),
      "utf8",
    );
    const normalizedSpecSnapshot = await readFile(
      path.join(result.outputDirectory, ".deepagents/normalized-spec.json"),
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
    assert.match(packageJson, /"db:init"/);
    assert.match(npmrc, /workspaces=false/);
    assert.match(gitignore, /node_modules/);
    assert.match(envExample, /file:\.\/dev\.db/);
    assert.match(schema, /provider = "sqlite"/);
    assert.match(seed, /demo@example\.com/);
    assert.match(templateLock, /"id": "full-stack"/);
    assert.match(stagedTemplateManifest, /"projectRenderer": "full-stack"/);
    assert.match(stagedSystemPrompt, /write_todos/);
    assert.match(stagedSystemPrompt, /starter/);
    assert.match(sourcePrdSnapshot, /# Field Ops Planner/);
    assert.match(normalizedSpecSnapshot, /"appName": "Field Ops Planner"/);
    assert.match(analysisSnapshot, /PRD 分析稿|产品目标/);
    assert.doesNotMatch(analysisSnapshot, /deepagents 将在运行过程中更新这份分析稿/);
    assert.match(generatedSpecSnapshot, /生成用 Spec|产品概述/);
    assert.doesNotMatch(generatedSpecSnapshot, /deepagents 将在运行过程中更新这份详细 spec/);
    assert.match(generatedSpecSnapshot, /## 产品概述/);
    assert.match(generatedSpecSnapshot, /## 数据模型/);
    assert.doesNotMatch(deepagentsConfig, /\/Users\/aca\/dev\/app-builder-v2/);
    assert.doesNotMatch(stagedReference, /\/Users\/aca\/dev\/app-builder-v2/);
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

    const starterPackage = await readFile(path.join(tempRoot, "package.json"), "utf8");
    const starterLayout = await readFile(path.join(tempRoot, "app/layout.tsx"), "utf8");
    const starterEnv = await readFile(path.join(tempRoot, ".env.example"), "utf8");
    const starterSchema = await readFile(path.join(tempRoot, "prisma/schema.prisma"), "utf8");

    assert.match(starterPackage, /"next"/);
    assert.match(starterPackage, /"db:init"/);
    assert.match(starterLayout, /Generated App/);
    assert.match(starterEnv, /file:\.\/dev\.db/);
    assert.match(starterSchema, /provider = "sqlite"/);
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

    assert.match(deepagentsConfig, new RegExp(result.sessionId));
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
