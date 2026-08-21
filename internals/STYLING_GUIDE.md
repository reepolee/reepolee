# Reepolee Styling Guide

Design tokens, utility classes, component patterns, and mandatory styling rules.

---

## Running Tailwind (standalone binary)

Tailwind v4 runs as a **standalone binary** named `tw` - not via PostCSS, and not
via the `tailwindcss` / `@tailwindcss/cli` npm CLI. There is no `postcss.config`
and no `tailwind.config.js`; all configuration is CSS-first (`@theme`, `@source`,
`@utility` in `css/app.css`).

### Install

`bun run get:tw` downloads the platform-specific executable from the official
GitHub releases (`tailwindlabs/tailwindcss`) to `~/bin/tw` (or `~/bin/tw.exe`) and
adds it to your PATH. The version is pinned by the package.json script
(`bun scripts/cli.ts tw --version=4.3.3`).

It is deliberately named `tw` (not `tailwindcss`) so it can never collide with a
stray global npm shim (e.g. `bun add -g @tailwindcss/cli`) - that exact collision
silently ran the npm shim instead of the standalone binary and broke
`@import "tailwindcss"` resolution.

### Build commands

`css/app.css` is the single entry point (`@import "tailwindcss"` + tokens). The
`tw` binary compiles it to a static CSS file:

| Command            | Runs                                                            | Output                | Use                              |
| ------------------ | --------------------------------------------------------------- | --------------------- | -------------------------------- |
| `bun run css:once`  | `tw -i ./css/app.css -o ./static/app-dev.css`                   | `static/app-dev.css`  | One-shot dev build               |
| `bun run css:watch` | `tw -i ./css/app.css -o ./static/app-dev.css --watch=always`    | `static/app-dev.css`  | Watch mode (`bun dev` runs this) |
| `bun run css:build` | `tw -i ./css/app.css -o ./static/app.css --minify`              | `static/app.css`      | Production, minified             |

Pages link `/app-dev.css` in dev and `/app.css` in prod (see `apps/main/layout.ree`).

### Class scanning

Tailwind only generates classes it finds in scanned source files, declared with
`@source` directives in `css/app.css`. When you add Tailwind classes in a new
location (for example, an injected client script under `lib/`), add a matching
`@source` entry - otherwise the classes compile to nothing.

---

## Design Tokens (CSS Custom Properties)

All colors, spacing, radii, and shadows are defined as CSS custom properties in `css/app.css` under `@theme`. Never use raw Tailwind color values (`bg-blue-500`, `text-red-600`, etc.) -- use the semantic tokens below.

### Brand Identity

| Token | Value | Usage |
|-------|-------|-------|
| `--color-brand` | `#b40000` | Logo, primary brand accent, confirmation actions |
| `--color-brand-50` | `#fef2f2` | Brand tint backgrounds |
| `--color-brand-100` | `#fecaca` | Brand light borders/highlights |

### Surfaces (by elevation, not component)

| Token | Value | Usage |
|-------|-------|-------|
| `--color-surface` | `#fafafa` | Page background |
| `--color-surface-raised` | `#fefefe` | Cards, dialogs, form inputs |
| `--color-surface-sunken` | `#e5e5e5` | Tabs, code blocks, pressed states |
| `--color-surface-overlay` | `#1f2937` | Backdrop overlays |

### Semantic / Feedback

| Token | Value | Utility Class | Usage |
|-------|-------|---------------|-------|
| `--color-primary` | `#2563eb` | `primary` | Main actions, create, save, generate |
| `--color-success` | `#16a34a` | _(inline only)_ | Success states, "yes" pills |
| `--color-warning` | `#d97706` | _(inline only)_ | Warning states, banners |
| `--color-danger` | `#dc2626` | `danger` | Destructive confirm buttons (in dialogs only) |
| `--color-brand` | `#b40000` | `brand` | Brand accent, links, active navigation |

### Text / Content

| Token | Value | Usage |
|-------|-------|-------|
| `--color-text-primary` | `#0f172a` | Body text, headings |
| `--color-text-secondary` | `#525252` | Descriptions, secondary labels |
| `--color-text-tertiary` | `#6b7280` | Muted text, placeholders, hints |
| `--color-border` | `#d1d5db` | Form field borders, separators |

