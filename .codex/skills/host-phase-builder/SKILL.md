---
name: host-phase-builder
description: Create and wire a brand-new host-side workflow phase in app-builder-v2, such as adding a deploy phase after generate. Use when the host program needs an extra staged lane with its own prompts, artifacts, validation, retries, state transitions, and UI updates.
---

# Host Phase Builder

## Objective

Create a new host-side workflow phase in `app-builder-v2`.

Typical examples:

- add a `deploy` phase after `generate`
- add a `post_generate_validation` phase before `complete`
- add a new repair lane for a future phase

This skill is for changes such as:

- introducing a new phase name and transition
- defining the new phase's input/output contract
- deciding whether it has repair / retry behavior
- adding prompt entry points and template wiring if model-driven
- adding host-side validation and artifact gates
- exposing the phase in terminal UI, logs, and tests

This skill is not for adding product features to generated apps.

## Read First

- `src/lib/generator.ts`
- `src/lib/text-generator.ts`
- `src/lib/terminal-ui.ts`
- `src/lib/types.ts`
- `src/lib/plan-spec.ts`
- `templates/full-stack/template.json`
- relevant prompt files under `templates/full-stack/prompts/`
- `tests/env.test.ts`
- `tests/generator.test.ts`

For a quick map, read `references/host-phase-map.md`.

## Workflow

1. Name the new phase and place it in the host sequence.
2. Decide whether the phase is:
   - host-only
   - model-driven
   - repairable / retryable
   - gated by explicit validation
3. Trace the full surface before editing:
   - runtime/types
   - generator state machine
   - output workspace / artifact paths
   - template prompt registry
   - terminal UI stage flow and logs
   - tests
4. Add the phase contract first, then wire execution, then wire validation, then wire UI, then tests.
5. Run `pnpm check`.

## Guardrails

- Do not insert a new phase without deciding its gate, completion condition, and failure behavior.
- Do not bypass existing host gates just to thread a new phase in quickly.
- Do not hide a new phase inside prompt text only; it must be explicit in host orchestration.
- Prefer explicit artifact and validation contracts over informal narrative state.
- If the new phase is user-visible, update terminal UI and workflow logs.
- If the new phase affects sequencing or retries, update generator tests.

## Build Checklist For A New Phase

For a new phase such as `deploy`, walk this list in order.

1. Define the phase model
   - add the phase name where host workflow phases are enumerated
   - add runtime fields if the phase needs attempts, retry reasons, or artifacts

2. Wire workspace and artifacts
   - add output paths in `src/lib/output-workspace.ts` if the phase writes new artifacts
   - add config entries in `.deepagents/config.json` generation if needed

3. Wire template surface
   - add prompt entries in `templates/full-stack/template.json` if the phase is model-driven
   - add corresponding prompt files under `templates/full-stack/prompts/`

4. Wire host orchestration
   - insert the phase into `src/lib/generator.ts`
   - define entry condition
   - define success condition
   - define retry / repair loop if needed
   - define failure message

5. Wire validation
   - add host-side validation for the new phase output
   - write validation result artifacts if the phase needs a durable record

6. Wire terminal UI
   - add the new phase to the stage flow in `src/lib/terminal-ui.ts`
   - add or adjust artifact panels and logs if the phase is visible

7. Wire tests
   - update `tests/generator.test.ts` for sequencing, retries, artifacts, and completion
   - update `tests/env.test.ts` if stage flow or user-visible UI changes

## Common File Map For New Phase Work

- add phase sequencing:
  `src/lib/generator.ts`, `src/lib/types.ts`
- add phase artifacts:
  `src/lib/output-workspace.ts`, `src/lib/types.ts`
- add model-driven phase prompt:
  `templates/full-stack/template.json`, `templates/full-stack/prompts/*.md`, `src/lib/template-pack.ts`
- add visible phase in terminal:
  `src/lib/terminal-ui.ts`, `src/lib/text-generator.ts`
- add validation:
  `src/lib/generator.ts`, possible new helper functions, tests

## Example: Adding A Deploy Phase

If the user wants a deploy phase after generate:

1. Add `deploy` and optional `deploy_repair` to the host workflow sequence.
2. Decide whether deploy is:
   - a model-driven instruction phase
   - a deterministic host shell/integration phase
3. Add deploy artifacts such as:
   - `.deepagents/deploy-report.md`
   - `.deepagents/deploy-validation.json`
4. Add a deploy gate in `generator.ts` after generate succeeds.
5. Add deploy validation before `complete`.
6. Extend terminal UI stage flow from:
   - `计划阶段 -> 生成阶段 -> 完成阶段`
   to:
   - `计划阶段 -> 生成阶段 -> 部署阶段 -> 完成阶段`
7. Add tests for:
   - generate succeeds but deploy fails
   - deploy repair path
   - complete only after deploy validation passes

## Completion

Before finishing, confirm:

- the new phase is explicit in host orchestration
- entry and exit conditions are defined
- validation and retry behavior are explicit
- prompts/artifacts/types are aligned
- UI stage flow matches real sequencing
- tests cover the new phase
- `pnpm check` passes
