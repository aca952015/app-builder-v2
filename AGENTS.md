# app-builder-v2 Workspace Guidance

## Scope

This file applies to the whole repository.

## Intent

- This repository is the host/orchestrator for staged app generation.
- Treat host workflow logic, prompt contracts, validation gates, and terminal UX as first-class code.
- Keep the split between host orchestration and template execution explicit.

## Host Phase Boundaries

- Host-side phase orchestration lives primarily in `src/lib/generator.ts`.
- DeepAgents runtime wiring and event summarization live in `src/lib/text-generator.ts`.
- Terminal progress rendering lives in `src/lib/terminal-ui.ts`.
- Shared phase/runtime contracts live in `src/lib/types.ts` and `src/lib/plan-spec.ts`.
- Template prompts and template-local skills live under `templates/full-stack/`.

When changing plan/generate/repair behavior:

1. Preserve host-controlled gating.
2. Do not let code generation proceed before host validation passes.
3. Keep prompt changes, runtime changes, and validation changes aligned.
4. Update tests for both success and retry paths.

## Skills

- When adding a brand-new host-side phase to the workflow, for example a deploy phase after generate, use the project skill `host-phase-builder` from `.codex/skills/host-phase-builder/`.
- This skill is specifically for creating and wiring a new phase into the host orchestrator, not for general feature edits inside an existing phase.

## Ignored Inputs

- Ignore files under `prds/` by default. Treat them as user-supplied source documents, not repository code.
- Do not lint, format, clean up, or edit `prds/` files unless the user explicitly asks for changes there.

## Validation

- Run `pnpm check` after host workflow changes.
- If terminal UI behavior changes, keep `tests/env.test.ts` aligned.
