import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SCRIPT_PATH = path.resolve("scripts/analyze-metrics.mjs");

function runAnalyzer(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function metric(input) {
  return {
    version: 1,
    sessionId: input.sessionId,
    name: input.name,
    phase: input.phase,
    status: input.status ?? "success",
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: input.durationMs,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };
}

async function writeSession(root, sessionId, records, extras = {}) {
  const deepagentsDir = path.join(root, ".out", sessionId, ".deepagents");
  await mkdir(deepagentsDir, { recursive: true });
  await writeFile(
    path.join(deepagentsDir, "metrics.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  if (extras.generationValidation) {
    await writeFile(
      path.join(deepagentsDir, "generation-validation.json"),
      JSON.stringify(extras.generationValidation, null, 2),
      "utf8",
    );
  }
  if (extras.runtimeValidationLog) {
    await writeFile(path.join(deepagentsDir, "runtime-validation.log"), extras.runtimeValidationLog, "utf8");
  }
  if (extras.errorLog) {
    await writeFile(path.join(deepagentsDir, "error.log"), extras.errorLog, "utf8");
  }
}

test("single session markdown includes phase breakdown, slow steps, and validation summaries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-metrics-single-"));
  const sessionId = "single-session-001";

  try {
    await writeSession(
      tempRoot,
      sessionId,
      [
        metric({
          sessionId,
          name: "plan.build",
          phase: "plan",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:10.000Z",
          durationMs: 10_000,
          attempt: 1,
        }),
        metric({
          sessionId,
          name: "generate.project",
          phase: "generate",
          startedAt: "2026-01-01T00:00:10.000Z",
          completedAt: "2026-01-01T00:00:40.000Z",
          durationMs: 30_000,
          attempt: 1,
        }),
        metric({
          sessionId,
          name: "runtime_validation.step",
          phase: "generate",
          status: "failure",
          startedAt: "2026-01-01T00:00:40.000Z",
          completedAt: "2026-01-01T00:00:52.000Z",
          durationMs: 12_000,
          attempt: 1,
          error: "pnpm typecheck failed with TS2687",
        }),
        metric({
          sessionId,
          name: "generate_repair.apply",
          phase: "generate_repair",
          startedAt: "2026-01-01T00:00:52.000Z",
          completedAt: "2026-01-01T00:01:04.000Z",
          durationMs: 12_000,
          attempt: 2,
        }),
      ],
      {
        generationValidation: {
          valid: false,
          reasons: ["pnpm typecheck failed"],
          steps: [{ name: "pnpm typecheck", ok: false, detail: "TS2687" }],
        },
        runtimeValidationLog: "pnpm typecheck failed\nsrc/app/page.tsx(1,1): error TS2687\n",
        errorLog: "Retry attempt 2 triggered for generate repair because: pnpm typecheck failed\n",
      },
    );

    const result = await runAnalyzer(["single", "--top", "2"], tempRoot);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /## Phase Breakdown/);
    assert.match(result.stdout, /generate_repair/);
    assert.match(result.stdout, /## Slow Steps/);
    assert.match(result.stdout, /generate\.project/);
    assert.match(result.stdout, /pnpm typecheck failed/);
    assert.match(result.stdout, /`typecheck`: [1-9]/);
    assert.match(result.stdout, /Total wall-clock: 1m 4s/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("--all markdown ranks sessions by total wall-clock and aggregates phases", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-metrics-all-"));

  try {
    await writeSession(tempRoot, "session-fast", [
      metric({
        sessionId: "session-fast",
        name: "generate.fast",
        phase: "generate",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:30.000Z",
        durationMs: 30_000,
      }),
    ]);
    await writeSession(tempRoot, "session-slow", [
      metric({
        sessionId: "session-slow",
        name: "generate.slow",
        phase: "generate",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:30.000Z",
        durationMs: 90_000,
      }),
    ]);

    const result = await runAnalyzer(["--all"], tempRoot);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /## Slowest Sessions/);
    assert.ok(result.stdout.indexOf("session-slow") < result.stdout.indexOf("session-fast"));
    assert.match(result.stdout, /## Phase Aggregates/);
    assert.match(result.stdout, /generate/);
    assert.match(result.stdout, /1m 30s/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("malformed JSONL lines are skipped and reported in JSON output", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-metrics-malformed-"));
  const sessionId = "malformed-session";
  const deepagentsDir = path.join(tempRoot, ".out", sessionId, ".deepagents");

  try {
    await mkdir(deepagentsDir, { recursive: true });
    await writeFile(
      path.join(deepagentsDir, "metrics.jsonl"),
      [
        JSON.stringify(metric({
          sessionId,
          name: "plan.ok",
          phase: "plan",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:05.000Z",
          durationMs: 5000,
        })),
        "{not-json",
        JSON.stringify({ sessionId, name: "missing fields" }),
      ].join("\n"),
      "utf8",
    );

    const result = await runAnalyzer([sessionId, "--json"], tempRoot);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.code, 0);
    assert.equal(parsed.session.metrics.recordCount, 1);
    assert.equal(parsed.session.metrics.skippedLineCount, 2);
    assert.match(parsed.session.metrics.skippedLines[0].reason, /malformed JSON/);
    assert.match(parsed.session.metrics.skippedLines[1].reason, /missing required field/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("repair and validation failures are classified by failure class", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-metrics-classify-"));
  const sessionId = "classification-session";

  try {
    await writeSession(
      tempRoot,
      sessionId,
      [
        metric({
          sessionId,
          name: "plan.validate_artifacts",
          phase: "plan",
          status: "failure",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:05.000Z",
          durationMs: 5000,
          error: "planSpec validation failed",
        }),
        metric({
          sessionId,
          name: "runtime_validation.step",
          phase: "generate_repair",
          status: "failure",
          startedAt: "2026-01-01T00:00:05.000Z",
          completedAt: "2026-01-01T00:00:15.000Z",
          durationMs: 10_000,
          attempt: 2,
          error: "pnpm db:init failed: Prisma schema error",
        }),
        metric({
          sessionId,
          name: "plan.structured_response",
          phase: "plan_repair",
          status: "failure",
          startedAt: "2026-01-01T00:00:15.000Z",
          completedAt: "2026-01-01T00:00:20.000Z",
          durationMs: 5000,
          attempt: 2,
          error: "structured response missing",
        }),
      ],
      {
        runtimeValidationLog: "pnpm db:init failed: Prisma schema error\n",
        errorLog: "structured response missing\n",
      },
    );

    const result = await runAnalyzer([sessionId, "--json"], tempRoot);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.code, 0);
    assert.ok(parsed.session.failureClasses.planSpec >= 1);
    assert.ok(parsed.session.failureClasses["db:init"] >= 1);
    assert.ok(parsed.session.failureClasses["structured response"] >= 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("session prefix errors are clear for no match and ambiguous match", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "app-builder-metrics-prefix-"));

  try {
    await mkdir(path.join(tempRoot, ".out", "abc-one", ".deepagents"), { recursive: true });
    await mkdir(path.join(tempRoot, ".out", "abc-two", ".deepagents"), { recursive: true });

    const missing = await runAnalyzer(["missing"], tempRoot);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /No session directory found starting with "missing"/);

    const ambiguous = await runAnalyzer(["abc"], tempRoot);
    assert.notEqual(ambiguous.code, 0);
    assert.match(ambiguous.stderr, /Ambiguous prefix "abc" matches multiple sessions/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
