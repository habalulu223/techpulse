# TechPulse Design System

This file is the **single source of truth for UI design**. Read this before any
design or styling work, and update it in the same change whenever the visual
system changes. Do not re-derive the design by reading every stylesheet; the
files below are implementation, this document is the contract.

Scope: the Flask web app under `PythonProject/` (templates + `PythonProject/assets`).
The Kivy mobile app (`PyPondoMobile/`, `PythonProject/main.py`) is out of scope.

---

## 1. Design intent

- Calm, professional, light dashboard. Flat white surfaces on a soft blue-grey
  canvas, rounded 14px cards, one blue accent, dark navy chrome.
- No neon, glow, scanlines, or dark dashboard palettes. Those belong to the
  retired legacy themes and to the landing page only.
- Navy is for chrome and primary buttons; blue is for accent text, focus and
  selection. Semantic colours are muted (green / amber / red-brown), never neon.
- Sentence case everywhere. No uppercase headings. Uppercase is allowed only for
  small labels (`.eyebrow`, `.field-label`, `.section-label`).
- Quiet motion: 0.15s colour/transform transitions. All motion is disabled under
  `prefers-reduced-motion`.

---

## 2. Files and layering

| Layer | File | Purpose |
|---|---|---|
| Shared theme | `PythonProject/assets/professional.css` | Tokens, base typography, surfaces, buttons, forms, tables, badges, header, sidebar, responsive rules |
| Shared include | `PythonProject/templates/_dashboard_container_theme.html` | Loads `professional.css`, Font Awesome 6.5, Inter |
| Sidebar include | `PythonProject/templates/_dashboard_nav.html` | Fixed dark `.dash-nav`, role-aware links |
| Header include | `PythonProject/templates/_app_header.html` | Shared signed-in header |
| Page styles | `PythonProject/assets/css/<page>.css` | Layout specific to one page only |
| Page templates | `PythonProject/templates/<page>.html` | Markup; set header vars before including `_app_header.html` |

**Rules**

1. Shared tokens/components go in `professional.css`. Page-only layout goes in
   the page stylesheet. Never add page-specific layout to the shared file.
2. The theme include is placed after the page stylesheet on signed-in pages, so
   equal-specificity legacy rules lose ties. Anything that must never move again
   (sidebar item geometry, `.stats` grid, `h2`/card-heading size and margins, base
   `body` font-size, header chip box-sizing, button/input boxes) is therefore
   declared `!important` in the theme. A page override needs a scoped selector and
   `!important` (e.g. `main section.grid`, `body .login-shell`).
3. Every page includes `_dashboard_container_theme.html`. Signed-in pages also
   include `_dashboard_nav.html` and `_app_header.html`.
4. Do not reintroduce dark/neon styling on signed-in pages. `.cyber-bg`,
   `.cyber-core`, `.cyber-grid` are hidden by the theme outside auth/landing.

---

## 3. Tokens

Defined in `:root` of `professional.css`. Change them there, not in page CSS.

| Token | Value | Use |
|---|---|---|
| `--tp-bg` | `#f4f7fb` | Page canvas |
| `--tp-surface` | `#ffffff` | Cards, panels, tables |
| `--tp-ink` | `#17263b` | Primary text |
| `--tp-muted` | `#68788d` | Secondary text, metadata |
| `--tp-line` | `#e3eaf2` | Borders, dividers |
| `--tp-accent` | `#315d91` | Selected tab, eyebrow |
| `--tp-accent-strong` | `#274d7b` | Links, accent text |
| `--tp-accent-soft` | `#eef3fa` | Soft fills, hover surfaces |
| `--tp-sidebar` / `--tp-navy` | `#17263b` | Sidebar, header, primary buttons |
| `--tp-sidebar-line` | `#26364d` | Sidebar/header dividers |
| `--tp-sidebar-ink` | `#c4d0df` | Sidebar link text |
| `--tp-sidebar-hover` / `--tp-navy-hover` | `#263851` | Hover fills |
| `--tp-nav-w` | `248px` (`214px` ≤ 1360px) | Sidebar / body offset |
| `--tp-success` | `#1c7a4d` | Status OK |
| `--tp-warn` | `#8a5a1f` | Status warn |
| `--tp-danger` | `#a33a3a` | Destructive/error text |
| `--tp-shadow` | `0 4px 16px rgba(24,39,60,.045)` | Surface shadow |
| `--tp-radius` | `14px` | Surface radius |

Auth/landing palette (dark, intentional, only on those pages):

| Token | Value | Use |
|---|---|---|
| backdrop | `#071426` | Auth/landing background |
| panel | `rgba(13,32,56,.96)` | Login card |
| panel border | `rgba(159,190,225,.25)` | Login card border |
| text / muted | `#f4f8ff` / `#a8bad0` | Auth text |
| accent | `#43e0e8` → `#55a4ff` | Auth accent gradient `110deg` |
| field text | `#10202f` on `#fff` | Auth inputs |

