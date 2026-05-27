# Apple-Style Mobile Mini Program Design Specification

## Overview

This design specification defines an **Apple-inspired mobile mini program** visual system. It is intended for WeChat / Alipay / DingTalk style mini program products that need a premium, quiet, highly readable, mobile-first interface.

The visual language follows Apple's product UI spirit rather than copying any Apple product exactly: calm surfaces, precise spacing, rounded continuous geometry, system-like typography, restrained color, soft depth, strong hierarchy, and fast touch interactions.

**Key Characteristics:**
- Clean white / near-white canvas with subtle layered surfaces
- Large title hierarchy using SF-like system typography
- Soft blue as the primary interactive color
- Minimal borders, hairline dividers, and soft shadows
- 16–24px continuous rounded cards
- 44px minimum touch target for all actionable controls
- Bottom tab navigation for primary flows
- Native-feeling page transitions, sheet panels, segmented controls, list rows, and cards
- Blur / translucent surfaces used sparingly for navigation and floating actions
- Content-first layout: avoid decoration that competes with task completion

---

## Colors

### Brand & Primary

- **Apple Blue** (`{colors.primary}`): Primary action color. Use for main CTA, active tab, selected state, links.
- **Primary Pressed** (`{colors.primary-pressed}`): Pressed state for primary buttons.
- **Primary Soft** (`{colors.primary-soft}`): Light blue background for selected chips, light action cards, and badges.
- **Primary Deep** (`{colors.primary-deep}`): Strong emphasis on dark or image backgrounds.
- **Accent Purple** (`{colors.accent-purple}`): Secondary accent for intelligent / AI functions.
- **Accent Green** (`{colors.accent-green}`): Positive state, success, completed tasks.
- **Accent Orange** (`{colors.accent-orange}`): Warning, attention, pending states.
- **Accent Red** (`{colors.accent-red}`): Error, destructive action, high-risk warning.

### Surface

- **Canvas** (`{colors.canvas}`): Main app background. Usually `#F5F5F7`.
- **Surface** (`{colors.surface}`): Primary cards and list groups. Usually white.
- **Surface Elevated** (`{colors.surface-elevated}`): Floating panels, bottom sheets, popovers.
- **Surface Soft** (`{colors.surface-soft}`): Subtle grouped-section background.
- **Surface Glass** (`{colors.surface-glass}`): Translucent navigation / floating bar background.
- **Hairline** (`{colors.hairline}`): 1px / 0.5px dividers.
- **Hairline Strong** (`{colors.hairline-strong}`): Stronger borders for inputs and selected cards.

### Text

- **Ink** (`{colors.ink}`): Primary text, titles.
- **Ink Soft** (`{colors.ink-soft}`): Secondary text and descriptions.
- **Ink Muted** (`{colors.ink-muted}`): Tertiary labels, metadata.
- **Ink Disabled** (`{colors.ink-disabled}`): Disabled text.
- **On Primary** (`{colors.on-primary}`): Text on primary blue.
- **On Dark** (`{colors.on-dark}`): Text on dark media / dark cards.
- **On Glass** (`{colors.on-glass}`): Text on translucent navigation surfaces.

### Semantic

- **Success** (`{colors.semantic-success}`): Completion, confirmation, available status.
- **Warning** (`{colors.semantic-warning}`): Pending, caution, recoverable alert.
- **Error** (`{colors.semantic-error}`): Validation error, failure, destructive state.
- **Info** (`{colors.semantic-info}`): Informational notice.

### Recommended Token Values

