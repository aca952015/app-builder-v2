import { z } from "zod";

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
