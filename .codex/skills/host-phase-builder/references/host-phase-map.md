# Host Phase Map

## Core Files

- `src/lib/generator.ts`
  Host state machine for `plan -> plan_repair -> generate -> generate_repair -> complete`
- `src/lib/text-generator.ts`
  DeepAgents runtime wrapper, stream summarization, and workflow event bridging
- `src/lib/terminal-ui.ts`
  Ink-based workflow board, logs, and plain-text fallback
- `src/lib/types.ts`
  Runtime and generation contracts
- `src/lib/plan-spec.ts`
  Structured plan schema and validation

## Template Surfaces

- `templates/full-stack/template.json`
  Declares prompt paths, references, and template-local skills
- `templates/full-stack/prompts/plan-system-prompt.md`
- `templates/full-stack/prompts/plan-repair-system-prompt.md`
- `templates/full-stack/prompts/generate-system-prompt.md`
- `templates/full-stack/prompts/generate-repair-system-prompt.md`

## Test Surfaces

- `tests/env.test.ts`
  Terminal UI, stream mode parsing, trace formatting, utility behavior
- `tests/generator.test.ts`
  Host orchestration, retries, artifacts, gating, template staging

## New Phase Creation Pattern

When creating a new host phase:

1. Add phase naming and ordering.
2. Add runtime fields and artifact paths.
3. Add prompt/template wiring if the phase is model-driven.
4. Add host execution and retry logic.
5. Add validation and completion gates.
6. Add stage-flow and progress UI changes.
7. Add tests.

## Existing Sequencing Reference

Current host workflow is:

- `plan`
- optional `plan_repair`
- `generate`
- optional `generate_repair`
- `complete`

When inserting a new phase, decide whether it belongs:

- before `generate`
- between `generate` and `complete`
- as a post-completion reporting lane

## Questions To Answer Before Coding

- What artifact marks this phase as complete?
- Does the phase need a repair lane?
- Is validation host-side or model-side?
- Should the phase be visible in terminal UI?
- Does the phase need template prompt support?
