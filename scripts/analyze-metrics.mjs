#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TOP_N = 10;
const FAILURE_CLASSES = ["planSpec", "typecheck", "runtime", "db:init", "smoke", "structured response", "unknown"];
const STATUS_VALUES = new Set(["success", "failure"]);

function usage() {
  return [
    "Usage:",
    "  node scripts/analyze-metrics.mjs <session-id-prefix> [--json] [--top N]",
    "  node scripts/analyze-metrics.mjs --all [--json] [--top N]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    all: false,
    json: false,
    help: false,
    topN: DEFAULT_TOP_N,
    sessionPrefix: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--top") {
      const rawTop = argv[index + 1];
      if (rawTop === undefined) {
        throw new Error("Missing value for --top.");
      }
      options.topN = parseTopN(rawTop);
      index += 1;
      continue;
    }
    if (arg.startsWith("--top=")) {
      options.topN = parseTopN(arg.slice("--top=".length));
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.sessionPrefix !== null) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
    options.sessionPrefix = arg;
  }

  if (options.all && options.sessionPrefix !== null) {
    throw new Error("Use either --all or a session prefix, not both.");
  }
  if (!options.help && !options.all && options.sessionPrefix === null) {
    throw new Error(usage());
  }

  return options;
}

function parseTopN(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --top value: ${value}`);
  }
  return parsed;
}

function resolveOutDir(cwd) {
  return path.resolve(cwd, ".out");
}

function relativeFromCwd(cwd, filePath) {
  const relativePath = path.relative(cwd, filePath);
  return relativePath === "" ? "." : relativePath;
}

function findSessionDir(outDir, prefix) {
  if (!existsSync(outDir)) {
    throw new Error(`.out/ directory not found at ${outDir}`);
  }

  const candidates = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(outDir, entry.name));

  if (candidates.length === 0) {
    throw new Error(`No session directory found starting with "${prefix}"`);
  }
  if (candidates.length > 1) {
    throw new Error(
      `Ambiguous prefix "${prefix}" matches multiple sessions:\n  ${candidates.join("\n  ")}`,
    );
  }

  return candidates[0];
}

function listSessionDirs(outDir) {
  if (!existsSync(outDir)) {
    throw new Error(`.out/ directory not found at ${outDir}`);
  }

  return readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(outDir, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
}

function readMetricsJsonl(filePath) {
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      records: [],
      skipped: [],
    };
  }

  const raw = readFileSync(filePath, "utf8");
  if (raw.trim() === "") {
    return {
      path: filePath,
      exists: true,
      records: [],
      skipped: [],
    };
  }

  const records = [];
  const skipped = [];
  const lines = raw.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      skipped.push({
        line: lineNumber,
        reason: `malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const normalized = normalizeMetricRecord(parsed, lineNumber);
    if ("error" in normalized) {
      skipped.push({
        line: lineNumber,
        reason: normalized.error,
      });
      return;
    }

    records.push(normalized.record);
  });

  return {
    path: filePath,
    exists: true,
    records,
    skipped,
  };
}

function normalizeMetricRecord(value, lineNumber) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: "record is not an object" };
  }

  const required = ["sessionId", "name", "phase", "status", "startedAt", "completedAt", "durationMs"];
  const missing = required.filter((key) => value[key] === undefined || value[key] === null || value[key] === "");
  if (missing.length > 0) {
    return { error: `missing required field(s): ${missing.join(", ")}` };
  }

  const name = String(value.name);
  const phase = String(value.phase);
  const status = String(value.status);
  if (!STATUS_VALUES.has(status)) {
    return { error: `invalid status: ${status}` };
  }

  const startedAt = String(value.startedAt);
  const completedAt = String(value.completedAt);
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) {
    return { error: "invalid startedAt or completedAt timestamp" };
  }

  const durationMs = Number(value.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return { error: `invalid durationMs: ${value.durationMs}` };
  }

  const attempt = value.attempt === undefined ? undefined : Number(value.attempt);
  if (attempt !== undefined && (!Number.isFinite(attempt) || attempt <= 0)) {
    return { error: `invalid attempt: ${value.attempt}` };
  }

  return {
    record: {
      lineNumber,
      version: value.version,
      sessionId: String(value.sessionId),
      name,
      phase,
      status,
      startedAt,
      completedAt,
      startedMs,
      completedMs,
      durationMs,
      ...(attempt !== undefined ? { attempt: Math.trunc(attempt) } : {}),
      ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
      ...(value.error !== undefined ? { error: summarizeValue(value.error, 240) } : {}),
    },
  };
}

