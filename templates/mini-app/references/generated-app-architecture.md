# Mini-App Starter Architecture

This document describes the real starter structure used by the `mini-app` template.

The starter is intentionally small:

- Next.js App Router
- A single global layout in `app/layout.tsx`
- A home entry in `app/page.tsx`
- Minimal shared styling in `app/globals.css`
- REST-style route handlers under `app/api/**`

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
