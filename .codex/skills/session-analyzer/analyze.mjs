#!/usr/bin/env node
/**
 * Session Analyzer for app-builder-v2
 *
 * Analyzes a generation session under .out/<sessionId>/ and prints
 * a structured report covering wall-clock timing, retry patterns,
 * repair root causes, and final validation status.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";

const OUT_DIR = resolve(process.cwd(), ".out");

function findSessionDir(prefix) {
  if (!existsSync(OUT_DIR)) {
    throw new Error(`.out/ directory not found at ${OUT_DIR}`);
  }
  const candidates = readdirSync(OUT_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
    .map((d) => join(OUT_DIR, d.name));

  if (candidates.length === 0) {
    throw new Error(`No session directory found starting with "${prefix}"`);
  }
  if (candidates.length > 1) {
    throw Error(
      `Ambiguous prefix "${prefix}" matches multiple sessions:\n  ${candidates.join("\n  ")}`
    );
  }
  return candidates[0];
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch {
      console.error(`  ⚠️  Skipping malformed JSON at ${filePath}:${idx + 1}`);
      return null;
    }
  }).filter(Boolean);
}

function parseDotEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      value = value.replace(/^["']|["']$/g, "");
      result[key] = value;
    }
  }
  return result;
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function analyzeMetrics(metrics) {
  const byPhase = {};
  for (const m of metrics) {
    const p = m.phase || "unknown";
    if (!byPhase[p]) byPhase[p] = [];
    byPhase[p].push(m);
  }

  const phases = [];
  for (const [phase, events] of Object.entries(byPhase)) {
    const starts = events.map((e) => new Date(e.startedAt).getTime());
    const ends = events.map((e) => new Date(e.completedAt).getTime());
    const wallClockMs = Math.max(...ends) - Math.min(...starts);
    const failures = events.filter((e) => e.status === "failure").length;
    const maxAttempt = Math.max(...events.map((e) => e.attempt || 1));
    const totalDurationMs = events.reduce((s, e) => s + (e.durationMs || 0), 0);

    phases.push({
      phase,
      events: events.length,
      wallClockSec: wallClockMs / 1000,
      totalDurationSec: totalDurationMs / 1000,
      failures,
      maxAttempt,
      firstStart: events[0].startedAt,
      lastEnd: events[events.length - 1].completedAt,
    });
  }

  phases.sort((a, b) => new Date(a.firstStart) - new Date(b.firstStart));
  return phases;
}

function extractRepairReasons(errorLogText) {
  const reasons = [];
  // Pattern: "Retry attempt N triggered for 生成修复阶段 because:"
  const retryRegex = /Retry attempt\s+(\d+)\s+triggered.*?because:([\s\S]*?)(?=\n\[|\nRetry attempt|$)/g;
  let match;
  while ((match = retryRegex.exec(errorLogText)) !== null) {
    const attempt = parseInt(match[1], 10);
    const reason = match[2].trim().replace(/\n/g, " ");
    reasons.push({ attempt, reason });
  }

  // Also catch structured response failures
  const structuredFailRegex = /(PRD 分析|计划修复|计划|生成)阶段结构化响应缺失/g;
  let sMatch;
  while ((sMatch = structuredFailRegex.exec(errorLogText)) !== null) {
    reasons.push({ attempt: null, reason: `${sMatch[1]}阶段结构化响应缺失，触发 retry` });
  }

  return reasons;
}

function main() {
  const prefix = process.argv[2];
  if (!prefix) {
    console.error("Usage: node analyze.mjs <session-id-prefix>");
    process.exit(1);
  }

  const sessionDir = findSessionDir(prefix);
  const deepagentsDir = join(sessionDir, ".deepagents");

  console.log(`# Session Analysis: \`${prefix}\``);
  console.log();
  console.log(`**Directory:** \`${sessionDir.replace(process.cwd() + "/", "")}\``);
  console.log();

  // ── Metrics ───────────────────────────────────────────────
  const metricsPath = join(deepagentsDir, "metrics.jsonl");
  const metrics = readJsonl(metricsPath);

  if (metrics.length === 0) {
    console.log("*No metrics.jsonl found.*");
    return;
  }

  const allStarts = metrics.map((m) => new Date(m.startedAt).getTime());
  const allEnds = metrics.map((m) => new Date(m.completedAt).getTime());
  const totalWallSec = (Math.max(...allEnds) - Math.min(...allStarts)) / 1000;

  console.log("## Timeline");
  console.log();
  console.log(`- **First event:** ${metrics[0].startedAt}`);
  console.log(`- **Last event:**  ${metrics[metrics.length - 1].completedAt}`);
  console.log(`- **Total wall-clock:** ${formatDuration(totalWallSec)}`);
  console.log();

  const phases = analyzeMetrics(metrics);
  console.log("## Phase Breakdown");
  console.log();
  console.log("| Phase | Events | Wall-clock | Failures | Max Attempt |");
  console.log("|-------|--------|------------|----------|-------------|");
  for (const p of phases) {
    const wc = formatDuration(p.wallClockSec);
    console.log(`| ${p.phase} | ${p.events} | ${wc} | ${p.failures} | ${p.maxAttempt} |`);
  }
  console.log();

  // ── Repair Details ────────────────────────────────────────
  const repairPhases = phases.filter((p) => p.phase.includes("repair") || p.maxAttempt > 1);
  if (repairPhases.length > 0) {
    console.log("## Retry / Repair");
    console.log();
    for (const p of repairPhases) {
      console.log(`- **${p.phase}:** max attempt ${p.maxAttempt}, wall-clock ${formatDuration(p.wallClockSec)}`);
    }
    console.log();
  }

  // ── Repair Reasons ────────────────────────────────────────
  const errorLogPath = join(deepagentsDir, "error.log");
  if (existsSync(errorLogPath)) {
    const errorText = readFileSync(errorLogPath, "utf8");
    const reasons = extractRepairReasons(errorText);
    if (reasons.length > 0) {
      console.log("## Repair Root Causes");
      console.log();
      for (const r of reasons) {
        const label = r.attempt !== null ? `Attempt ${r.attempt}` : `Framework retry`;
        console.log(`- **${label}:** ${r.reason}`);
      }
      console.log();
    }
  }

  // ── Generation Validation ─────────────────────────────────
  const validationPath = join(deepagentsDir, "generation-validation.json");
  if (existsSync(validationPath)) {
    const validation = JSON.parse(readFileSync(validationPath, "utf8"));
    console.log("## Final Validation");
    console.log();
    console.log(`- **Valid:** ${validation.valid ? "✅ yes" : "❌ no"}`);
    if (validation.reasons && validation.reasons.length > 0) {
      console.log(`- **Reasons:** ${validation.reasons.join(", ")}`);
    }
    if (validation.steps && validation.steps.length > 0) {
      console.log("- **Steps:**");
      for (const s of validation.steps) {
        const icon = s.ok ? "✅" : "❌";
        console.log(`  - ${icon} \`${s.name}\` — ${s.detail || "n/a"}`);
      }
    }
    console.log();
  }

  // ── Env Consistency ───────────────────────────────────────
  const envPath = join(sessionDir, ".env");
  const envExamplePath = join(sessionDir, ".env.example");
  if (existsSync(envPath) && existsSync(envExamplePath)) {
    const env = parseDotEnv(readFileSync(envPath, "utf8"));
    const example = parseDotEnv(readFileSync(envExamplePath, "utf8"));

    const mismatches = [];
    const allKeys = new Set([...Object.keys(env), ...Object.keys(example)]);
    for (const key of allKeys) {
      if (env[key] !== example[key]) {
        mismatches.push({ key, env: env[key], example: example[key] });
      }
    }

    console.log("## Env Consistency");
    console.log();
    if (mismatches.length === 0) {
      console.log("✅ `.env` and `.env.example` are fully consistent.");
    } else {
      console.log("❌ Mismatches found:");
      for (const m of mismatches) {
        console.log(`  - \`${m.key}\`: .env=\`${m.env ?? "(missing)"}\`, .env.example=\`${m.example ?? "(missing)"}\``);
      }
    }
    console.log();
  }
}

main();