### Radii & Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `0.375rem` | Buttons, inputs, pills |
| `--radius-md` | `0.75rem` | Dialogs, cards |
| `--radius-lg` | `1rem` | Large containers |
| `--shadow-sm` | `0 1px 2px 0 rgb(0 0 0 / 0.05)` | Subtle elevation |
| `--shadow-md` | `0 4px 6px -1px rgb(0 0 0 / 0.1)` | Cards, dropdowns |
| `--shadow-lg` | `0 10px 15px -3px rgb(0 0 0 / 0.1)` | Dialogs |

### Typography

| Token | Value |
|-------|-------|
| `--font-sans` | System UI font stack (ui-sans-serif, system-ui, ...) |

---

## Semantic Utility Classes

These are the **only** classes you should use for button intent. Never use raw `bg-*` or `text-*` Tailwind colors for button styling.

### `primary`

```css
@utility primary {
    @apply bg-primary shadow-neutral-500 hover:shadow;
    color: contrast-color(var(--color-primary));
}
```

**Use for:** Main page actions (Create, Save, Generate), sole page actions, main card actions, bulk action buttons, submit buttons. A main action remains primary when it opens a confirmation dialog.

**Do NOT use for:** Final destructive confirmations or cancel/back buttons.

**Example:**
```html
<a href="/users/new" role="button" class="primary">+ New User</a>
<button id="action" class="button primary">Bulk Action</button>
```

### `danger`

```css
@utility danger {
    @apply bg-danger shadow-neutral-500 hover:shadow;
    color: contrast-color(var(--color-danger));
}
```

**Use for:** Only the final confirm button inside a deletion/irreversible-action dialog. The button that actually performs the destructive action.

**Do NOT use for:** Trigger buttons that open a confirmation dialog. Buttons that cancel. Delete icon buttons in table rows.

**Example:**
```html
<!-- Inside a delete confirmation dialog -->
<button type="submit" class="button danger">Delete</button>
```

### `secondary`

```css
@utility secondary {
    @apply border border-border bg-transparent shadow-none;
}
```

**Use for:** Cancel buttons, "back" links, secondary actions that shouldn't draw attention.

**Example:**
```html
<a href="/users" class="button secondary">Cancel</a>
<button type="button" class="button secondary">Save & Close</button>
```

### `tertiary`

```css
@utility tertiary {
    @apply border border-border bg-neutral-100 shadow-none hover:bg-neutral-200;
}
```

**Use for:** Low-emphasis actions like delete triggers, "remove" buttons, and actions in tight spaces. Tertiary actions use a visible border and soft neutral fill so they remain visibly clickable.

**Example:**
```html
<button class="button tertiary">Delete</button>
```

### `button` (Base Class)

```css
a[role="button"],
.button {
    @apply inline-flex h-10 cursor-pointer items-center justify-center whitespace-nowrap rounded-sm border border-transparent px-3 py-2 transition hover:scale-105;
}
```

**Use for:** Any element that should look like a button. Combine with a semantic utility: `button primary`, `button secondary`, `button tertiary`. The fixed height and permanent transparent border box keep buttons aligned and prevent layout shift when hover borders appear.

---

## Button Color Decision Tree

```
Is this button performing a destructive action right now?
  YES → use `danger` (inside a confirmation dialog ONLY)
  NO  → continue

Is this button the main call-to-action?
  YES → use `primary`
  NO  → continue

Is this button a cancel, back, or secondary action?
  YES → use `secondary`
  NO  → continue

Is this a low-emphasis contextual trigger (delete icon, row action, etc.)?
  YES → use `tertiary` or neutral styling
  NO  → use neutral styling (text-only or minimal)
```

### Mandatory Rule: Trigger vs. Confirm

**Trigger buttons** (open a confirmation dialog) must NOT use `danger`. Use `primary` when the trigger is the page or card's main action, and `tertiary` when it is contextual. Only the final **confirm button** inside the dialog uses `danger` for an irreversible action.

```html
<!-- CORRECT: Contextual trigger uses tertiary -->
<button class="button tertiary" command="show-modal" commandfor="delete-dialog">
  Delete
</button>

<dialog id="delete-dialog">
  <button class="button secondary" command="close">Cancel</button>
  <button class="button danger">Delete</button>  <!-- CORRECT -->
</dialog>
```

```html
<!-- WRONG: Trigger should not be danger -->
<button class="button danger" command="show-modal" commandfor="delete-dialog">
  Delete  <!-- WRONG -->
</button>
```

---

## Form Elements

### Inputs, Textareas, Selects

