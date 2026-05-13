# Mini-App Starter Architecture

This document describes the real starter structure used by the `mini-app` template.

The starter is intentionally small:

- Next.js App Router
- A single global layout in `app/layout.tsx`
- A home entry in `app/page.tsx`
- Minimal shared styling in `app/globals.css`
- REST-style route handlers under `app/api/**`
- Prisma + SQLite data layer (optional; only used when `planSpec` requires persistence)
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
lib/
  prisma.ts
next-env.d.ts
next.config.ts
package.json
postcss.config.js
prisma/
  schema.prisma
  seed.ts
prisma.config.ts
tsconfig.json
```

Implementation constraints:

- Keep generated pages under `app/**/page.tsx`.
- Keep generated APIs under `app/api/**/route.ts`.
- Prefer extending the existing shell instead of replacing the whole starter.
- Do not introduce a database layer unless the plan explicitly requires one.
- Treat `next.config.ts` as a protected project configuration file. It can only be edited when `planSpec.projectConfigChanges` explicitly cites PRD evidence for a project/Next.js configuration change.

Data layer conventions:

- `lib/prisma.ts` is the Prisma Client singleton export.
- `prisma/schema.prisma` is the canonical schema file; use SQLite as the datasource provider.
- `prisma.config.ts` provides the datasource URL; default is `file:./prisma/dev.db`.
- `prisma/seed.ts` is the seed entry point.
- When persistence is required, route handlers should use `lib/prisma.ts` rather than raw sqlite drivers.

Login conventions:

- When `planSpec` requires a login feature, the generated app must provide a default username and password so that the user can log in immediately.
- If the app uses database persistence, the default credentials must be seeded through `prisma/seed.ts` into the `User` model (`email: "demo@example.com"`, `passwordHash: "demo12345"`).
- If the app does not use database persistence, the default credentials must be kept in `.env` as `SYSTEM_USER_EMAIL="demo@example.com"` and `SYSTEM_USER_PASSWORD="demo12345"`, and the corresponding entries must also exist in `.env.example`.
- The login response or UI hint must surface these default credentials to the user (e.g., a helper text under the login form or a dedicated section on the login page).

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
