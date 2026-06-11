# Data Dashboard Template

`data-dashboard` is a frontend-first template for generating full-screen data dashboards from PRDs.

Use it when the target app is a visual operations screen, command-center view, executive KPI wall, monitoring board, or any other large-format dashboard.

```sh
app-builder generate prds/dashboard.md --template data-dashboard
```

## Scope

- Next.js App Router + React + TypeScript.
- ECharts-powered chart panels with a shared theme wrapper.
- Deterministic mock/config data by default.
- Fullscreen dark/glass visual system with responsive 16:9-safe layout.
- No default database, Prisma, authentication, route handlers, or backend platform shell.

Choose `full-stack` instead when the PRD requires durable persistence, authentication, admin CRUD, or a backend-heavy workflow. Choose `mini-app` for small utility apps that are not primarily data visualization screens.

## Data conventions

The starter keeps replaceable sample data in `data/mock-dashboard.ts`. Generated apps should keep demo fixtures deterministic unless the PRD explicitly requires live data. When external APIs are required, the planning phase must preserve reference evidence in `planSpec.references` and `interactionContract.externalOperations`.

## Runtime validation

The template runtime validation intentionally runs only:

1. `pnpm install`
2. `pnpm typecheck`
3. `pnpm dev`

There is no `pnpm db:init` step because the first version is frontend-only.