| Token | Value | Use |
|---|---:|---|
| `{colors.primary}` | `#007AFF` | Primary action, active state |
| `{colors.primary-pressed}` | `#0066D6` | Pressed primary action |
| `{colors.primary-soft}` | `#EAF3FF` | Soft selected background |
| `{colors.canvas}` | `#F5F5F7` | App background |
| `{colors.surface}` | `#FFFFFF` | Cards, list groups |
| `{colors.surface-soft}` | `#FAFAFC` | Section background |
| `{colors.surface-elevated}` | `#FFFFFF` | Sheet, modal |
| `{colors.hairline}` | `rgba(60, 60, 67, 0.16)` | Dividers |
| `{colors.hairline-strong}` | `rgba(60, 60, 67, 0.28)` | Inputs, selected borders |
| `{colors.ink}` | `#1D1D1F` | Primary text |
| `{colors.ink-soft}` | `rgba(60, 60, 67, 0.72)` | Secondary text |
| `{colors.ink-muted}` | `rgba(60, 60, 67, 0.48)` | Metadata |
| `{colors.ink-disabled}` | `rgba(60, 60, 67, 0.28)` | Disabled |
| `{colors.semantic-success}` | `#34C759` | Success |
| `{colors.semantic-warning}` | `#FF9500` | Warning |
| `{colors.semantic-error}` | `#FF3B30` | Error |

---

## Typography

### Font Family

**System UI** (`{typography.font-family}`): Use `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", Arial, sans-serif`.

For Chinese mini programs, `PingFang SC` should be the primary Chinese fallback. Avoid decorative fonts, condensed fonts, and overly geometric web fonts that break the native iOS feeling.

### Hierarchy

| Token | Size | Weight | Line Height | Letter Spacing | Use |
|---|---:|---:|---:|---:|---|
| `{typography.large-title}` | 34px | 700 | 1.18 | -0.4px | Page hero title / dashboard title |
| `{typography.title-1}` | 28px | 700 | 1.22 | -0.3px | Page title |
| `{typography.title-2}` | 22px | 700 | 1.28 | -0.2px | Section title |
| `{typography.title-3}` | 20px | 600 | 1.30 | 0 | Card title |
| `{typography.headline}` | 17px | 600 | 1.35 | 0 | List title, emphasized row |
| `{typography.body}` | 17px | 400 | 1.45 | 0 | Primary reading text |
| `{typography.body-medium}` | 17px | 500 | 1.45 | 0 | Body emphasis |
| `{typography.callout}` | 16px | 400 | 1.42 | 0 | Secondary descriptions |
| `{typography.subheadline}` | 15px | 400 | 1.40 | 0 | List subtitles |
| `{typography.footnote}` | 13px | 400 | 1.35 | 0 | Metadata, hints |
| `{typography.caption}` | 12px | 400 | 1.30 | 0 | Captions, minor labels |
| `{typography.button}` | 17px | 600 | 1.20 | 0 | Primary buttons |
| `{typography.tab-label}` | 11px | 500 | 1.20 | 0 | Bottom tab labels |

### Principles

- Use large, confident titles at page entry; reduce size after scroll if a sticky header is needed.
- Body text should not be smaller than 15px for key content.
- Use weight rather than color to create emphasis.
- Avoid more than 3 font sizes in a single card.
- For Chinese text, keep line height slightly more generous than English.
- Do not use all-caps labels except for very small system tags.

---

## Layout

### Spacing System

- **Base unit**: 4px
- **Primary rhythm**: 8px
- **Page horizontal padding**: 16px
- **Card inner padding**: 16px / 20px
- **Section gap**: 24px
- **Dense row gap**: 8px
- **Large hero gap**: 32px

| Token | Value | Use |
|---|---:|---|
| `{spacing.xxxs}` | 2px | Icon / text optical adjustment |
| `{spacing.xxs}` | 4px | Tight label spacing |
| `{spacing.xs}` | 8px | Row inner gap |
| `{spacing.sm}` | 12px | Compact card gap |
| `{spacing.md}` | 16px | Page padding, card padding |
| `{spacing.lg}` | 20px | Card large padding |
| `{spacing.xl}` | 24px | Section spacing |
| `{spacing.xxl}` | 32px | Hero spacing |
| `{spacing.xxxl}` | 40px | Major page separation |

### Grid & Container

- Design for **375px width** first.
- Main content uses 16px side gutters.
- Cards should span full content width unless they are quick-action tiles.
- Two-column tile layout uses 8–12px gap.
- Avoid 3-column text-heavy layouts on phones.
- Keep bottom safe area for mini program system bars and OS gesture area.

### Page Structure

Common page composition:

