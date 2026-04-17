# Mini-App Starter Architecture

This document describes the real starter structure used by the `mini-app` template.

The starter is intentionally small:

- Next.js App Router
- A single global layout in `app/layout.tsx`
- A home entry in `app/page.tsx`
- Minimal shared styling in `app/globals.css`
- REST-style route handlers under `app/api/**`
- TypeScript typecheck via `pnpm typecheck`

Current starter files:

```text
app/
  api/
    health/
      route.ts
  globals.css
  layout.tsx
  page.tsx
.env.example
next-env.d.ts
next.config.ts
package.json
tsconfig.json
```

Implementation constraints:

- Keep generated pages under `app/**/page.tsx`.
- Keep generated APIs under `app/api/**/route.ts`.
- Prefer extending the existing shell instead of replacing the whole starter.
- Do not introduce a database layer unless the plan explicitly requires one and the template contract is updated.

API path constraints:

- Server route files live on disk at `app/api/**/route.ts`.
- Frontend code must call those handlers through HTTP paths under `/api/**`.
- Do not prefix frontend fetch/XHR URLs with `/app/api/**`.
- Example:
  - File path: `app/api/weather/current/route.ts`
  - Browser/server fetch URL: `/api/weather/current`
- Keep file-system paths and runtime request paths distinct. `app/` is part of the source tree layout, not part of the public API URL.

TypeScript and path-alias constraints:

- `tsconfig.json` defines `baseUrl: "."` and `@/* -> ./*`.
- This means `@/foo` resolves from the project root, not from `app/`.
- If you create shared modules that are imported as `@/lib/*` or `@/types/*`, those files must live at project-root `lib/*` and `types/*`.
- If you instead place shared files under `app/lib/*` or `app/types/*`, do not import them as `@/lib/*` or `@/types/*` unless you also update `tsconfig.json` consistently.
- Do not mix these two models in one generated app. Keep import paths, file locations, and `tsconfig.json` aligned.
- Runtime validation now includes `pnpm typecheck`, so import aliases and shared-type paths must pass `tsc --noEmit`, not just `pnpm dev`.
