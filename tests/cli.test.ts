import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "../src/lib/cli.js";
import { generateApplication } from "../src/lib/generator.js";
import { type PlanSpec } from "../src/lib/plan-spec.js";
import {
  type GeneratedAppValidator,
  type GeneratedProject,
  type NormalizedSpec,
  type PlanResult,
  type TextGenerator,
  type TextGeneratorRuntime,
} from "../src/lib/types.js";

function buildPlanSpec(): PlanSpec {
  return {
    version: 1,
    appName: "Field Ops Planner",
    summary: "面向现场运维团队的工单计划与执行系统。",
    resources: [
      {
        name: "WorkOrder",
        pluralName: "WorkOrders",
        routeSegment: "work-orders",
        description: "现场工单。",
        fields: [
          { name: "title", label: "标题", type: "string", required: true, source: "prd" },
          { name: "status", label: "状态", type: "string", required: true, source: "prd" },
        ],
        relations: [],
      },
    ],
    pages: [
      {
        name: "工单列表",
        route: "/work-orders",
        kind: "list",
        resourceName: "WorkOrder",
        purpose: "查看工单。",
      },
      {
        name: "工单详情",
        route: "/work-orders/[id]",
        kind: "detail",
        resourceName: "WorkOrder",
        purpose: "查看单个工单。",
      },
    ],
    apis: [
      {
        name: "WorkOrderCollection",
        resourceName: "WorkOrder",
        path: "/app/api/work-orders/route.ts",
        methods: ["GET"],
        requestShape: "分页查询。",
        responseShape: "工单列表。",
      },
    ],
    flows: [
      {
        name: "工单查看",
        steps: ["进入列表", "查看详情"],
      },
    ],
    assumptions: ["未定义复杂权限模型，第一版按登录用户统一授权。"],
    acceptanceChecks: [
      {
        id: "resource-work-order",
        description: "必须实现 WorkOrder 资源。",
        type: "resource",
        target: "WorkOrder",
      },
      {
        id: "page-work-order-list",
        description: "必须实现工单列表页。",
        type: "page",
        target: "/work-orders",
      },
      {
        id: "page-work-order-detail",
        description: "必须实现工单详情页。",
        type: "page",
        target: "/work-orders/[id]",
      },
      {
        id: "api-work-order",
        description: "必须实现工单集合接口。",
        type: "api",
        target: "/app/api/work-orders/route.ts",
      },
      {
        id: "flow-work-order",
        description: "必须覆盖工单查看流程。",
        type: "flow",
        target: "工单查看",
      },
    ],
  };
}

class CliTestGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    const planSpec = buildPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");

    return {
      summary: "计划阶段成功。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async generateProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    await mkdir(path.join(runtime.outputDirectory, "app", "api", "work-orders"), { recursive: true });
    await mkdir(path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]"), { recursive: true });
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Report\n\nCLI validate session fixture.\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "api", "work-orders", "route.ts"),
      "export async function GET() { return Response.json([]); }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );

    return {
      summary: "生成阶段成功。",
      filesWritten: [
        "app-builder-report.md",
        "app/api/work-orders/route.ts",
        "app/(admin)/work-orders/page.tsx",
        "app/(admin)/work-orders/[id]/page.tsx",
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<PlanResult> {
    throw new Error("planRepairProject should not be called in CliTestGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    throw new Error("generateRepairProject should not be called in CliTestGenerator");
  }
}

class SuccessfulCliValidator implements GeneratedAppValidator {
  async validate(_outputDirectory: string, runtime: TextGeneratorRuntime) {
    await writeFile(runtime.deepagentsRuntimeValidationLogPath, "cli validate ok\n", "utf8");
    return {
      reasons: [],
      steps: [
        { name: "mv .env.example .env", ok: true, detail: "执行成功。" },
        { name: "pnpm install", ok: true, detail: "执行成功。" },
        { name: "pnpm db:init", ok: true, detail: "执行成功。" },
        { name: "pnpm dev", ok: true, detail: "执行成功。" },
      ],
    };
  }
}

class FailingCliValidator implements GeneratedAppValidator {
  async validate(_outputDirectory: string, runtime: TextGeneratorRuntime) {
    await writeFile(runtime.deepagentsRuntimeValidationLogPath, "cli validate failed\n", "utf8");
    return {
      reasons: ["生成阶段运行验证失败：pnpm dev 未通过。端口冲突。详见 .deepagents/runtime-validation.log。"],
      steps: [
        { name: "mv .env.example .env", ok: true, detail: "执行成功。" },
        { name: "pnpm install", ok: true, detail: "执行成功。" },
        { name: "pnpm db:init", ok: true, detail: "执行成功。" },
        { name: "pnpm dev", ok: false, detail: "端口冲突。" },
      ],
    };
  }
}

class RepairingCliValidator implements GeneratedAppValidator {
  private callCount = 0;

  async validate(outputDirectory: string, runtime: TextGeneratorRuntime) {
    this.callCount += 1;

    if (this.callCount === 1) {
      return await new FailingCliValidator().validate(outputDirectory, runtime);
    }

    return await new SuccessfulCliValidator().validate(outputDirectory, runtime);
  }
}

class CliRepairingGenerator extends CliTestGenerator {
  generateRepairAttempts = 0;

  async generateRepairProject(planSpec: PlanSpec, runtime: TextGeneratorRuntime) {
    this.generateRepairAttempts += 1;
    await mkdir(path.join(runtime.outputDirectory, "app", "api", "work-orders"), { recursive: true });
    await mkdir(path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]"), { recursive: true });
    await writeFile(
      path.join(runtime.outputDirectory, "app-builder-report.md"),
      "# Report\n\nCLI validate repaired fixture.\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "api", "work-orders", "route.ts"),
      "export async function GET() { return Response.json([]); }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );
    await writeFile(
      path.join(runtime.outputDirectory, "app", "(admin)", "work-orders", "[id]", "page.tsx"),
      "export default function Page() { return null; }\n",
      "utf8",
    );

    return {
      summary: "生成修复阶段成功。",
      filesWritten: [
        "app-builder-report.md",
        "app/api/work-orders/route.ts",
        "app/(admin)/work-orders/page.tsx",
        "app/(admin)/work-orders/[id]/page.tsx",
      ],
      implementedResources: planSpec.resources.map((resource) => resource.name),
      implementedPages: planSpec.pages.map((page) => page.route),
      implementedApis: planSpec.apis.map((api) => api.path),
      notes: [],
    };
  }
}

class BrokenPlanSessionGenerator implements TextGenerator {
  async planProject(_spec: NormalizedSpec, runtime: TextGeneratorRuntime) {
    await writeFile(runtime.deepagentsAnalysisPath, "# 不完整分析稿\n", "utf8");

    return {
      summary: "计划阶段输出不完整，等待手动 validate 恢复。",
      artifactsWritten: [],
      planSpecVersion: 1,
      notes: [],
    };
  }

  async planRepairProject(_runtime: TextGeneratorRuntime): Promise<PlanResult> {
    throw new Error("planRepairProject should not be called in BrokenPlanSessionGenerator");
  }

  async generateProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    throw new Error("generateProject should not be called in BrokenPlanSessionGenerator");
  }

  async generateRepairProject(_planSpec: PlanSpec, _runtime: TextGeneratorRuntime): Promise<GeneratedProject> {
    throw new Error("generateRepairProject should not be called in BrokenPlanSessionGenerator");
  }
}

class CliPlanRepairingGenerator extends CliRepairingGenerator {
  planRepairAttempts = 0;

  async planRepairProject(runtime: TextGeneratorRuntime) {
    this.planRepairAttempts += 1;
    const planSpec = buildPlanSpec();
    await writeFile(runtime.deepagentsAnalysisPath, "# 修复后的分析稿\n", "utf8");
    await writeFile(runtime.deepagentsDetailedSpecPath, "# 修复后的详细 Spec\n", "utf8");
    await writeFile(runtime.deepagentsPlanSpecPath, `${JSON.stringify(planSpec, null, 2)}\n`, "utf8");

    return {
      summary: "计划修复阶段成功。",
      artifactsWritten: [
        ".deepagents/prd-analysis.md",
        ".deepagents/generated-spec.md",
        ".deepagents/plan-spec.json",
      ],
      planSpecVersion: 1,
      notes: [],
    };
  }
}

async function getOnlySessionId(tempRoot: string): Promise<string> {
  const entries = await readdir(path.join(tempRoot, ".out"));
  assert.equal(entries.length, 1);
  const sessionId = entries[0];
  assert.ok(sessionId);
  return sessionId;
}

test("runCli validate can validate an existing generate session by session id", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");
    const result = await generateApplication({
      specPath,
      generator: new CliTestGenerator(),
      validator: new SuccessfulCliValidator(),
    });
    const configPath = path.join(result.outputDirectory, ".deepagents/config.json");
    const persistedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      workflow?: {
        phase?: string;
        completedPhases?: string[];
      };
    };
    persistedConfig.workflow = {
      phase: "generate",
      completedPhases: ["plan"],
    };
    await writeFile(configPath, `${JSON.stringify(persistedConfig, null, 2)}\n`, "utf8");

    await runCli(
      ["validate", result.sessionId, "--phase", "generate"],
      {
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), new RegExp(`Session: ${result.sessionId}`));
    assert.match(stdoutLines.join("\n"), /Phase: generate/);
    assert.match(stdoutLines.join("\n"), /Validation steps:/);
    assert.match(stdoutLines.join("\n"), /Workflow: complete/);
    assert.match(stdoutLines.join("\n"), /OK mv \.env\.example \.env: 执行成功。/);
    assert.match(stdoutLines.join("\n"), /OK pnpm install: 执行成功。/);
    assert.match(stdoutLines.join("\n"), /OK pnpm db:init: 执行成功。/);
    assert.match(stdoutLines.join("\n"), /OK pnpm dev: 执行成功。/);
    assert.match(stdoutLines.join("\n"), /Validation passed\./);
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/generation-validation.json"), "utf8"),
      /"valid": true/,
    );
    assert.match(await readFile(configPath, "utf8"), /"phase": "complete"/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli validate resolves a unique short session id prefix", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-short-id-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");
    const result = await generateApplication({
      specPath,
      generator: new CliTestGenerator(),
      validator: new SuccessfulCliValidator(),
    });

    const shortSessionId = result.sessionId.slice(0, 8);
    assert.notEqual(shortSessionId, result.sessionId);

    await runCli(
      ["validate", shortSessionId, "--phase", "generate"],
      {
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), new RegExp(`Session: ${result.sessionId}`));
    assert.match(stdoutLines.join("\n"), /Validation passed\./);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli validate auto-detects the generate phase when the session is already past planning", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-auto-generate-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");
    const result = await generateApplication({
      specPath,
      generator: new CliTestGenerator(),
      validator: new SuccessfulCliValidator(),
    });

    await runCli(
      ["validate", result.sessionId],
      {
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), /Phase: generate/);
    assert.match(stdoutLines.join("\n"), /Workflow: complete/);
    assert.match(stdoutLines.join("\n"), /Validation passed\./);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli accepts -g and -v as generate and validate aliases", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-short-aliases-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");

    await runCli(
      ["-g", specPath],
      {
        generator: new CliTestGenerator(),
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    const sessionLine = stdoutLines.find((line) => line.startsWith("Session: "));
    assert.ok(sessionLine);
    const sessionId = sessionLine.replace("Session: ", "");

    await runCli(
      ["-v", sessionId],
      {
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), /Generated Field Ops Planner at/);
    assert.match(stdoutLines.join("\n"), /Phase: generate/);
    assert.match(stdoutLines.join("\n"), /Validation passed\./);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli prints generate execution parameters before running", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-params-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");

    await runCli(
      [
        "generate",
        specPath,
        "--app-name",
        "Ops Console",
        "--template",
        "mini-app",
        "--force",
        "--stdout",
        "log",
      ],
      {
        generator: new CliTestGenerator(),
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(stderrLines.length, 0);
    assert.deepEqual(stdoutLines.slice(0, 9), [
      "CLI execution parameters:",
      "- command: generate",
      `- specPath: ${specPath}`,
      "- appName: Ops Console",
      "- template: mini-app",
      "- force: true",
      "- model: openai:gpt-4.1-mini",
      "- stdout: log",
      `- cwd: ${tempRoot}`,
    ]);

    const paramsIndex = stdoutLines.indexOf("CLI execution parameters:");
    const sessionIndex = stdoutLines.findIndex((line) => line.startsWith("Session: "));
    assert.ok(paramsIndex >= 0);
    assert.ok(sessionIndex > paramsIndex);
    assert.match(stdoutLines.join("\n"), /Generated Ops Console at/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli accepts --stdout log on generate", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-stdout-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");

    await runCli(
      ["generate", specPath, "--stdout", "log"],
      {
        generator: new CliTestGenerator(),
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), /Session: /);
    assert.match(stdoutLines.join("\n"), /Generated Field Ops Planner at/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli validate rejects an ambiguous short session id prefix", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-ambiguous-id-"));
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const outRoot = path.join(tempRoot, ".out");
  const sharedPrefix = "12345678";
  const sessionA = `${sharedPrefix}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
  const sessionB = `${sharedPrefix}-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;

  await mkdir(path.join(outRoot, sessionA), { recursive: true });
  await mkdir(path.join(outRoot, sessionB), { recursive: true });

  await assert.rejects(
    () =>
      runCli(
        ["validate", sharedPrefix, "--phase", "generate"],
        {
          stdout: { log: (line: string) => stdoutLines.push(line) },
          stderr: { error: (line: string) => stderrLines.push(line) },
          cwd: tempRoot,
        },
      ),
    new RegExp(`Session id "${sharedPrefix}" is ambiguous`),
  );

  assert.match(stdoutLines.join("\n"), /CLI execution parameters:/);
  assert.match(stdoutLines.join("\n"), /- command: validate/);
  assert.match(stdoutLines.join("\n"), new RegExp(`- sessionId: ${sharedPrefix}`));
  assert.match(stdoutLines.join("\n"), /- phase: generate/);
  assert.match(stdoutLines.join("\n"), /- model: openai:gpt-4\.1-mini/);
  assert.equal(stdoutLines.some((line) => line.startsWith("Session: ")), false);
  assert.equal(stderrLines.length, 0);
});