1. **Status / Mini Program system bar**
2. **Navigation bar**
3. **Large page title or compact title**
4. **Primary content group**
5. **Secondary content groups**
6. **Bottom tab bar or floating CTA**
7. **Safe-area spacer**

### Whitespace Philosophy

Apple-style mini program interfaces should feel spacious but not empty. Use whitespace to separate meaning, not to create marketing drama. In task-heavy pages, prioritize grouped lists and compact cards; in dashboard pages, use large top summary cards and progressive disclosure.

---

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0 Flat | No shadow, optional hairline divider | List rows, section separators |
| 1 Subtle | `0 1px 2px rgba(0,0,0,0.04)` | Small cards |
| 2 Card | `0 4px 12px rgba(0,0,0,0.06)` | Dashboard cards, selected tiles |
| 3 Floating | `0 12px 32px rgba(0,0,0,0.12)` | Bottom sheet, floating panel |
| 4 Modal | `0 24px 64px rgba(0,0,0,0.18)` | Dialog / modal overlay |

### Depth Principles

- Prefer borders and surface contrast over heavy shadows.
- Use shadow only when an object floats above content.
- Use blur material only for navigation bars, tab bars, and floating controls.
- Do not stack multiple heavy shadows on one screen.

---

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---:|---|
| `{rounded.xs}` | 6px | Small labels |
| `{rounded.sm}` | 8px | Small controls |
| `{rounded.md}` | 12px | Inputs, buttons |
| `{rounded.lg}` | 16px | Standard cards |
| `{rounded.xl}` | 20px | Large cards, panels |
| `{rounded.xxl}` | 24px | Bottom sheets, hero cards |
| `{rounded.full}` | 9999px | Pills, avatars, toggles |

### Geometry Principles

- Cards use 16–20px radius.
- Bottom sheets use 24px top-left / top-right radius.
- Buttons can be 12px radius or full pill depending on context.
- Avoid sharp 4px SaaS-style rectangles.
- Avoid overly bubbly shapes that make the UI look childish.

---

## Components

> Hover states are not documented because mini program interactions are touch-first.

### Buttons

**`button-primary`** — Main action button.
- Background `{colors.primary}`, text `{colors.on-primary}`, typography `{typography.button}`, height `50px`, rounded `{rounded.md}`.
- Pressed: background `{colors.primary-pressed}`, scale `0.98`.
- Disabled: background `{colors.hairline}`, text `{colors.ink-disabled}`.

**`button-secondary`** — Secondary action.
- Background `{colors.surface}`, text `{colors.primary}`, border `1px solid {colors.hairline}`, height `50px`, rounded `{rounded.md}`.

**`button-ghost`** — Low-emphasis action.
- Background transparent, text `{colors.primary}`, height `44px`, padding `0 {spacing.md}`.

**`button-destructive`** — Destructive action.
- Background `{colors.semantic-error}`, text `{colors.on-primary}`, height `50px`, rounded `{rounded.md}`.

**`button-link`** — Inline action.
- Background transparent, text `{colors.primary}`, typography `{typography.body-medium}`, padding `0`.

**`floating-cta`** — Bottom floating action.
- Background `{colors.primary}`, text `{colors.on-primary}`, height `54px`, rounded `{rounded.full}`, shadow Level 3.
- Positioned above bottom safe area with 16px side margins.

### Navigation

**`nav-bar-large`** — Large title navigation.
- Background `{colors.canvas}` or `{colors.surface-glass}` when sticky.
- Height `96–112px` including safe area.
- Title uses `{typography.large-title}`.
- Right actions use 28px icons with 44px hit area.

**`nav-bar-compact`** — Compact top navigation.
- Background `{colors.surface-glass}`, backdrop blur `20px`.
- Height `44px` plus safe area.
- Title uses `{typography.headline}` centered or left-aligned depending on page.

**`bottom-tab-bar`** — Primary app navigation.
- Background `{colors.surface-glass}`, backdrop blur `24px`.
- Height `56px` plus bottom safe area.
- Active icon/text `{colors.primary}`.
- Inactive icon/text `{colors.ink-muted}`.
- Max 5 tabs; recommended 3–4 tabs.

