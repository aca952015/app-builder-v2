export type SessionPolicyStage = "plan_analysis" | "plan" | "plan_repair" | "generate" | "generate_repair";

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
    "  - `artifacts.interactionContract` = `/.deepagents/interaction-contract.json`",
    "  - `artifacts.planValidation` = `/.deepagents/plan-validation.json`",
    "  - `artifacts.generationValidation` = `/.deepagents/generation-validation.json`",
    "  - `artifacts.runtimeValidationLog` = `/.deepagents/runtime-validation.log`",
    "  - `artifacts.runtimeInteractionValidation` = `/.deepagents/runtime-interaction-validation.json`",
    "  - `artifacts.errorLog` = `/.deepagents/error.log`",
    "- Input `artifacts.*` values are the only source of truth. Do not infer, rename, shorten, or relocate them.",
    "- Host-materialized JSON, validation, runtime, config, prompt snapshot, and source mirror artifacts are read-only to model file tools. Never create, edit, overwrite, delete, relocate, or repair them with `write_file` or `edit_file`; return structured response fields or let the host update them.",
    "- This write-protection does not apply to `artifacts.analysis` or `artifacts.generatedSpec`, which plan stages must write as Markdown planning artifacts.",
    "- Use `write_todos` before substantive work and keep todo state updated until the stage is complete.",
    "",
    "## Plan Rules",
    "",
    "- The plan stages may only read inputs and write planning artifacts. They must not modify application source files.",
    "- The PRD analysis stage writes only `artifacts.analysis`; final generated spec, structured plan spec response, and structured interaction contract response happen in the plan assembly stage.",
    "- In plan assembly and plan repair stages, the final structured response must include `planSpec` as a legal JSON object satisfying the input `planSpecSchema`; the host materializes `artifacts.planSpec` from that response before validation.",
    "- In plan assembly and plan repair stages, `hardConstraints.planSpecSchemaValidation` is a blocking constraint, not a suggestion.",
    "- In plan assembly and plan repair stages, the final structured response must include `interactionContract` with `flows`, `internalOperations`, and `externalOperations`; the host materializes `artifacts.interactionContract` from that response before validation.",
    "- In plan assembly and plan repair stages, `interactionContract` records critical user-action triggers, internal API mappings, and external operation details; keep it aligned with the final structured `planSpec` and references.",
    "- In plan assembly and plan repair stages, `hardConstraints.interactionContractValidation` is a blocking constraint, not a suggestion.",
    "- In plan assembly and plan repair stages, if downloaded external references are present in `externalReferences`, `localReferences`, or `artifacts.referenceManifest`, read their `localPath` files before assembling `artifacts.generatedSpec`, final structured `planSpec`, or final structured `interactionContract`.",
    "- In plan assembly and plan repair stages, `hardConstraints.referenceUsageValidation` is a blocking constraint, not a suggestion.",
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
    "- The generate stages must use `artifacts.interactionContract` to implement critical controls, fallback triggers, visible empty/error states, and external API operation details.",
    "- In generate and generate repair stages, prefer using `task` to launch bounded child agents when frontend, backend, and verification slices can run in parallel with clear non-overlapping ownership.",
    "- When using subagents, give each subagent the validated `planSpec`/interaction contract context, exact file or responsibility scope, no-shell-validation boundary, and required final handoff format; the main agent remains responsible for merging, conflict resolution, todo updates, and the final structured response.",
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
      case "plan_analysis":
        return "PRD Analysis Stage";
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