---

## 4. Typography

- Font: **Inter** (`400/500/600/700`), fallback system UI. Loaded via theme include.
- Fluid root: `html { font-size: clamp(13px, .4vw + 11.5px, 16px) }`; use `rem`.
- `body` is locked to `1rem` so a legacy page `font:15px` cannot shrink nav labels,
  header text, paragraphs, inputs or buttons on one page only.
- `h1`: `clamp(1.55rem, 2vw, 2rem)` / 750. `h2`: `1.12rem` / 700, margin
  `0 0 8px`. `h3`: `1rem` / 680; card/panel/section headings use the `h2` size,
  weight and margin regardless of tag.
- Body: 1.55 line-height, normal letter-spacing; headings use `-.025em`.
- `.eyebrow`: uppercase, `.78rem`, 750, `.12em` tracking, accent colour.
- `.muted`, `.sub`, `small`, `.empty`: muted colour.
- Weights above 700 (`750`) are used intentionally for emphasis; keep that scale.

---

## 5. Layout

- Signed-in canvas: `<body>` gets `padding-left: var(--tp-nav-w)`; `main` is
  `max-width: 1440px; margin: 0 auto; padding: clamp(12px, 2.5vw, 26px)`.
- Sidebar `.dash-nav`: fixed, `248px` (→`214px` under 1360px), navy, `z-index: 40`.
- Header `.app-header`: sticky, navy, `min-height: 74px`, `z-index: 35`,
  full-bleed across the content column.
- Content blocks are `.card` / `.panel` (padding 20px, radius 14px, 1px line,
  soft shadow, no own margins — the theme adds `18px` between stacked blocks in
  `main`). Grids: `.grid`/`.cards` auto-fit `minmax(min(320/280px,100%),1fr)`,
  `.stats` auto-fit `minmax(min(175px,100%),1fr)`. Grid children have zero
  margins so every page's card gap is the same `16px`.
- Multi-panel operational pages may override the grid in page CSS to keep panels
  balanced (e.g. station dashboard `main section.grid` becomes 2 columns ≥1100px).

### Breakpoints (shared theme)

| Width | Behaviour |
|---|---|
| ≤ 1360px | Sidebar 214px; `main` padding 18/20; header actions wrap |
| ≤ 1024px | Sidebar folds into a horizontally scrollable navy top bar; body left padding removed; header actions drop to their own row |
| ≤ 760px | Grids collapse to one column; `main` padding 16px |
| ≤ 620px | Header heading stacks; page-specific single-column metadata |
| ≤ 520px | Stats 2-up; analytics 1 column |
| reduce motion | All animation/transition disabled |

---

## 6. Components

### Surfaces
`.card`, `.panel`, `.stat`, `.section`, `.metric`, `article`, `.status`,
`.analytics-tile`, tables and modal cards share the white surface treatment.
Hover raises border to `#d3dde9` only.

### Stat tiles
Always `<div class="stat"><b>{{ value }}</b><span>Label</span></div>`: number on
top (`.stat b`, 1.55rem), muted `.9rem` label below. Padding is fixed at 17px
(12px ≤520px) by the shared theme; page stylesheets must not resize stat tiles or
section headings — `h2` is locked to `1.12rem` so heading sizes match on every
page.

### Buttons
| Class | Style |
|---|---|
| default `button`, `.btn`, `input[type=submit]` | Navy fill, white text, radius 9px |
| `.btn-secondary` | White fill, `#c3d4ea` border, accent-strong text |
| `.btn-red`, `.danger`, `.delete-btn`, `.stop-btn` | White fill, `#e7c9c9` border, danger text (hover `#fbeeee`) |
| `.header-action-button` | White pill on navy chrome, navy text, `min-height:40px`, border-box |
| Card "Open … →" links (`.card a`, `.card-action a`) | Navy fill, white text, radius 9px, same `10px 15px` / `1rem` box as form buttons |

Hover: `translateY(-1px)` plus the colour shift above. Focus: visible outline.

### Forms
Full-width inputs (`radius 9px`, `min-height 42px`, border `#d5deea`, white fill,
ink text). Focus: 3px navy-tinted outline. `form` is a grid with 10px gap;
`.inline` wraps children at `flex: 1 1 140px`. Use `.field-label` /
`.section-label` for small caps labels. Placeholders `#8a97a8`.

### Tables
Always wrap wide tables in `.table-scroll` (horizontal scroll inside the column,
never page overflow). `table`: radius 12px, header `#f6f8fb`, row divider
`--tp-line`, hover `#fbfcfe`. User tables: `.user-table-wrap` (max 68vh, scroll)
with sticky `.user-table` header.

### Badges
`.badge` / `.tag`: pill, `.82rem`, neutral `#eef1f6` / `#43536b`.