**`segmented-control`** — Top-level mode switch.
- Container background `{colors.canvas}`, rounded `{rounded.full}`, padding `2px`.
- Active segment background `{colors.surface}`, shadow Level 1, text `{colors.ink}`.
- Inactive segment text `{colors.ink-soft}`.

### Cards & Containers

**`card-base`** — Standard content card.
- Background `{colors.surface}`, rounded `{rounded.lg}`, padding `{spacing.md}`, border `1px solid {colors.hairline}`.

**`card-dashboard-summary`** — Large top summary card.
- Background `{colors.surface}`, rounded `{rounded.xl}`, padding `{spacing.lg}`, shadow Level 1.
- Contains large metric, trend, and one secondary action.

**`card-action-tile`** — Quick action tile.
- Background `{colors.surface}`, rounded `{rounded.lg}`, padding `{spacing.md}`, min-height `96px`.
- Icon container `40px`, rounded `{rounded.md}`, background `{colors.primary-soft}`.

**`card-media`** — Image or visual card.
- Background `{colors.surface}`, rounded `{rounded.xl}`, overflow hidden.
- Image top, content bottom. Avoid text over complex image unless blurred scrim is used.

**`section-group`** — iOS-like grouped list container.
- Background `{colors.surface}`, rounded `{rounded.lg}`, overflow hidden.
- Inner rows separated by `{colors.hairline}`.

### Lists

**`list-row`** — Standard row.
- Height min `56px`, padding `0 {spacing.md}`.
- Left: optional icon / avatar.
- Center: title + optional subtitle.
- Right: value / chevron / switch.
- Bottom divider starts after left icon when icon exists.

**`list-row-large`** — Rich row.
- Height min `72px`, padding `{spacing.sm} {spacing.md}`.
- Use for messages, records, tasks, devices, and data entries.

**`list-section-title`** — Section heading.
- Text `{colors.ink-muted}`, typography `{typography.footnote}`, padding `0 {spacing.md} {spacing.xs}`.

**`empty-state`** — Empty content.
- Centered icon `56px`, title `{typography.title-3}`, description `{typography.callout}`.
- Primary action below with `button-primary` or `button-secondary`.

### Inputs & Forms

**`text-input`** — Single-line input.
- Background `{colors.surface}`, text `{colors.ink}`, placeholder `{colors.ink-muted}`, height `48px`, rounded `{rounded.md}`, padding `0 {spacing.md}`, border `1px solid {colors.hairline}`.

**`text-area`** — Multi-line input.
- Min-height `120px`, padding `{spacing.md}`, rounded `{rounded.md}`.
- Character counter uses `{typography.footnote}` and `{colors.ink-muted}`.

**`search-field`** — Search input.
- Background `rgba(118,118,128,0.12)`, height `36px`, rounded `{rounded.md}`, icon `16px`, text `{typography.callout}`.
- Use in list-heavy pages.

**`form-row`** — Settings-like form item.
- Height min `56px`, background `{colors.surface}`, label left, value / input right.
- Use grouped container instead of standalone borders.

**`switch`** — Boolean control.
- Use platform-native switch when possible.
- Active color `{colors.semantic-success}`.

### Tabs & Filters

**`filter-chip`** — Inline filtering chip.
- Inactive: background `{colors.surface}`, border `1px solid {colors.hairline}`, text `{colors.ink-soft}`.
- Active: background `{colors.primary-soft}`, text `{colors.primary}`, border transparent.
- Height `32px`, rounded `{rounded.full}`, padding `0 12px`.

**`status-chip`** — Status indicator.
- Use semantic soft background with matching text.
- Height `24px`, rounded `{rounded.full}`, typography `{typography.footnote}`.

**`scope-bar`** — Multi-state content filter.
- Uses `segmented-control`.
- Keep segment count ≤ 4.

### Feedback

**`toast`** — Temporary feedback.
- Background `rgba(0,0,0,0.78)`, text `{colors.on-dark}`, rounded `{rounded.md}`.
- Appears above bottom tab / floating CTA.
- Auto-dismiss after `1600–2400ms`.

**`alert-dialog`** — Critical confirmation.
- Background `{colors.surface-elevated}`, rounded `{rounded.xl}`, shadow Level 4.
- Title `{typography.headline}`, body `{typography.callout}`.
- Buttons separated by hairline dividers.