```css
form input, form textarea, form .input {
    @apply bg-surface-raised rounded-sm border border-border px-3 py-1;
}
```

Always wrap in `<field-wrapper>` for proper label alignment and validation error placement.

### Submit Buttons

Submit buttons (`type="submit"`) automatically get `primary` styling. To override (e.g., for a danger submit):

```html
<!-- Default: primary (blue) -->
<button type="submit">Save</button>

<!-- Override: danger (red) for destructive submits -->
<button type="submit" class="danger">Delete</button>
```

### Validation Errors

Use the `<validation-error>` custom element -- it automatically displays server-side errors with brand-colored text.

```html
<validation-error>{_ errors.email_required}</validation-error>
```

---

## Dialog Patterns

### Standard Dialog

```html
<dialog id="my-dialog" class="p-0 rounded-xl shadow-2xl w-100">
  <div class="p-6">
    <h2 class="text-lg font-semibold">Dialog Title</h2>
    <p class="text-slate-600 mt-2">Message text.</p>
    <div class="mt-6 flex justify-end gap-2">
      <button class="button secondary" command="close">Cancel</button>
      <button class="button primary" command="--confirm">Do It</button>
    </div>
  </div>
</dialog>
```

### Confirm Dialog Component

Use `<confirm-dialog>` for reusable confirmation patterns:

```html
<confirm-dialog
  title="Delete User"
  message="This action cannot be undone."
  trigger-text="Delete"
  trigger-class="button tertiary"
  confirm-text="Delete"
  confirm-class="danger"
  cancel-text="Cancel"
  form-path="/users/delete"
  extra-field-name="user_id"
  extra-field-value="123"
/>
```

### Delete Confirmation Dialogs

For delete confirmations, use `button danger` on the confirm button and `button secondary` on cancel:

```html
<dialog id="delete-dialog" class="p-0 rounded-xl shadow-2xl w-100">
  <div class="p-6">
    <h2 class="text-lg font-semibold">Delete Item</h2>
    <p class="text-slate-600 mt-2">This cannot be undone.</p>
    <form method="POST" action="/items/delete" class="mt-6 flex justify-end gap-2">
      <input type="hidden" name="_csrf_token" value="{= csrf_token }" />
      <button type="button" class="button secondary" command="close">Cancel</button>
      <button type="submit" class="button danger">Delete</button>
    </form>
  </div>
</dialog>
```

### Mandatory Rule: Dialog Button Spacing

Always use `flex justify-end gap-2` on the button row inside dialogs. Never stack buttons vertically or left-align them.

---

## Status Pills

Used for boolean/tag columns in table views.

### Layout

```css
@utility pill-layout {
    @apply inline-block rounded px-2 py-1 text-xs font-semibold;
}
```

### Variants

| Class | Appearance | Usage |
|-------|------------|-------|
| `pill-default` | Blue border, white bg | Neutral tags, categories |
| `pill-yes` | Green bg, white text | "Yes", "Active", "Enabled" |
| `pill-no` | Red bg, white text | "No", "Inactive", "Disabled" |

**Example:**
```html
<!-- In index.ree GEN:FIELDS:CELLS -->
<div class="{= props.columns.is_active.class }">
  {~ yes_no(record.is_active)}
</div>
```

---

## Table Grid Pattern

Index pages use CSS Grid with subgrid for aligned columns:

```html
<div class="grid gap-x-4 w-full bg-surface-raised shadow-lg mt-4"
     style="grid-template-columns: {= grid_cols }">

  <!-- Header row -->
  <div class="col-span-full grid grid-cols-subgrid bg-neutral-200 font-semibold
              *:px-2 *:py-2 sticky top-0">
    <div>ID</div>
    <div>Name</div>
    <!-- ... -->
  </div>

  <!-- Data rows -->
  <a href="/items/{= record.id }/edit"
     class="col-span-full *:py-2 grid cursor-pointer grid-cols-subgrid
            border-b border-b-neutral-200 *:px-2 hover:bg-primary hover:text-white">
    <div>{= record.id }</div>
    <div>{= record.name }</div>
  </a>
</div>
```

### Mandatory Rule: Grid Filler

When `grid_cols` includes a trailing `grid_filler` track, every row (header and data) must include a matching `<div class="grid-filler"></div>` cell.

---

## Navigation

### Sidebar Items

```css
.nav-item {
    @apply border-l-8 border-l-transparent py-2 pl-2;
}

.nav-item.current {
    @apply border-l-brand;
}
```

