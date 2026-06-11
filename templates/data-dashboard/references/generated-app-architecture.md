# Data Dashboard Starter Architecture

This document describes the real starter structure used by the `data-dashboard` template.

The starter is intentionally frontend-first:

- Next.js App Router
- A single global layout in `app/layout.tsx`
- A dashboard entry in `app/page.tsx`
- Shared dashboard components under `components/dashboard/**`
- Deterministic mock/config data in `data/mock-dashboard.ts`
- Data-parameterized ECharts option builders in `lib/chart-theme.ts`
- Minimal shared formatting helpers in `lib/format.ts`
- TypeScript typecheck via `pnpm typecheck`

Current starter files:

```text
app/
  globals.css
  layout.tsx
  page.tsx
components/
  dashboard/
    ChartPanel.tsx
    DashboardShell.tsx
    DataTicker.tsx
    EChartsPanel.tsx
    FullscreenFrame.tsx
    MetricCard.tsx
    RankingList.tsx
data/
  mock-dashboard.ts
lib/
  chart-theme.ts
  format.ts
.env.example
next-env.d.ts
next.config.ts
package.json
postcss.config.js
tsconfig.json
```

Implementation constraints:

- Keep generated dashboard pages under `app/**/page.tsx`.
- Prefer extending the existing dashboard shell instead of replacing the whole starter.
- Use `components/dashboard/EChartsPanel.tsx` for ECharts rendering. It is a client component and dynamically imports `echarts` inside effects to avoid SSR/window failures.
- Keep chart option construction deterministic and data-parameterized. Do not use `Math.random()` for KPI values, chart series, rankings, refresh status, or acceptance-critical display data.
- Keep replaceable demo data in `data/**` or a similarly named module. Do not scatter hard-coded business statistics across page components.
- Use `ChartPanel` status props for loading, empty, and error panel states before forking panel chrome.
- Do not introduce a database layer, Prisma, authentication, or backend route handlers unless `planSpec` explicitly requires them.
- Treat `next.config.ts` as a protected project configuration file. It can only be edited when `planSpec.projectConfigChanges` explicitly cites PRD evidence for a project/Next.js configuration change.
- Fullscreen dashboard layout must remain responsive: preserve a large-screen command-center composition while still fitting common laptop/browser viewports.

Data and API conventions:

- If the PRD does not require live data, use deterministic mock/config data and clearly label assumptions in generated docs/reporting.
- If the PRD requires external APIs, planning must capture reference evidence in `planSpec.references` and `interactionContract.externalOperations` before generation connects the UI.
- If route handlers are introduced for PRD-backed APIs, keep file-system paths (`app/api/**/route.ts`) distinct from browser URLs (`/api/**`).

TypeScript and path-alias constraints:

- `tsconfig.json` defines `baseUrl: "."` and `@/* -> ./*`.
- Shared modules imported as `@/components/*`, `@/data/*`, or `@/lib/*` must live at project-root `components/*`, `data/*`, and `lib/*`.
- Runtime validation includes `pnpm typecheck`, so import aliases, client/server component boundaries, and ECharts option types must pass `tsc --noEmit`.
