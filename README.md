# app-builder-v2

`app-builder-v2` is a TypeScript CLI that reads a Markdown product spec and generates a runnable application scaffold. The model orchestration layer is powered by Pi Agent, and the generation context is selected from template packs under `templates/`.

Each template pack can provide its own phase-specific prompts, references, optional skills, and starter assets. The selected template is copied into the output project's `.workspace/` directory so the generated app keeps the exact context that produced it. The default generation path now uses a host-controlled workflow with dedicated repair lanes: plan, optional plan-repair, generate, and optional generate-repair.

## Usage

```bash
pnpm install
pnpm build
node dist/src/index.js generate ./spec.md --template full-stack
node dist/src/index.js generate ./spec.md --template mini-app --design ./designs/Spotify.md
node dist/src/index.js generate ./spec.md --generation-requirements "菜单需要固定侧边栏，内容区独立滚动。"
```

`--design` is optional. When omitted, no design Markdown is copied into the generated workspace.
`--generation-requirements` is optional. When provided, the text is appended after the PRD as the user's additional generation requirements.

Environment variables:

- `.env`: loaded automatically from the project root when the CLI starts.
- `APP_BUILDER_API_KEY`: required for the default generation path unless every model role has its own API key or provider-native credentials.
- `APP_BUILDER_BASE_URL`: optional API base URL fallback for every model role. Useful for proxy or compatible endpoints.
- `APP_BUILDER_USER_AGENT`: optional truthful `User-Agent` header fallback for every model role.
- `APP_BUILDER_PROTOCOL`: optional model protocol fallback for every model role. Supported values are `openai`, `anthropic`, and `google`; `gemini` is accepted as an alias for `google`. Defaults to `openai`.
- `APP_BUILDER_MODEL`: optional model fallback for every role. Defaults to `openai:gpt-4.1-mini`.
- `APP_BUILDER_PI_MODELS_JSON`: optional path to a Pi `models.json` file for custom provider/model metadata. When omitted, app-builder automatically registers a missing current model ID from `APP_BUILDER_MODEL` using the selected protocol defaults.
- `APP_BUILDER_PLAN_MODEL`, `APP_BUILDER_GENERATE_MODEL`, `APP_BUILDER_REPAIR_MODEL`: optional model overrides for the planning, generation, and repair roles.
- `APP_BUILDER_PLAN_BASE_URL`, `APP_BUILDER_GENERATE_BASE_URL`, `APP_BUILDER_REPAIR_BASE_URL`: optional role-specific compatible endpoint overrides.
- `APP_BUILDER_PLAN_USER_AGENT`, `APP_BUILDER_GENERATE_USER_AGENT`, `APP_BUILDER_REPAIR_USER_AGENT`: optional role-specific truthful `User-Agent` header overrides.
- `APP_BUILDER_PLAN_PROTOCOL`, `APP_BUILDER_GENERATE_PROTOCOL`, `APP_BUILDER_REPAIR_PROTOCOL`: optional role-specific protocol overrides.
- `APP_BUILDER_PLAN_API_KEY`, `APP_BUILDER_GENERATE_API_KEY`, `APP_BUILDER_REPAIR_API_KEY`: optional role-specific API keys. The repair role is used for both plan repair and generation repair.
- `APP_BUILDER_STDOUT`: optional TTY stdout renderer override. Use `dashboard` for the interactive dashboard or `log` for line-by-line log output.

Example `.env`:

```bash
APP_BUILDER_API_KEY=your-openai-api-key
APP_BUILDER_BASE_URL=https://api.openai.com/v1
APP_BUILDER_MODEL=openai:gpt-4.1-mini
# Optional role overrides:
# APP_BUILDER_PLAN_MODEL=openai:gpt-5.4
# APP_BUILDER_GENERATE_MODEL=openai:gpt-4.1-mini
# APP_BUILDER_REPAIR_MODEL=openai:gpt-5.4
APP_BUILDER_STDOUT=log
```

Gemini example:

```bash
APP_BUILDER_PROTOCOL=google
APP_BUILDER_MODEL=google:gemini-2.5-flash
GOOGLE_API_KEY=your-google-api-key
# Optional role overrides:
# APP_BUILDER_PLAN_MODEL=google:gemini-2.5-pro
# APP_BUILDER_GENERATE_MODEL=google:gemini-2.5-flash
# APP_BUILDER_REPAIR_MODEL=google:gemini-2.5-flash
```

Custom Pi model ID example for a Google-compatible gateway:

```bash
APP_BUILDER_PROTOCOL=google
APP_BUILDER_MODEL=google:gemini-3-flash-agent
APP_BUILDER_BASE_URL=https://proxy.example/google/v1beta
GOOGLE_API_KEY=your-gateway-key
```

If `APP_BUILDER_PI_MODELS_JSON` is not set and Pi does not know `gemini-3-flash-agent`, app-builder dynamically registers it under the `google` provider using the Google Generative AI protocol and your configured base URL/API key.

Set `APP_BUILDER_PI_MODELS_JSON=/absolute/path/to/pi-models.json` only when you need explicit model metadata. The file can extend the built-in `google` provider:

```json
{
  "providers": {
    "google": {
      "models": [
        {
          "id": "gemini-3-flash-agent",
          "name": "Gemini 3 Flash Agent",
          "api": "google-generative-ai",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1048576,
          "maxTokens": 65536,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Each run creates a session directory under `.out/<sessionId>/`. Pi Agent writes the application files into that session directory, while `.workspace/` stores the template context, phase prompts, plan artifacts, and generation logs. The generator will not enter code generation until `.workspace/plan-spec.json` passes host validation.

## What it generates

- Template-selected application scaffold
- `Prisma` schema with email/password auth user model for the `full-stack` template
- Dashboard, settings, login, and per-entity CRUD pages for the `full-stack` template
- Seed data and `.env.example`
- Generation report with defaults and warnings
- A copied `.workspace/` template context plus `template-lock.json`
- Visible generation artifacts such as `.workspace/source-prd.md`, `.workspace/prd-analysis.md`, `.workspace/generated-spec.md`, `.workspace/plan-spec.json`, `.workspace/plan-validation.json`, and `.workspace/error.log`

## Template packs

Template packs live under `templates/<templateId>/` and currently include:

- `template.json`: template metadata and entry points
- `prompts/`: template-specific Pi Agent prompts
- `references/`: architecture and design references copied into the output workspace
- `skills/`: optional template-scoped skills
- `starter/`: optional template-scoped starter files

## Validation

```bash
pnpm check
```