### Pagination

Use `<div class="pagination-info">` with `<a role="button">` for icon-based pagination controls.

---

## Filter Panel

Trigger button and slide-in dialog:

```html
<ree-filters action-url="/users"></ree-filters>
```

The filter panel is a `<dialog class="filter-panel">` that slides in from the right. Active filters appear as chips with a badge count on the trigger button.

---

## Dark Mode

- **Auto-detection:** OS preference via `@media (prefers-color-scheme: dark)` on `:root:not(.light)`
- **Explicit toggle:** `html.dark` class (set via cookie)
- **Transition:** `html.theme-transitioning` enables smooth color transitions

### Mandatory Rule: Test Both Modes

Every new UI element must look correct in both light and dark mode. Key overrides:
- Surface colors invert (light → dark grays)
- Border colors darken
- Text colors adjust for contrast
- Semantic 50-tints darken for proper contrast

---

## CSS File Organization

| File | Purpose |
|------|---------|
| `css/app.css` | Design tokens (`@theme`), base styles, utilities, dark mode |
| `css/forms.css` | Form elements, validation, localized field tabs |
| `css/studio.css` | Reeman/studio UI components |
| `css/toasts.css` | Toast notification animations |
| `css/filters.css` | Filter panel and chips |
| `css/markdown-editor.css` | Markdown editor styling |
| `css/date-input.css` | Custom date input component |
| `css/transitions.css` | Page transitions (currently disabled) |

### Where to Add New Styles

| Type of Style | Where |
|---------------|-------|
| New design token | `css/app.css` → `@theme` block |
| New component class | `css/app.css` → `@layer components` |
| New utility class | `css/app.css` → `@utility` |
| Form-specific styles | `css/forms.css` |
| Feature-specific styles | New `css/<feature>.css` + `@import` in `app.css` |
| One-off page styles | Inline `<style>` in the `.ree` template |

---

## Mandatory Rules

1. **No raw Tailwind colors for buttons.** Use semantic utilities: `primary`, `secondary`, `tertiary`, `danger`.

2. **Trigger buttons must not use `danger`.** Only confirm buttons inside dialogs use `danger`.

3. **Use design tokens for backgrounds/text/borders.** Prefer `bg-surface-raised` over `bg-white`, `text-text-secondary` over `text-gray-600`, `border-border` over `border-gray-300`.

4. **Use `rounded-sm` for buttons/inputs, `rounded` for intermediate, `rounded-xl` for dialogs.** Respect the radius scale.

5. **Test dark mode.** Every element must render correctly with dark mode overrides.

6. **Dialog buttons:** Always `flex justify-end gap-2` for the action row.

7. **Forms:** Always wrap fields in `<field-wrapper>`. Use `<validation-error>` for error display.

8. **Tables:** Use the grid/subgrid pattern with `grid_cols`. Include `grid-filler` cell when needed.

9. **Pills:** Use `pill-layout` + `pill-yes`/`pill-no`/`pill-default` for status displays.

10. **Pagination:** Use `<div class="pagination-info">` with `<a role="button">` for controls.

11. **Submit buttons:** Use `type="submit"` which auto-applies `primary`. Override with `danger` class for destructive submits.

12. **Hover states:** Row hovers use `hover:bg-primary hover:text-white`. Button hovers use `hover:scale-105` (base) or `hover:shadow` (primary/danger utilities).

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| `bg-blue-500 text-white` | Use `class="primary"` |
| `bg-red-600 text-white` | Use `class="danger"` (in dialogs only) |
| `text-red-500` on delete icon | Use `text-text-tertiary hover:text-brand` |
| `bg-white` for surfaces | Use `bg-surface-raised` |
| `text-gray-700` for body text | Use `text-text-primary` |
| `border-gray-300` for borders | Use `border-border` |
| Raw `bg-slate-200` on cancel | Use `button secondary` |
| Delete trigger uses `danger` | Wrong -- use `tertiary`; only confirm uses `danger` |
| Missing dark mode overrides | Add dark mode values to `@media (prefers-color-scheme: dark)` and `html.dark` |

---

## Related Documentation

- **Architecture:** [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Development Guide:** [DEVELOPMENT_GUIDE.md](./DEVELOPMENT_GUIDE.md)
- **Quick Reference:** [QUICK_REFERENCE.md](./QUICK_REFERENCE.md)
- **REE Templates:** [REE_TEMPLATES.md](./REE_TEMPLATES.md)
