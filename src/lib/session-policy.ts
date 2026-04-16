export type SessionPolicyStage = "plan" | "plan_repair" | "generate" | "generate_repair";

export const SESSION_POLICY_HEADER = "# Host Session Policy";

export function buildSessionPolicyDocument(): string {
  return [
    SESSION_POLICY_HEADER,
    "",
    "This file is host-generated. Treat it as the session-wide policy baseline for every stage.",
    "",
    "## Common Rules",
    "",
    "- The virtual workspace root is `/` and host-managed artifacts stay under `/.deepagents/`.",
    "- The authoritative artifact paths are fixed as follows:",
    "  - `artifacts.sourcePrd` = `/.deepagents/source-prd.md`",
    "  - `artifacts.analysis` = `/.deepagents/prd-analysis.md`",
    "  - `artifacts.generatedSpec` = `/.deepagents/generated-spec.md`",
    "  - `artifacts.planSpec` = `/.deepagents/plan-spec.json`",
    "  - `artifacts.planValidation` = `/.deepagents/plan-validation.json`",
    "  - `artifacts.generationValidation` = `/.deepagents/generation-validation.json`",
    "  - `artifacts.runtimeValidationLog` = `/.deepagents/runtime-validation.log`",
    "  - `artifacts.errorLog` = `/.deepagents/error.log`",
    "- Input `artifacts.*` values are the only source of truth. Do not infer, rename, shorten, or relocate them.",
    "- Do not delegate to child agents or task-style fanout tools inside DeepAgents stages.",
    "- Use `write_todos` before substantive work and keep todo state updated until the stage is complete.",
    "",
    "## Plan Rules",
    "",
    "- The plan stages may only read inputs and write planning artifacts. They must not modify application source files.",
    "- `artifacts.planSpec` must be legal JSON and satisfy the input `planSpecSchema` before the stage can finish.",
    "- `hardConstraints.planSpecSchemaValidation` is a blocking constraint, not a suggestion.",
    "- Optional string fields with no value must be omitted. Do not write empty strings.",
    "- Required string fields must be non-empty strings.",
    "- `acceptanceChecks.target` must follow these rules:",
    "  - `resource` targets use the resource name.",
    "  - `page` targets use the page route.",
    "  - `api` targets use the API file path from `planSpec.apis[*].path`.",
    "  - `flow` targets use the flow name.",
    "",
    "## Generate Rules",
    "",
    "- The generate stages must treat the validated `planSpec` as the only structured source of truth.",
    "- Do not re-plan from the original PRD when `planSpec` is already available.",
    "- If host validation reports broken artifact paths or contract mismatches, repair the affected files in place instead of inventing new paths.",
  ].join("\n");
}

export function composeStageSystemPrompt(
  stage: SessionPolicyStage,
  templatePrompt: string,
  sessionPolicy: string,
): string {
  if (templatePrompt.includes(SESSION_POLICY_HEADER)) {
    return templatePrompt;
  }

  const stageLabel = (() => {
    switch (stage) {
      case "plan":
        return "Plan Stage";
      case "plan_repair":
        return "Plan Repair Stage";
      case "generate":
        return "Generate Stage";
      case "generate_repair":
        return "Generate Repair Stage";
    }
  })();

  return [
    sessionPolicy.trimEnd(),
    "",
    "---",
    "",
    `## Active Stage`,
    "",
    `Current stage: ${stageLabel}. The session policy above overrides weaker or conflicting template wording.`,
    "",
    "---",
    "",
    templatePrompt.trimStart(),
  ].join("\n");
}
