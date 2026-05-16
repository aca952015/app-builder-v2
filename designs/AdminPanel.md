# Design.md — Dashboard UI Style Guide

## Overview
This design system is based on a modern admin dashboard interface (like Gentellela Alela) and adapts principles from Notion's brand system for consistency and clarity. The system focuses on clear hierarchy, color-coded data, and clean card-based layout.

**Key Characteristics:**
- Side navigation with collapsible menus
- Top navigation for profile and notifications
- Multi-panel content area with cards for stats, charts, lists
- Card-based layout with depth and subtle shadows
- Consistent spacing and typography hierarchy

---

## Colors

### Brand & Semantic
| Token | Color | Use |
|---|---|---|
| `{colors.primary}` | #1ABB9C | Primary CTA (buttons, key highlights) |
| `{colors.secondary}` | #34495E | Sidebar background |
| `{colors.accent-blue}` | #3498DB | Charts and links |
| `{colors.success}` | #2ECC71 | Positive metrics |
| `{colors.warning}` | #F1C40F | Warnings, alerts |
| `{colors.error}` | #E74C3C | Negative metrics |
| `{colors.surface}` | #FFFFFF | Cards, content background |
| `{colors.surface-soft}` | #F6F6F6 | Section background |
| `{colors.text-primary}` | #333333 | Main text |
| `{colors.text-secondary}` | #777777 | Secondary text, labels |
| `{colors.border}` | #E0E0E0 | Card and input borders |

---

## Typography

| Token | Size | Weight | Line Height | Use |
|---|---|---|---|---|
| `{typography.hero}` | 48px | 600 | 1.1 | Dashboard headline |
| `{typography.heading-1}` | 36px | 600 | 1.2 | Section headers |
| `{typography.heading-2}` | 28px | 600 | 1.25 | Card titles |
| `{typography.body-md}` | 16px | 400 | 1.5 | Body text |
| `{typography.body-sm}` | 14px | 400 | 1.4 | Secondary text |
| `{typography.caption}` | 12px | 400 | 1.3 | Labels, captions |

**Principles:**
- Clear hierarchy from dashboard header → section → card → list
- Use bold for numeric stats and key metrics
- Maintain readability with 1.5 line-height for body text

---

## Layout

### Grid & Spacing
- **Base unit**: 8px
- **Container width**: 1200px max-width
- **Gutter**: 24px between cards
- **Sections**: Top metrics → charts → tables → to-do lists / maps
- **Sidebar**: Fixed width 240px, collapsible

### Spacing Tokens
| Token | Value |
|---|---|
| `{spacing.xs}` | 4px |
| `{spacing.sm}` | 8px |
| `{spacing.md}` | 16px |
| `{spacing.lg}` | 24px |
| `{spacing.xl}` | 32px |
| `{spacing.section}` | 64px |

---

## Elevation & Shadows
| Level | Shadow | Use |
|---|---|---|
| 0 | none | Flat cards, tables |
| 1 | 0 1px 2px rgba(0,0,0,0.05) | Hover tiles |
| 2 | 0 4px 12px rgba(0,0,0,0.08) | Feature cards |
| 3 | 0 24px 48px rgba(0,0,0,0.2) | Dashboard hero cards / highlighted stats |

---

## Shapes

| Token | Value | Use |
|---|---|---|
| `{rounded.sm}` | 4px | Badges, small inputs |
| `{rounded.md}` | 8px | Buttons, inputs |
| `{rounded.lg}` | 12px | Cards, containers |
| `{rounded.full}` | 9999px | Pills, status badges |

---

## Components

### Buttons
- **Primary Button**: `{colors.primary}` background, white text, `{rounded.md}`, padding `10px 20px`
- **Secondary Button**: White background, `{colors.primary}` text, border `1px solid {colors.primary}`
- **Ghost Button**: Transparent background, `{colors.text-primary}` text

### Cards
- **Stat Card**: Rounded `{rounded.lg}`, subtle shadow, padding `{spacing.lg}`
- **Chart Card**: Background `{colors.surface}`, shadow level 2, contains title + chart
- **List Card**: Scrollable, `{spacing.md}` padding, border-bottom for items

### Inputs
- Text input: `{colors.surface}`, border `1px solid {colors.border}`, rounded `{rounded.md}`, height 44px
- Search pill: `{colors.surface-soft}`, rounded `{rounded.full}`, padding `8px 16px`

### Tabs
- Active tab: Bold text, underline with `{colors.primary}`
- Inactive tab: `{colors.text-secondary}`

### Badges
- Success: `{colors.success}`, white text, rounded `{rounded.full}`
- Warning: `{colors.warning}`, black text
- Error: `{colors.error}`, white text
- Status: Small circular pill with color indicator

---

## Charts & Data Visualization

- Use `{colors.accent-blue}` for line charts, `{colors.success}` and `{colors.error}` for bars
- Pie charts: Max 5 segments, use distinct brand/accent colors
- Axis labels: `{typography.body-sm}`, color `{colors.text-secondary}`

---

## Responsive Behavior

| Breakpoint | Layout Changes |
|---|---|
| Mobile (<480px) | Sidebar collapses, cards stacked 1-column, buttons full-width |
| Tablet (480–1024px) | Sidebar collapses, cards 2-column |
| Desktop (>1024px) | Full layout, 3–4 column cards, top metrics row horizontal |

---

## Example Card Mapping

| Card | Component Type | Notes |
|---|---|---|
| Total Users | Stat Card | Green for increase, red for decrease |
| Network Activities | Chart Card | Area chart with overlay, gradient fill |
| App Versions | Chart Card | Horizontal bar chart, sorted descending |
| Device Usage | Pie Chart | Top 5 devices, % labels |
| Visitors Location | Map Card | Country highlight, heat-map style |
| To Do List | List Card | Checkbox, vertical scroll |
| Daily Active Users | Stat Card | Includes weather icon and location |

---

## Do’s and Don’ts

**Do:**
- Maintain clean card spacing and visual rhythm
- Use consistent brand colors for metrics
- Highlight key metrics with color and elevation
- Use rounded cards and buttons consistently

**Don’t:**
- Mix too many primary colors for body text
- Overcrowd charts with excessive data series
- Use heavy shadows on minor cards
- Ignore responsive layout for mobile users
