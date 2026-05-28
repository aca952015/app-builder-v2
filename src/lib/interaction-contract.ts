import { z } from "zod";

import type { PlanSpec } from "./plan-spec.js";

const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const responseFieldsSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

export const interactionContractSchema = z.object({
  flows: z.array(z.object({
    name: z.string().min(1),
    critical: z.boolean().optional(),
    triggerControl: z.string().min(1),
    fallbackTrigger: z.string().min(1),
    loadingState: z.string().min(1),
    emptyState: z.string().min(1),
    errorState: z.string().min(1),
  }).passthrough()),
  internalOperations: z.array(z.object({
    name: z.string().min(1),
    pageRoute: z.string().regex(/^\//),
    triggerControl: z.string().min(1),
    apiPath: z.string().regex(/^\/app\/api\/.+\/route\.ts$/),
    method: httpMethodSchema,
  }).passthrough()),
  externalOperations: z.array(z.object({
    name: z.string().min(1),
    endpointPath: z.string().min(1),
    authSource: z.string().min(1),
    parameterFormat: z.string().min(1),
    responseFields: responseFieldsSchema,
    reference: z.string().min(1),
  }).passthrough()),
}).passthrough();

export type InteractionContract = z.infer<typeof interactionContractSchema>;

export function validateInteractionContract(value: unknown): {
  success: true;
  data: InteractionContract;
} | {
  success: false;
  issues: string[];
} {
  const parsed = interactionContractSchema.safeParse(value);
  if (parsed.success) {
    return {
      success: true,
      data: parsed.data,
    };
  }

  return {
    success: false,
    issues: parsed.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    }),
  };
}

function normalizeContractName(value: string): string {
  return value.trim().toLowerCase();
}

export function validateInteractionContractForPlanSpec(
  interactionContract: InteractionContract,
  planSpec: PlanSpec,
): string[] {
  const issues: string[] = [];
  const planFlowNames = planSpec.flows.map((flow) => flow.name).filter(Boolean);
  const contractFlowNames = new Set(interactionContract.flows.map((flow) => normalizeContractName(flow.name)));

  if (planFlowNames.length > 0 && interactionContract.flows.length === 0) {
    issues.push("flows 不能为空：planSpec.flows 已声明用户流程，interactionContract 必须覆盖这些流程。");
  }

  for (const flowName of planFlowNames) {
    if (!contractFlowNames.has(normalizeContractName(flowName))) {
      issues.push(`flows 缺少 planSpec.flows 中的流程：${flowName}`);
    }
  }

  const pageRoutes = new Set(planSpec.pages.map((page) => page.route));
  const apiMethodsByPath = new Map<string, Set<string>>();
  for (const api of planSpec.apis) {
    const methods = apiMethodsByPath.get(api.path) ?? new Set<string>();
    for (const method of api.methods) {
      methods.add(method);
    }
    apiMethodsByPath.set(api.path, methods);
  }

  for (const operation of interactionContract.internalOperations) {
    if (!pageRoutes.has(operation.pageRoute)) {
      issues.push(`internalOperations.${operation.name}.pageRoute 未在 planSpec.pages 中声明：${operation.pageRoute}`);
    }

    const methods = apiMethodsByPath.get(operation.apiPath);
    if (!methods) {
      issues.push(`internalOperations.${operation.name}.apiPath 未在 planSpec.apis 中声明：${operation.apiPath}`);
      continue;
    }

    if (!methods.has(operation.method)) {
      issues.push(`internalOperations.${operation.name}.method 未在 planSpec.apis 对应接口中声明：${operation.method} ${operation.apiPath}`);
    }
  }

  const referenceKeys = new Set(
    (planSpec.references ?? []).flatMap((reference) =>
      [reference.name, reference.url, reference.localPath].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    ),
  );

  if (referenceKeys.size > 0) {
    for (const operation of interactionContract.externalOperations) {
      if (!referenceKeys.has(operation.reference)) {
        issues.push(`externalOperations.${operation.name}.reference 未匹配 planSpec.references：${operation.reference}`);
      }
    }
  }

  return issues;
}
