# Mini-App Template Pack

This template targets a lightweight Next.js App Router application with a minimal shell.

Workflow:

- The host runs `prompts/plan-system-prompt.md` to produce `plan-spec.json`.
- If plan validation fails, the host runs `prompts/plan-repair-system-prompt.md`.
- After plan validation succeeds, the host runs `prompts/generate-system-prompt.md`.
- If generation validation fails, the host runs `prompts/generate-repair-system-prompt.md`.

Starter characteristics:

- Minimal Next.js App Router shell
- No database bootstrap
- REST-style route handlers under `app/api/**`
- Runtime validation only requires `.env`, `pnpm install`, and `pnpm dev`
