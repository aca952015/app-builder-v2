import path from "node:path";
import { promises as fs } from "node:fs";

import type { TextGeneratorRuntime, WorkflowPhase } from "./types.js";

export type WorkflowMetricPhase = WorkflowPhase | "workspace" | "template" | "spec" | "references";

export type WorkflowMetricInput = {
  name: string;
  phase: WorkflowMetricPhase;
  attempt?: number;
  metadata?: Record<string, unknown>;
};

export type WorkflowMetricRecord = {
  version: 1;
  sessionId: string;
  name: string;
  phase: WorkflowMetricPhase;
  status: "success" | "failure";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  attempt?: number;
  metadata?: Record<string, unknown>;
  error?: string;
};

function summarizeMetricError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMetricMetadataValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    (typeof value === "object" && value !== undefined)
  );
}

function sanitizeMetricMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  const sanitized = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined && isMetricMetadataValue(value)),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function buildWorkflowMetricRecord(input: {
  sessionId: string;
  metric: WorkflowMetricInput;
  status: "success" | "failure";
  startedAt: Date;
  completedAt: Date;
  startedHr: bigint;
  error?: unknown;
}): WorkflowMetricRecord {
  const durationMs = Number(process.hrtime.bigint() - input.startedHr) / 1_000_000;
  const metadata = sanitizeMetricMetadata(input.metric.metadata);
  return {
    version: 1,
    sessionId: input.sessionId,
    name: input.metric.name,
    phase: input.metric.phase,
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    completedAt: input.completedAt.toISOString(),
    durationMs: Number(durationMs.toFixed(3)),
    ...(input.metric.attempt !== undefined ? { attempt: input.metric.attempt } : {}),
    ...(metadata ? { metadata } : {}),
    ...(input.error !== undefined ? { error: summarizeMetricError(input.error) } : {}),
  };
}

export async function appendWorkflowMetricRecord(logPath: string, record: WorkflowMetricRecord): Promise<void> {
  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Metrics are for analysis and must not block generation or recovery.
  }
}

export async function measureWorkflowStep<T>(
  logPath: string,
  sessionId: string,
  metric: WorkflowMetricInput,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  const startedHr = process.hrtime.bigint();
  try {
    const result = await action();
    await appendWorkflowMetricRecord(logPath, buildWorkflowMetricRecord({
      sessionId,
      metric,
      status: "success",
      startedAt,
      completedAt: new Date(),
      startedHr,
    }));
    return result;
  } catch (error) {
    await appendWorkflowMetricRecord(logPath, buildWorkflowMetricRecord({
      sessionId,
      metric,
      status: "failure",
      startedAt,
      completedAt: new Date(),
      startedHr,
      error,
    }));
    throw error;
  }
}

export async function measureRuntimeStep<T>(
  runtime: TextGeneratorRuntime,
  metric: WorkflowMetricInput,
  action: () => Promise<T>,
): Promise<T> {
  return await measureWorkflowStep(runtime.deepagentsMetricsLogPath, runtime.sessionId, metric, action);
}