test("runCli validate resumes generate repair instead of exiting on validation failure", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-fail-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const repairingGenerator = new CliRepairingGenerator();
  const repairValidator = new RepairingCliValidator();

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");
    const result = await generateApplication({
      specPath,
      generator: new CliTestGenerator(),
      validator: new SuccessfulCliValidator(),
    });

    await runCli(
      ["validate", result.sessionId, "--phase", "generate"],
      {
        generator: repairingGenerator,
        validator: repairValidator,
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(repairingGenerator.generateRepairAttempts, 1);
    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), /Workflow: complete/);
    assert.match(stdoutLines.join("\n"), /Resumed from: generate_repair/);
    assert.match(stdoutLines.join("\n"), /Validation steps:/);
    assert.match(stdoutLines.join("\n"), /OK pnpm dev: 执行成功。/);
    assert.match(stdoutLines.join("\n"), /Validation recovered and workflow resumed\./);
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/generation-validation.json"), "utf8"),
      /"valid": true/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, "app-builder-report.md"), "utf8"),
      /CLI validate repaired fixture/,
    );
    assert.match(
      await readFile(path.join(result.outputDirectory, ".deepagents/config.json"), "utf8"),
      /"phase": "complete"/,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli validate respects template-configured generate repair retry limits", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-retry-limit-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const repairingGenerator = new CliRepairingGenerator();

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");
    const result = await generateApplication({
      specPath,
      generator: new CliTestGenerator(),
      validator: new SuccessfulCliValidator(),
    });
    const configPath = path.join(result.outputDirectory, ".deepagents/config.json");
    const persistedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      template?: {
        repairRetries?: {
          plan?: number;
          generate?: number;
        };
      };
    };

    persistedConfig.template = {
      ...persistedConfig.template,
      repairRetries: {
        plan: persistedConfig.template?.repairRetries?.plan ?? 2,
        generate: 1,
      },
    };
    await writeFile(configPath, `${JSON.stringify(persistedConfig, null, 2)}\n`, "utf8");

    await assert.rejects(
      () =>
        runCli(
          ["validate", result.sessionId, "--phase", "generate"],
          {
            generator: repairingGenerator,
            validator: new FailingCliValidator(),
            stdout: { log: (line: string) => stdoutLines.push(line) },
            stderr: { error: (line: string) => stderrLines.push(line) },
            cwd: tempRoot,
          },
        ),
      /Generation validation failed/,
    );

    assert.equal(repairingGenerator.generateRepairAttempts, 1);
    assert.equal(stderrLines.length, 0);
    assert.doesNotMatch(await readFile(configPath, "utf8"), /"phase": "complete"/);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli validate resumes plan repair and continues the main workflow", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-plan-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const repairingGenerator = new CliPlanRepairingGenerator();

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");

    await assert.rejects(
      () =>
        generateApplication({
          specPath,
          generator: new BrokenPlanSessionGenerator(),
        }),
      /planRepairProject should not be called/,
    );

    const sessionId = await getOnlySessionId(tempRoot);
    const outputDirectory = path.join(tempRoot, ".out", sessionId);

    await runCli(
      ["validate", sessionId, "--phase", "plan"],
      {
        generator: repairingGenerator,
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(repairingGenerator.planRepairAttempts, 1);
    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), /Workflow: complete/);
    assert.match(stdoutLines.join("\n"), /Resumed from: plan_repair/);
    assert.match(stdoutLines.join("\n"), /Validation recovered and workflow resumed\./);
    assert.match(
      await readFile(path.join(outputDirectory, ".deepagents/plan-validation.json"), "utf8"),
      /"valid": true/,
    );
    assert.match(
      await readFile(path.join(outputDirectory, ".deepagents/generation-validation.json"), "utf8"),
      /"valid": true/,
    );
    assert.match(
      await readFile(path.join(outputDirectory, "app-builder-report.md"), "utf8"),
      /CLI validate session fixture/,
    );
    assert.match(
      await readFile(path.join(outputDirectory, ".deepagents/config.json"), "utf8"),
      /"phase": "complete"/,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runCli validate auto-detects the plan phase for a broken planning session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-cli-validate-auto-plan-"));
  const previousCwd = process.cwd();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const repairingGenerator = new CliPlanRepairingGenerator();

  process.chdir(tempRoot);

  try {
    const specPath = path.resolve(previousCwd, "tests/fixtures/sample-spec.md");

    await assert.rejects(
      () =>
        generateApplication({
          specPath,
          generator: new BrokenPlanSessionGenerator(),
        }),
      /planRepairProject should not be called/,
    );

    const sessionId = await getOnlySessionId(tempRoot);

    await runCli(
      ["validate", sessionId],
      {
        generator: repairingGenerator,
        validator: new SuccessfulCliValidator(),
        stdout: { log: (line: string) => stdoutLines.push(line) },
        stderr: { error: (line: string) => stderrLines.push(line) },
        cwd: tempRoot,
      },
    );

    assert.equal(repairingGenerator.planRepairAttempts, 1);
    assert.equal(stderrLines.length, 0);
    assert.match(stdoutLines.join("\n"), /Phase: plan/);
    assert.match(stdoutLines.join("\n"), /Resumed from: plan_repair/);
    assert.match(stdoutLines.join("\n"), /Validation recovered and workflow resumed\./);
  } finally {
    process.chdir(previousCwd);
    await rm(tempRoot, { recursive: true, force: true });
  }
});
