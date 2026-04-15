# app-builder-v2

`app-builder-v2` is a TypeScript CLI that reads a Markdown product spec and generates a runnable application scaffold. The model orchestration layer is powered by `deepagents`, and the generation context is selected from template packs under `templates/`.

Each template pack can provide its own phase-specific prompts, references, optional skills, and starter assets. The selected template is copied into the output project's `.deepagents/` directory so the generated app keeps the exact context that produced it. The default generation path now uses a host-controlled workflow with dedicated repair lanes: plan, optional plan-repair, generate, and optional generate-repair.

## Usage

```bash
npm install
npm run build
node dist/src/index.js generate ./spec.md --template full-stack
```

Environment variables:

- `.env`: loaded automatically from the project root when the CLI starts.
- `OPENAI_API_KEY`: required for the default generation path.
- `OPENAI_BASE_URL`: optional API base URL override. Useful for proxy or compatible endpoints.
- `APP_BUILDER_MODEL`: optional model override. Defaults to `openai:gpt-4.1-mini`.
- `APP_BUILDER_STREAM_MODES`: optional deepagents stream mode list, comma-separated. Defaults to `updates,messages,tools,values`.

Example `.env`:

```bash
OPENAI_API_KEY=your-openai-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
APP_BUILDER_MODEL=openai:gpt-4.1-mini
APP_BUILDER_STREAM_MODES=updates,messages,tools,values
```

Each run creates a session directory under `.out/<sessionId>/`. `deepagents` writes the application files into that session directory, while `.deepagents/` stores the template context, phase prompts, plan artifacts, and generation logs. The generator will not enter code generation until `.deepagents/plan-spec.json` passes host validation.

## What it generates

- Template-selected application scaffold
- `Prisma` schema with email/password auth user model for the `full-stack` template
- Dashboard, settings, login, and per-entity CRUD pages for the `full-stack` template
- Seed data and `.env.example`
- Generation report with defaults and warnings
- A copied `.deepagents/` template context plus `template-lock.json`
- Visible generation artifacts such as `.deepagents/source-prd.md`, `.deepagents/prd-analysis.md`, `.deepagents/generated-spec.md`, `.deepagents/plan-spec.json`, `.deepagents/plan-validation.json`, and `.deepagents/error.log`

## Template packs

Template packs live under `templates/<templateId>/` and currently include:

- `template.json`: template metadata and entry points
- `prompts/`: template-specific deepagents prompts
- `references/`: architecture and design references copied into the output workspace
- `skills/`: optional template-scoped skills
- `starter/`: optional template-scoped starter files

## Validation

```bash
npm run check
```