function buildTimeline(records) {
  if (records.length === 0) {
    return {
      firstEventAt: null,
      lastEventAt: null,
      totalWallClockMs: 0,
      totalDurationMs: 0,
      eventCount: 0,
      failureCount: 0,
      maxAttempt: 0,
    };
  }

  const firstStart = Math.min(...records.map((record) => record.startedMs));
  const lastEnd = Math.max(...records.map((record) => record.completedMs));
  return {
    firstEventAt: new Date(firstStart).toISOString(),
    lastEventAt: new Date(lastEnd).toISOString(),
    totalWallClockMs: Math.max(0, lastEnd - firstStart),
    totalDurationMs: sum(records, (record) => record.durationMs),
    eventCount: records.length,
    failureCount: records.filter((record) => record.status === "failure").length,
    maxAttempt: Math.max(...records.map((record) => record.attempt ?? 1)),
  };
}

function buildPhaseBreakdown(records) {
  const byPhase = new Map();
  for (const record of records) {
    const events = byPhase.get(record.phase) ?? [];
    events.push(record);
    byPhase.set(record.phase, events);
  }

  return Array.from(byPhase.entries())
    .map(([phase, events]) => {
      const firstStart = Math.min(...events.map((event) => event.startedMs));
      const lastEnd = Math.max(...events.map((event) => event.completedMs));
      return {
        phase,
        eventCount: events.length,
        wallClockMs: Math.max(0, lastEnd - firstStart),
        totalDurationMs: sum(events, (event) => event.durationMs),
        failureCount: events.filter((event) => event.status === "failure").length,
        maxAttempt: Math.max(...events.map((event) => event.attempt ?? 1)),
        firstStartAt: new Date(firstStart).toISOString(),
        lastEndAt: new Date(lastEnd).toISOString(),
      };
    })
    .sort((left, right) => Date.parse(left.firstStartAt) - Date.parse(right.firstStartAt));
}

function buildSlowSteps(records, topN) {
  return records
    .slice()
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, topN)
    .map((record, index) => ({
      rank: index + 1,
      phase: record.phase,
      name: record.name,
      attempt: record.attempt ?? 1,
      status: record.status,
      durationMs: record.durationMs,
      error: record.error ?? null,
    }));
}

function isRepairOrValidationRecord(record) {
  const haystack = `${record.phase} ${record.name}`.toLowerCase();
  return (
    haystack.includes("repair") ||
    haystack.includes("validation") ||
    record.status === "failure" ||
    (record.attempt ?? 1) > 1
  );
}

function buildRepairValidationEvents(records, topN) {
  return records
    .filter(isRepairOrValidationRecord)
    .sort((left, right) => left.startedMs - right.startedMs)
    .slice(0, Math.max(topN, DEFAULT_TOP_N))
    .map((record) => ({
      phase: record.phase,
      name: record.name,
      attempt: record.attempt ?? 1,
      status: record.status,
      durationMs: record.durationMs,
      error: record.error ?? null,
      startedAt: record.startedAt,
    }));
}

