import { z } from "zod";

export const planSpecFieldTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "email",
]);

export const planSpecRelationKindSchema = z.enum([
  "oneToOne",
  "oneToMany",
  "manyToOne",
  "manyToMany",
]);

export const planSpecResourceUsageSchema = z.enum([
  "direct",
  "indirect",
]);

export const planSpecPageKindSchema = z.enum([
  "dashboard",
  "list",
  "detail",
  "create",
  "edit",
  "settings",
  "custom",
]);

export const planSpecHttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export const planSpecAcceptanceTypeSchema = z.enum([
  "resource",
  "page",
  "api",
  "flow",
]);

// Google function declarations reject JSON Schema `const`; keep exact values
// with equivalent schemas that serialize to supported keywords.
const planSpecVersionSchema = z.number().int().min(1).max(1);
const envExampleTargetFileSchema = z.enum([".env.example"]);

export const planSpecSchema = z.object({
  version: planSpecVersionSchema,
  appName: z.string().min(1),
  summary: z.string().min(1),
  resources: z.array(z.object({
    name: z.string().min(1),
    pluralName: z.string().min(1),
    routeSegment: z.string().min(1),
    description: z.string().min(1),
    usage: planSpecResourceUsageSchema.optional(),
    fields: z.array(z.object({
      name: z.string().min(1),
      label: z.string().min(1),
      type: planSpecFieldTypeSchema,
      required: z.boolean(),
      source: z.enum(["prd", "assumption"]).default("prd"),
      description: z.string().min(1).optional(),
    })).min(1),
    relations: z.array(z.object({
      name: z.string().min(1),
      target: z.string().min(1),
      kind: planSpecRelationKindSchema,
      description: z.string().min(1).optional(),
    })).default([]),
  })).min(1),
  pages: z.array(z.object({
    name: z.string().min(1),
    route: z.string().regex(/^\//),
    kind: planSpecPageKindSchema,
    resourceName: z.string().min(1).optional(),
    purpose: z.string().min(1),
  })).min(1),
  apis: z.array(z.object({
    name: z.string().min(1),
    resourceName: z.string().min(1),
    path: z.string().regex(/^\/app\/api\/.+\/route\.ts$/),
    methods: z.array(planSpecHttpMethodSchema).min(1),
    requestShape: z.string().min(1),
    responseShape: z.string().min(1),
  })).min(1),
  flows: z.array(z.object({
    name: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
  })).min(1),
  environmentVariables: z.array(z.object({
    name: z.string().min(1).regex(/^[A-Z][A-Z0-9_]*$/),
    value: z.string().min(1),
    description: z.string().min(1).optional(),
    targetFile: envExampleTargetFileSchema.optional(),
  })).optional(),
  references: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(["external_api", "external_service", "documentation", "other"]),
    url: z.string().min(1).optional(),
    description: z.string().min(1),
    usage: z.string().min(1).optional(),
    localPath: z.string().min(1).optional(),
    retrievedAt: z.string().min(1).optional(),
    contentType: z.string().min(1).optional(),
    retrievalStatus: z.enum(["downloaded", "failed", "skipped"]).optional(),
  })).optional(),
  projectConfigChanges: z.array(z.object({
    filePath: z.string().min(1),
    reason: z.string().min(1),
    prdEvidence: z.string().min(1),
  })).optional(),
  assumptions: z.array(z.string().min(1)).default([]),
  acceptanceChecks: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    type: planSpecAcceptanceTypeSchema,
    target: z.string().min(1),
  })).min(1),
});

export type PlanSpec = z.infer<typeof planSpecSchema>;

export function validatePlanSpec(value: unknown): {
  success: true;
  data: PlanSpec;
} | {
  success: false;
  issues: string[];
} {
  const parsed = planSpecSchema.safeParse(value);
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
