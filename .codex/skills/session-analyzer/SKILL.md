---
name: session-analyzer
description: Analyze an app-builder-v2 generation session to report wall-clock timing, retry patterns, repair root causes, and final validation status. Use after a generate run completes or fails to understand bottlenecks.
---

# Session Analyzer

## Objective

Analyze a `.out/<sessionId>/` generation session and produce a structured report covering:

1. **Wall-clock timing per phase** — not summed durations, but actual elapsed time
2. **Retry/repair patterns** — how many attempts, which phases failed
3. **Root causes** — why repairs were triggered (from `error.log`)
4. **Final validation status** — whether the app passed runtime validation
5. **Env consistency** — whether `.env` and `.env.example` match

## Usage

```bash
node .codex/skills/session-analyzer/analyze.mjs <session-id-prefix>
```

Example:
```bash
node .codex/skills/session-analyzer/analyze.mjs ef1dd18d
```

The script auto-resolves the full UUID directory under `.out/`.

## Output

The script prints a markdown-friendly report to stdout, including:

- Session timeline (first event → last event)
- Phase breakdown with wall-clock times, event counts, failure counts
- Repair attempt timeline with durations
- Extracted error reasons grouped by attempt
- Final validation result (install / db:init / typecheck / dev)
- `.env` vs `.env.example` diff (if any)

## When to Use

- After `generate` finishes to review efficiency
- After `generate` fails to identify the bottleneck phase
- When comparing two sessions (e.g. before/after a prompt or host fix)
- During CI to surface slow phases in build logs