function readGenerationValidation(filePath) {
  if (!existsSync(filePath)) {
    return { exists: false };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((step) => ({
        name: summarizeValue(step?.name ?? "(unnamed step)", 120),
        ok: typeof step?.ok === "boolean" ? step.ok : null,
        detail: step?.detail === undefined ? null : summarizeValue(step.detail, 240),
      }))
      : [];
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons.map((reason) => summarizeValue(reason, 240))
      : [];
    const valid = typeof parsed.valid === "boolean" ? parsed.valid : null;
    return {
      exists: true,
      status: valid === true ? "passed" : valid === false ? "failed" : "unknown",
      valid,
      reasons,
      steps,
      failedSteps: steps.filter((step) => step.ok === false),
    };
  } catch (error) {
    return {
      exists: true,
      status: "unreadable",
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function readLogSummary(filePath) {
  if (!existsSync(filePath)) {
    return { exists: false };
  }

  const contents = readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const signalLines = lines.filter((line) => hasFailureSignal(line));
  const summaryLines = (signalLines.length > 0 ? signalLines : lines)
    .slice(-6)
    .map((line) => summarizeValue(line, 240));

  return {
    exists: true,
    bytes: Buffer.byteLength(contents, "utf8"),
    lineCount: lines.length,
    failureSignalLineCount: signalLines.length,
    summaryLines,
    repairReasons: extractRepairReasons(contents),
  };
}

function extractRepairReasons(contents) {
  const reasons = [];
  const retryRegex = /Retry attempt\s+(\d+)\s+triggered.*?because:([\s\S]*?)(?=\n\[|\nRetry attempt|$)/g;
  let retryMatch;
  while ((retryMatch = retryRegex.exec(contents)) !== null) {
    reasons.push({
      attempt: Number.parseInt(retryMatch[1], 10),
      reason: summarizeValue(retryMatch[2].replace(/\s+/g, " ").trim(), 300),
    });
  }

  const structuredResponseRegex = /[^\n]*(?:structured response|\u7ed3\u6784\u5316\u54cd\u5e94)[^\n]*/gi;
  let structuredMatch;
  while ((structuredMatch = structuredResponseRegex.exec(contents)) !== null) {
    const reason = structuredMatch[0].trim();
    if (reason) {
      reasons.push({
        attempt: null,
        reason: summarizeValue(reason, 300),
      });
    }
  }

  return reasons;
}

function readArtifacts(sessionDir) {
  const deepagentsDir = path.join(sessionDir, ".deepagents");
  return {
    generationValidation: readGenerationValidation(path.join(deepagentsDir, "generation-validation.json")),
    runtimeValidationLog: readLogSummary(path.join(deepagentsDir, "runtime-validation.log")),
    errorLog: readLogSummary(path.join(deepagentsDir, "error.log")),
  };
}

function analyzeSessionDir(sessionDir, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const topN = options.topN ?? DEFAULT_TOP_N;
  const sessionId = path.basename(sessionDir);
  const metricsPath = path.join(sessionDir, ".deepagents", "metrics.jsonl");
  const metrics = readMetricsJsonl(metricsPath);
  const phaseBreakdown = buildPhaseBreakdown(metrics.records);
  const artifacts = readArtifacts(sessionDir);
  const failureClasses = classifySessionFailures(metrics.records, artifacts);

  const session = {
    sessionId,
    sessionDir,
    relativeSessionDir: relativeFromCwd(cwd, sessionDir),
    metrics: {
      path: metrics.path,
      relativePath: relativeFromCwd(cwd, metrics.path),
      exists: metrics.exists,
      recordCount: metrics.records.length,
      skippedLineCount: metrics.skipped.length,
      skippedLines: metrics.skipped,
    },
    timeline: buildTimeline(metrics.records),
    phaseBreakdown,
    slowSteps: buildSlowSteps(metrics.records, topN),
    repairValidationEvents: buildRepairValidationEvents(metrics.records, topN),
    repairEventCount: metrics.records.filter((record) => {
      const haystack = `${record.phase} ${record.name}`.toLowerCase();
      return haystack.includes("repair") || (record.attempt ?? 1) > 1;
    }).length,
    artifacts,
    failureClasses,
  };
  session.recommendations = buildSessionRecommendations(session);
  return session;
}

function analyzeSingleSession(prefix, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const outDir = resolveOutDir(cwd);
  const sessionDir = findSessionDir(outDir, prefix);
  return {
    mode: "single",
    outDir,
    prefix,
    session: analyzeSessionDir(sessionDir, { cwd, topN: options.topN ?? DEFAULT_TOP_N }),
  };
}

function analyzeAllSessions(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const outDir = resolveOutDir(cwd);
  const topN = options.topN ?? DEFAULT_TOP_N;
  const allSessionDirs = listSessionDirs(outDir);
  const skippedSessions = [];
  const sessions = [];

  for (const sessionDir of allSessionDirs) {
    const metricsPath = path.join(sessionDir, ".deepagents", "metrics.jsonl");
    if (!existsSync(metricsPath)) {
      skippedSessions.push({
        sessionId: path.basename(sessionDir),
        reason: "missing .deepagents/metrics.jsonl",
      });
      continue;
    }
    sessions.push(analyzeSessionDir(sessionDir, { cwd, topN }));
  }

  const sessionRanking = sessions
    .slice()
    .sort((left, right) => right.timeline.totalWallClockMs - left.timeline.totalWallClockMs)
    .map((session, index) => ({
      rank: index + 1,
      sessionId: session.sessionId,
      relativeSessionDir: session.relativeSessionDir,
      totalWallClockMs: session.timeline.totalWallClockMs,
      totalDurationMs: session.timeline.totalDurationMs,
      eventCount: session.timeline.eventCount,
      failureCount: session.timeline.failureCount,
      repairEventCount: session.repairEventCount,
      skippedLineCount: session.metrics.skippedLineCount,
      finalStatus: session.artifacts.generationValidation.status ?? "missing",
    }));

  const phaseAggregates = buildPhaseAggregates(sessions);
  const failureClasses = sumFailureClasses(sessions.map((session) => session.failureClasses));
  const result = {
    mode: "all",
    outDir,
    scannedSessionCount: allSessionDirs.length,
    analyzedSessionCount: sessions.length,
    skippedSessions,
    sessionRanking,
    phaseAggregates,
    failureClasses,
    sessions,
  };
  result.recommendations = buildAllRecommendations(result);
  return result;
}

function buildPhaseAggregates(sessions) {
  const byPhase = new Map();
  for (const session of sessions) {
    for (const phase of session.phaseBreakdown) {
      const aggregate = byPhase.get(phase.phase) ?? {
        phase: phase.phase,
        count: 0,
        totalWallClockMs: 0,
        maxWallClockMs: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        eventCount: 0,
        failureCount: 0,
      };
      aggregate.count += 1;
      aggregate.totalWallClockMs += phase.wallClockMs;
      aggregate.maxWallClockMs = Math.max(aggregate.maxWallClockMs, phase.wallClockMs);
      aggregate.totalDurationMs += phase.totalDurationMs;
      aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, phase.totalDurationMs);
      aggregate.eventCount += phase.eventCount;
      aggregate.failureCount += phase.failureCount;
      byPhase.set(phase.phase, aggregate);
    }
  }

  return Array.from(byPhase.values())
    .map((aggregate) => ({
      ...aggregate,
      averageWallClockMs: aggregate.count > 0 ? aggregate.totalWallClockMs / aggregate.count : 0,
      averageDurationMs: aggregate.count > 0 ? aggregate.totalDurationMs / aggregate.count : 0,
    }))
    .sort((left, right) => right.averageWallClockMs - left.averageWallClockMs);
}

function classifySessionFailures(records, artifacts) {
  const counts = emptyFailureClassCounts();
  const texts = [];

  for (const record of records) {
    if (record.status === "failure" || record.error) {
      texts.push([
        record.phase,
        record.name,
        record.status,
        record.error ?? "",
        summarizeValue(record.metadata ?? "", 240),
      ].join(" "));
    }
  }

  const generationValidation = artifacts.generationValidation;
  if (generationValidation.exists) {
    if (Array.isArray(generationValidation.reasons)) {
      texts.push(...generationValidation.reasons);
    }
    if (Array.isArray(generationValidation.failedSteps)) {
      for (const step of generationValidation.failedSteps) {
        texts.push(`${step.name} ${step.detail ?? ""}`);
      }
    }
    if (generationValidation.parseError) {
      texts.push(generationValidation.parseError);
    }
  }

  const runtimeValidationLog = artifacts.runtimeValidationLog;
  if (runtimeValidationLog.exists && runtimeValidationLog.failureSignalLineCount > 0) {
    texts.push(...(runtimeValidationLog.summaryLines ?? []));
    texts.push(...(runtimeValidationLog.repairReasons ?? []).map((reason) => reason.reason));
  }

  const errorLog = artifacts.errorLog;
  if (errorLog.exists) {
    texts.push(...(errorLog.summaryLines ?? []));
    texts.push(...(errorLog.repairReasons ?? []).map((reason) => reason.reason));
  }

  if (texts.length === 0 && records.some((record) => record.status === "failure")) {
    counts.unknown += 1;
    return counts;
  }

  for (const text of texts) {
    counts[classifyFailureText(text)] += 1;
  }

  return counts;
}

function emptyFailureClassCounts() {
  return Object.fromEntries(FAILURE_CLASSES.map((failureClass) => [failureClass, 0]));
}

function sumFailureClasses(classCounts) {
  const totals = emptyFailureClassCounts();
  for (const counts of classCounts) {
    for (const failureClass of FAILURE_CLASSES) {
      totals[failureClass] += counts[failureClass] ?? 0;
    }
  }
  return totals;
}

function classifyFailureText(input) {
  const text = String(input);
  const checks = [
    ["structured response", /structured response|structuredResponse|\u7ed3\u6784\u5316\u54cd\u5e94/i],
    ["planSpec", /plan[-_ ]?spec|validatePlanSpec|plan\.validate|plan validation|\u8ba1\u5212\u6821\u9a8c|\u8ba1\u5212\u9a8c\u8bc1/i],
    ["typecheck", /typecheck|tsc|typescript|TS\d{4}/i],
    ["db:init", /db:init|prisma|database|sqlite|migrate|seed|DATABASE_URL/i],
    ["smoke", /smoke|\u5192\u70df/i],
    ["runtime", /runtime validation|runtime_validation|dev server|pnpm dev|\u8fd0\u884c\u9a8c\u8bc1|non-interactive|interactive runtime/i],
  ];

  for (const [failureClass, regex] of checks) {
    if (regex.test(text)) {
      return failureClass;
    }
  }
  return "unknown";
}

function hasFailureSignal(line) {
  return /fail|error|exception|invalid|timeout|timed out|missing|retry|not found|EADDRINUSE|TS\d{4}|\u5931\u8d25|\u672a\u901a\u8fc7|\u7f3a\u5931/i.test(line);
}

function buildSessionRecommendations(session) {
  const recommendations = [];
  const slowestPhase = session.phaseBreakdown.slice().sort((left, right) => right.wallClockMs - left.wallClockMs)[0];
  if (slowestPhase && slowestPhase.wallClockMs > 0) {
    recommendations.push(
      `Focus first on phase \`${slowestPhase.phase}\`; it has the largest wall-clock at ${formatDurationMs(slowestPhase.wallClockMs)}.`,
    );
  }

  const slowestStep = session.slowSteps[0];
  if (slowestStep && slowestStep.durationMs > 0) {
    recommendations.push(
      `Inspect slow step \`${slowestStep.name}\` in phase \`${slowestStep.phase}\`; it took ${formatDurationMs(slowestStep.durationMs)}.`,
    );
  }

  const topFailureClass = topClass(session.failureClasses);
  if (topFailureClass && topFailureClass.count > 0) {
    recommendations.push(
      `Most common failure class is \`${topFailureClass.name}\` (${topFailureClass.count}); use the validation and error summaries below to target repair prompts or host checks.`,
    );
  }

  if (session.repairEventCount > 0) {
    recommendations.push(
      `There are ${session.repairEventCount} repair or retry-related metric events; compare attempts before changing prompts or validators.`,
    );
  }

  if (session.metrics.skippedLineCount > 0) {
    recommendations.push(
      `${session.metrics.skippedLineCount} metrics line(s) were skipped; inspect \`${session.metrics.relativePath}\` before relying on exact counts.`,
    );
  }

  if (session.artifacts.generationValidation.status === "failed") {
    recommendations.push("Final generation validation failed; prioritize the failed validation step before optimizing duration.");
  }

  if (recommendations.length === 0) {
    recommendations.push("No obvious bottleneck or failure pattern was detected from the available metrics.");
  }

  return recommendations;
}

function buildAllRecommendations(result) {
  const recommendations = [];
  const slowestSession = result.sessionRanking[0];
  if (slowestSession) {
    recommendations.push(
      `Start with slowest session \`${slowestSession.sessionId}\`; total wall-clock is ${formatDurationMs(slowestSession.totalWallClockMs)}.`,
    );
  }

  const slowestPhase = result.phaseAggregates[0];
  if (slowestPhase) {
    recommendations.push(
      `Largest average phase wall-clock is \`${slowestPhase.phase}\` at ${formatDurationMs(slowestPhase.averageWallClockMs)} across ${slowestPhase.count} session(s).`,
    );
  }

  const topFailureClass = topClass(result.failureClasses);
  if (topFailureClass && topFailureClass.count > 0) {
    recommendations.push(
      `Most common failure class is \`${topFailureClass.name}\` (${topFailureClass.count}); fix this class before tuning lower-frequency failures.`,
    );
  }

  const repairHeavy = result.sessionRanking.find((session) => session.repairEventCount > 0);
  if (repairHeavy) {
    recommendations.push(
      `Session \`${repairHeavy.sessionId}\` has ${repairHeavy.repairEventCount} repair/retry event(s); review its repair timeline for repeated validation loops.`,
    );
  }

  const skippedLineTotal = sum(result.sessions, (session) => session.metrics.skippedLineCount);
  if (skippedLineTotal > 0) {
    recommendations.push(
      `${skippedLineTotal} malformed or incomplete metrics line(s) were skipped across analyzed sessions; clean logs before comparing exact event totals.`,
    );
  }

  if (result.analyzedSessionCount === 0) {
    recommendations.push("No sessions with metrics.jsonl were found under .out/.");
  }

  return recommendations;
}

function topClass(counts) {
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count)[0] ?? null;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return seconds > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${hours}h ${minutes}m`;
  }
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function summarizeValue(value, maxLength) {
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sum(items, mapper) {
  return items.reduce((total, item) => total + mapper(item), 0);
}

function markdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

function renderFailureClassCounts(counts) {
  return FAILURE_CLASSES
    .map((failureClass) => `\`${failureClass}\`: ${counts[failureClass] ?? 0}`)
    .join(", ");
}

function renderSingleMarkdown(result) {
  const session = result.session;
  const lines = [];
  lines.push(`# Metrics Analysis: \`${markdownCell(session.sessionId)}\``);
  lines.push("");
  lines.push(`**Directory:** \`${markdownCell(session.relativeSessionDir)}\``);
  lines.push(`**Metrics:** ${session.metrics.recordCount} record(s), ${session.metrics.skippedLineCount} skipped line(s)`);
  lines.push("");

  lines.push("## Timeline");
  lines.push("");
  lines.push(`- First event: ${session.timeline.firstEventAt ?? "n/a"}`);
  lines.push(`- Last event: ${session.timeline.lastEventAt ?? "n/a"}`);
  lines.push(`- Total wall-clock: ${formatDurationMs(session.timeline.totalWallClockMs)}`);
  lines.push(`- Total recorded duration: ${formatDurationMs(session.timeline.totalDurationMs)}`);
  lines.push(`- Events: ${session.timeline.eventCount}`);
  lines.push(`- Failures: ${session.timeline.failureCount}`);
  lines.push(`- Max attempt: ${session.timeline.maxAttempt}`);
  lines.push("");

  lines.push("## Phase Breakdown");
  lines.push("");
  lines.push("| Phase | Events | Wall-clock | Duration sum | Failures | Max attempt |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  if (session.phaseBreakdown.length === 0) {
    lines.push("| n/a | 0 | 0s | 0s | 0 | 0 |");
  } else {
    for (const phase of session.phaseBreakdown) {
      lines.push([
        markdownCell(phase.phase),
        phase.eventCount,
        formatDurationMs(phase.wallClockMs),
        formatDurationMs(phase.totalDurationMs),
        phase.failureCount,
        phase.maxAttempt,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }
  lines.push("");

  lines.push("## Slow Steps");
  lines.push("");
  lines.push("| Rank | Phase | Name | Attempt | Status | Duration | Error |");
  lines.push("| ---: | --- | --- | ---: | --- | ---: | --- |");
  if (session.slowSteps.length === 0) {
    lines.push("| 0 | n/a | n/a | 0 | n/a | 0s |  |");
  } else {
    for (const step of session.slowSteps) {
      lines.push([
        step.rank,
        markdownCell(step.phase),
        markdownCell(step.name),
        step.attempt,
        markdownCell(step.status),
        formatDurationMs(step.durationMs),
        markdownCell(step.error ?? ""),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }
  lines.push("");

  lines.push("## Repair / Validation Events");
  lines.push("");
  lines.push("| Phase | Name | Attempt | Status | Duration | Error |");
  lines.push("| --- | --- | ---: | --- | ---: | --- |");
  if (session.repairValidationEvents.length === 0) {
    lines.push("| n/a | n/a | 0 | n/a | 0s |  |");
  } else {
    for (const event of session.repairValidationEvents) {
      lines.push([
        markdownCell(event.phase),
        markdownCell(event.name),
        event.attempt,
        markdownCell(event.status),
        formatDurationMs(event.durationMs),
        markdownCell(event.error ?? ""),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }
  lines.push("");

  appendArtifactsMarkdown(lines, session.artifacts);

  lines.push("## Failure Classes");
  lines.push("");
  lines.push(renderFailureClassCounts(session.failureClasses));
  lines.push("");

  lines.push("## Recommendations");
  lines.push("");
  for (const recommendation of session.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  lines.push("");

  if (session.metrics.skippedLines.length > 0) {
    lines.push("## Skipped Metrics Lines");
    lines.push("");
    lines.push("| Line | Reason |");
    lines.push("| ---: | --- |");
    for (const skipped of session.metrics.skippedLines) {
      lines.push(`| ${skipped.line} | ${markdownCell(skipped.reason)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function appendArtifactsMarkdown(lines, artifacts) {
  lines.push("## Artifacts");
  lines.push("");

  const validation = artifacts.generationValidation;
  lines.push("### Generation Validation");
  lines.push("");
  if (!validation.exists) {
    lines.push("- Missing");
  } else {
    lines.push(`- Status: ${validation.status}`);
    if (validation.parseError) {
      lines.push(`- Parse error: ${validation.parseError}`);
    }
    if (validation.reasons?.length > 0) {
      lines.push(`- Reasons: ${validation.reasons.join(" | ")}`);
    }
    if (validation.failedSteps?.length > 0) {
      lines.push("- Failed steps:");
      for (const step of validation.failedSteps) {
        lines.push(`  - \`${markdownCell(step.name)}\`: ${markdownCell(step.detail ?? "n/a")}`);
      }
    }
  }
  lines.push("");

  appendLogSummaryMarkdown(lines, "Runtime Validation Log", artifacts.runtimeValidationLog);
  appendLogSummaryMarkdown(lines, "Error Log", artifacts.errorLog);
}

function appendLogSummaryMarkdown(lines, title, log) {
  lines.push(`### ${title}`);
  lines.push("");
  if (!log.exists) {
    lines.push("- Missing");
    lines.push("");
    return;
  }

  lines.push(`- Lines: ${log.lineCount}`);
  lines.push(`- Bytes: ${log.bytes}`);
  if (log.summaryLines.length > 0) {
    lines.push("- Failure summary:");
    for (const line of log.summaryLines) {
      lines.push(`  - ${markdownCell(line)}`);
    }
  }
  if (log.repairReasons.length > 0) {
    lines.push("- Repair reasons:");
    for (const reason of log.repairReasons) {
      lines.push(`  - Attempt ${reason.attempt ?? "n/a"}: ${markdownCell(reason.reason)}`);
    }
  }
  lines.push("");
}

function renderAllMarkdown(result) {
  const lines = [];
  lines.push("# Metrics Analysis: All Sessions");
  lines.push("");
  lines.push(`**Scanned sessions:** ${result.scannedSessionCount}`);
  lines.push(`**Analyzed sessions:** ${result.analyzedSessionCount}`);
  lines.push(`**Skipped sessions:** ${result.skippedSessions.length}`);
  lines.push("");

  lines.push("## Slowest Sessions");
  lines.push("");
  lines.push("| Rank | Session | Wall-clock | Duration sum | Events | Failures | Repairs | Skipped | Final status |");
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
  if (result.sessionRanking.length === 0) {
    lines.push("| 0 | n/a | 0s | 0s | 0 | 0 | 0 | 0 | n/a |");
  } else {
    for (const session of result.sessionRanking) {
      lines.push([
        session.rank,
        markdownCell(session.sessionId),
        formatDurationMs(session.totalWallClockMs),
        formatDurationMs(session.totalDurationMs),
        session.eventCount,
        session.failureCount,
        session.repairEventCount,
        session.skippedLineCount,
        markdownCell(session.finalStatus),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }
  lines.push("");

  lines.push("## Phase Aggregates");
  lines.push("");
  lines.push("| Phase | Count | Avg wall-clock | Max wall-clock | Avg duration | Max duration | Events | Failures |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  if (result.phaseAggregates.length === 0) {
    lines.push("| n/a | 0 | 0s | 0s | 0s | 0s | 0 | 0 |");
  } else {
    for (const phase of result.phaseAggregates) {
      lines.push([
        markdownCell(phase.phase),
        phase.count,
        formatDurationMs(phase.averageWallClockMs),
        formatDurationMs(phase.maxWallClockMs),
        formatDurationMs(phase.averageDurationMs),
        formatDurationMs(phase.maxDurationMs),
        phase.eventCount,
        phase.failureCount,
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }
  lines.push("");

  lines.push("## Failure Classes");
  lines.push("");
  lines.push(renderFailureClassCounts(result.failureClasses));
  lines.push("");

  lines.push("## Recommendations");
  lines.push("");
  for (const recommendation of result.recommendations) {
    lines.push(`- ${recommendation}`);
  }
  lines.push("");

  if (result.skippedSessions.length > 0) {
    lines.push("## Skipped Sessions");
    lines.push("");
    lines.push("| Session | Reason |");
    lines.push("| --- | --- |");
    for (const session of result.skippedSessions) {
      lines.push(`| ${markdownCell(session.sessionId)} | ${markdownCell(session.reason)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();

  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }

    const result = options.all
      ? analyzeAllSessions({ cwd, topN: options.topN })
      : analyzeSingleSession(options.sessionPrefix, { cwd, topN: options.topN });
    const rendered = options.json
      ? JSON.stringify(result, null, 2)
      : (options.all ? renderAllMarkdown(result) : renderSingleMarkdown(result));
    stdout.write(`${rendered}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export {
  analyzeAllSessions,
  analyzeSingleSession,
  analyzeSessionDir,
  classifyFailureText,
  formatDurationMs,
  parseArgs,
  readMetricsJsonl,
  renderAllMarkdown,
  renderSingleMarkdown,
};

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = await runCli();
}
