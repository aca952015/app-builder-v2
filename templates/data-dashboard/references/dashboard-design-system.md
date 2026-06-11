# Data Dashboard Design System

The template uses a dark, high-contrast command-center visual system.

## Layout

- Fullscreen frame with a 16:9-safe composition for large screens.
- Responsive grid that degrades gracefully on laptop and narrow browser widths.
- Header area for audience, objective, refresh cadence, and status timestamp.
- KPI card row for headline metrics.
- Main chart region for time-series, distribution, ranking, and gauge panels.
- Optional ticker/status strip for realtime narrative.

## Visual style

- Dark navy/black background with subtle cyan grid lines.
- Glass panels with soft borders and restrained glow.
- Accent palette: cyan, teal, emerald, amber, violet.
- Avoid low-contrast text. Dashboard labels must remain legible from a distance.

## Chart rules

- Use ECharts through the shared wrapper/theme instead of creating ad hoc chart bootstrapping in each page.
- Every chart panel needs a clear title and either a subtitle, legend, label, or tooltip that explains the data.
- Mock data must be deterministic. Avoid `Math.random()` for display values or acceptance-critical chart series.
- Prefer stable data modules (`data/**`) and data-parameterized option builders (`lib/chart-theme.ts`) so generated apps can swap data sources without rewriting layout or theme helpers.

## Data states

For each critical dashboard panel, represent the expected loading, empty, and error state in the plan and interaction contract. Use `ChartPanel` status props/slots for these states before adding one-off panel wrappers. If the first version uses mock data, state that live refresh is simulated by deterministic fixtures unless PRD-backed APIs are present.