| Status | Background | Text |
|---|---|---|
| `.status-ok` / `.free` | `#e8f4ed` | `--tp-success` |
| `.status-warn` | `#fdf6e8` | `--tp-warn` |
| `.status-danger` / `.occupied` | `#eef3fa` | `--tp-danger` |
| `.status-neutral` | `#eef1f6` | `#43536b` |

### Alerts / notices
`.flash`, `.alert`, `.notice`, `.user-guidance`: `--tp-accent-soft` fill,
`#c3d4ea` border, radius 10px, text `#6a1526`.

### Tabs
`.view-tabs a`: white pill; active `aria-current="page"` uses accent fill with
white text.

---

## 7. Shared header and sidebar contracts

### `_app_header.html`
Set before including: `header_title`, `header_subtitle`, `header_role`,
`header_actions` (list of `{label, url, icon}`; icon is a Font Awesome class).
Fixed: TechPulse brand (links to role dashboard), page title/subtitle, action
pills, `Full name · Role`, avatar link to profile, Log out. Do not build a
per-page header.

### `_dashboard_nav.html`
One fixed dark sidebar, role-aware links. Navigation changes go here; do not add
a second tab row. Exactly one link carries `aria-current="page"`, driven by
`request.path` and the resolved `dashboard_view` (not the raw query string).
Icons: Font Awesome 6.5 solid, `aria-hidden="true"`.

---

## 8. Page inventory

Signed-in light pages (theme + sidebar + header + page CSS):

| Page | Template | Stylesheet |
|---|---|---|
| Role dashboard (default after login) | `role_dashboard.html` | `role_dashboard.css` |
| Station monitoring / System | `index.html` | `index.css` |
| Equipment views | `equipment.html` | `equipment.css` |
| Borrower portal | `borrower.html` | `borrower.css` |
| Community equipment | `community_equipment.html` | `community_equipment.css` |
| Dean overview | `dean.html` | `dean.css` |
| Dean analytics | `dean_analytics.html` | `dean_analytics.css` |
| Logs | `logs.html` | `logs.css` |
| Profile | `profile.html` | `profile.css` |
| Mobile pairing | `mobile_pairing.html` | `mobile_pairing.css` |

Standalone pages:

| Page | Styling |
|---|---|
| Landing | `landing.html` + `landing.css` — dark marketing page, gradient buttons, own topbar |
| Login | `login.html` + `login.css` — dark auth: transparent shell over the animated backdrop, dark glass card, gradient Sign In / Download buttons, fixed "Back" pill to the landing page |
| Register | `register.html` + `register.css` — dark auth, consistent with login |
| Error | `error.html` + `error.css` — themed error surface |
| QR print pages | `pc_qr.html` / `equipment_qr.html` + `pc_qr.css` / `equipment_qr.css` — print-oriented |

Auth pages intentionally keep the dark palette and are the only pages where the
animated background (`_animated_background.html`) is visible. Their shells must
stay transparent so the backdrop shows; only the card itself is a surface.

---

## 9. Page patterns

- **Role dashboard**: intro row (eyebrow + "Open full workspace" link), 2-per-card
  `aria-label="Dashboard actions"` card groups with `.card-action` blocks divided
  by a top line, admin-only tunnel panel, recent issues panel.
- **Station dashboard**: summary `.stats`, "Station tools" panel, station cards
  (`.station-card`, `.station-head`, `.station-meta`, `.station-usage`,
  `.station-qr`, `<details class="station-tools">`), then operational panels
  (mobile pairing with QR + copy, network discovery, agent status, user controls)
  laid out as a balanced 2×2 grid on wide screens.
- **Detail/edit panels**: `.panel-heading` (title + description left, actions
  right, wraps), `.toolbar-actions`, `.fine-print`.
- **Empty states**: `.empty` or `.muted` sentence, never a blank panel.

---

## 10. Verification

After design changes:

1. `py -3 smoke_test_ui.py` — every themed page renders with the shared assets.
2. `py -3 -m pytest test_equipment_qr.py -q` for QR-related work.
3. Visually check with headless Edge at desktop (`1440`) and phone (`500`) widths.
   Edge clamps its layout viewport to ~500px, so do not trust narrower captures.
4. Keep tracked `__pycache__` files unchanged if tests rewrite them.

---

## 11. Change checklist

- [ ] Reused tokens/classes instead of new one-off colours
- [ ] Page-specific layout lives in that page's CSS, not `professional.css`
- [ ] Signed-in pages use the shared header + sidebar includes
- [ ] No dark/neon styling added to signed-in pages
- [ ] Sentence case; uppercase only for small labels
- [ ] Responsive at 1360 / 1024 / 760 / 520 breakpoints
- [ ] Focus states and reduced-motion respected
- [ ] This document updated if the system changed
