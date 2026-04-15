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

export const planSpecSchema = z.object({
  version: z.literal(1),
  appName: z.string().min(1),
  summary: z.string().min(1),
  resources: z.array(z.object({
    name: z.string().min(1),
    pluralName: z.string().min(1),
    routeSegment: z.string().min(1),
    description: z.string().min(1),
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