**`bottom-sheet`** — Action / selection sheet.
- Background `{colors.surface-elevated}`, rounded top `{rounded.xxl}`, shadow Level 4.
- Drag handle `36px × 5px`, background `{colors.hairline-strong}`, rounded full.
- Content padding `{spacing.md}` and bottom safe area.

**`loading-state`** — Loading indicator.
- Prefer skeleton rows/cards over full-screen spinner.
- Skeleton color `rgba(60,60,67,0.10)` with subtle shimmer.

### Icons

**`icon-system`** — Functional icon.
- Use SF Symbols-like line icons.
- Stroke width visually close to `1.75–2px`.
- Size `20px` for inline, `24px` for nav, `28px` for primary action.
- Always provide a `44px` hit target for tappable icons.

**`icon-container`** — Icon background.
- Size `40px`, rounded `{rounded.md}`, background `{colors.primary-soft}` or semantic soft background.
- Use for quick actions and list categories.

---

## Signature Components

### `apple-dashboard-home`

A premium mini program home page.

- Background `{colors.canvas}`.
- Top large title `{typography.large-title}`.
- First card `card-dashboard-summary`.
- Quick actions use 2-column `card-action-tile`.
- Important list uses `section-group`.
- Bottom navigation uses `bottom-tab-bar`.

### `native-grouped-list-page`

A settings / records / management page.

- Background `{colors.canvas}`.
- Each logical group is a `section-group`.
- Section titles are uppercase-free Chinese labels.
- Rows use right chevron only when drill-down exists.
- Destructive actions appear in a separate group.

### `bottom-sheet-picker`

Used for selecting filters, dates, devices, factories, categories.

- Trigger row shows current value and chevron.
- Sheet has title, optional search, list rows, and confirmation button.
- Avoid full-screen selector unless list is long or search-heavy.

### `ai-assistant-entry`

For AI / intelligent mini program features.

- Icon container uses `{colors.accent-purple}` soft tint.
- Copy should be calm and capability-oriented, not exaggerated.
- Use one primary prompt input and 3–5 suggestion chips.
- Results appear in cards, not chat bubbles unless the product is truly conversational.

---

## Motion

### Timing

| Token | Duration | Use |
|---|---:|---|
| `{motion.fast}` | 120ms | Pressed state, icon feedback |
| `{motion.base}` | 180ms | Segment switch, chip selection |
| `{motion.sheet}` | 260ms | Bottom sheet enter / exit |
| `{motion.page}` | 320ms | Page transition |
| `{motion.slow}` | 420ms | Large visual expansion |

### Easing

- Use ease-out for enter transitions.
- Use ease-in for exit transitions.
- Pressed state should feel immediate.
- Avoid bouncy animation unless the product is consumer / lifestyle oriented.

### Interaction Rules

- Button press: scale to `0.98`, opacity `0.92`.
- Card press: background tint or subtle scale; avoid heavy shadow jump.
- List row press: use light gray highlight.
- Sheet: slide from bottom with background dim `rgba(0,0,0,0.24)`.

---

## Do's and Don'ts

### Do

- Use large, clear page titles.
- Use grouped list containers for structured information.
- Keep primary actions obvious and limited to one per screen.
- Maintain 44px minimum tap area.
- Use blue only for interaction, selection, and navigation.
- Use cards to group meaning, not just decoration.
- Use native mini program capabilities where possible.
- Preserve safe areas at top and bottom.
- Keep copy short, concrete, and action-oriented.
- Use subtle blur only where it improves context retention.

### Don't

- Don't overuse gradients, neon colors, or decorative illustrations.
- Don't use Android Material-style floating labels and dense toolbars.
- Don't create tiny text below 12px.
- Don't use more than one strong CTA on a single screen.
- Don't place destructive actions next to primary confirm actions without separation.
- Don't use heavy shadows on every card.
- Don't make all buttons pill-shaped by default.
- Don't mix too many icon styles.
- Don't use blue as large background blocks unless it is a deliberate hero / brand moment.
- Don't rely on hover behavior.

---

## Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|---|---:|---|
| Small Phone | `< 360px` | Reduce horizontal padding to 12px; avoid two-column dense cards |
| Standard Phone | `360–430px` | Default layout; 16px gutters |
| Large Phone | `431–480px` | Cards can breathe; allow wider summary sections |
| Foldable / Tablet Mini Program | `> 480px` | Center max content width around 480–560px |

### Touch Targets

- Minimum tappable area: `44px × 44px`.
- Primary button height: `50px`.
- Input height: `48px`.
- List row min height: `56px`.
- Bottom tab item width: evenly distributed.

### Safe Area

- Bottom tab and floating CTA must account for bottom safe area.
- Bottom sheet must include additional bottom padding.
- Avoid placing important content under mini program capsule / system menu.

### Collapsing Strategy

- Large title collapses into compact nav title after scroll.
- Summary metrics stack vertically on small phones.
- Two-column action tiles become one column when text is long.
- Bottom floating CTA becomes full-width sticky button on task pages.
- Filter chips scroll horizontally instead of wrapping into many rows.

---

## Accessibility

### Contrast

- Primary text must maintain strong contrast on all surfaces.
- Secondary text should remain readable on `{colors.canvas}` and `{colors.surface}`.
- Do not use low-opacity text on image backgrounds without scrim.

### Dynamic Type

- Core layouts should tolerate 120–135% font scaling.
- List rows may increase height; do not clip labels.
- Avoid fixed-height text containers for body content.

### Touch & Feedback

- Every tap target should provide immediate visual feedback.
- Disabled controls should explain why when the reason is not obvious.
- Error messages should be placed near the affected field.

### Content

- Use plain language.
- Avoid metaphor-heavy labels.
- Confirm destructive actions with clear object names, for example: “删除设备 A-102？”

---

## Mini Program Implementation Notes

### WeChat Mini Program

- Use `rpx` for layout scaling, but define token source in px-like design units.
- Prefer `cover-view` carefully; it may have styling constraints.
- Use native `button`, `switch`, `picker`, and `scroll-view` where they improve consistency.
- Avoid over-nesting `scroll-view`; it harms gesture behavior.
- Account for capsule menu and custom navigation bar height.

### CSS / Token Mapping

Example token structure:

```css
:root {
  --color-primary: #007aff;
  --color-primary-pressed: #0066d6;
  --color-primary-soft: #eaf3ff;

  --color-canvas: #f5f5f7;
  --color-surface: #ffffff;
  --color-hairline: rgba(60, 60, 67, 0.16);

  --color-ink: #1d1d1f;
  --color-ink-soft: rgba(60, 60, 67, 0.72);
  --color-ink-muted: rgba(60, 60, 67, 0.48);

  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-xl: 20px;
  --radius-full: 9999px;

  --spacing-md: 16px;
  --spacing-lg: 20px;
  --spacing-xl: 24px;
}
```

### Component Naming

Use lowercase kebab-case component names:

- `button-primary`
- `nav-bar-large`
- `bottom-tab-bar`
- `card-dashboard-summary`
- `section-group`
- `list-row`
- `search-field`
- `filter-chip`
- `bottom-sheet`
- `toast`

---

## Iteration Guide

1. Start from page structure before colors.
2. Build `nav-bar`, `bottom-tab-bar`, `button`, `card`, `list-row`, and `bottom-sheet` first.
3. Use tokens only; avoid one-off colors and spacing.
4. Test on 375px and 430px phone widths.
5. Validate 44px tap targets.
6. Test long Chinese labels and 135% text scaling.
7. Reduce visual noise before adding new components.
8. Keep every screen to one primary intent.
9. Use native-feeling grouped lists for management screens.
10. Use summary cards and quick-action tiles for dashboard screens.

---

## Known Gaps

- Exact SF Pro font files are not bundled; use system font stack instead.
- Mini program engines differ in blur, safe area, and custom navigation behavior.
- Some Apple-native materials cannot be fully reproduced in WebView-like environments.
- Icon quality depends on the chosen icon set; use one consistent SF Symbols-like library.
- Dark mode tokens should be added separately if the mini program requires full dark-mode support.
