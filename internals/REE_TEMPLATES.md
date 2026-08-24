# Render Module - `$lib/render.ts`

A lightweight rendering layer that wraps a template engine, injects shared context, and returns typed `Response` objects. Works alongside `$lib/template.ts` which configures the underlying engine.

---

## Two-layer component architecture (clarified)
The codebase has two distinct things both called "components," and the plan touches only the first:
- **ReeTags** (`.ree` files whose **basename contains a hyphen**, e.g. `star-rating.ree` — in `components/`, the `apps/main/` tree, or mounted module roots) - server-rendered, compiled by the `.ree` engine at request time from `props.attributes`/`props.children`. The hyphen in the tag name is what marks `<tag-name>` as a component invocation: a tag is only eligible if its name contains a hyphen (the preprocessor's `cust_elem_regex` requires it), so a hyphenless file like `apps/main/foo.ree` is a plain template (reachable via `render()`/`{#include}`, never via `<foo>`). Any eligible tag is auto-routed to a component file - `components/<tag-name>.ree` first, then a same-named hyphenated file in the routes tree (see `internals/REE_TEMPLATES.md` "Component includes" for the full resolution order). This is what `tags` mode targets.
- **Web components** (`static/web-components/*.js`, `static/*.js`) - real browser `customElements.define(...)` elements (`date-input`, `markdown-editor`, `validation-error`, `toasts-area`, `title-display`). These render blank server-side and hydrate client-side; they are loaded via `<script src="...">` and are orthogonal to which server template produced their surrounding HTML. `<field-wrapper>` is not a registered custom element anywhere in `static/` - it's inert markup styled via `app.css`, used identically by both flat templates and ReeTag components.

---


## Setup
7
Before calling any render functions, initialize the module once at app startup - typically in your server entry point.

```ts
import { initialize_render } from "$lib/render";
import { create_template_engine } from "$lib/template";

const engine = create_template_engine(is_dev);

initialize_render(engine, {
	is_dev,
	app_name: "My App",
	// ...any other global template variables
});
```

`base_data` is merged into every template render automatically, so values like `is_dev`, `app_name`, etc. are always available in your templates without passing them manually.

---

## API

### `initialize_render(engine, base_data)`

Initializes the module. Must be called before `render()` or `get_render()`.

| Parameter   | Type                  | Description                                 |
| ----------- | --------------------- | ------------------------------------------- |
| `engine`    | `Engine`              | A template engine with a `.render()` method |
| `base_data` | `Record<string, any>` | Global data merged into every template      |

The `Engine` type requires:

```ts
type Engine = {
	render: (name: string, data?: Record<string, any>) => Promise<string>;
	clearCache?: () => void;
};
```

---

### `render(template, options?)`

Renders a template and returns an HTML `Response`.

```ts
export type RenderOptions = {
	data?: Record<string, any>;
	status?: number;
	headers?: Record<string, string>;
	ctx?: RequestContext;
	is_partial?: boolean;
};

export async function render(template: string, options?: RenderOptions): Promise<Response>;
```

| Option      | Type                     | Default | Description                                                         |
| ----------- | ------------------------ | ------- | ------------------------------------------------------------------- |
| `data`      | `Record<string, any>`    | `{}`    | Template-specific data variables                                    |
| `status`    | `number`                 | `200`   | HTTP status code                                                    |
| `headers`   | `Record<string, string>` | `{}`    | Additional response headers                                         |
| `ctx`       | `RequestContext`         | -       | Request context from `create_ctx()` (enables URL, lang, user, etc.) |
| `is_partial`| `boolean`                | `false` | Skip full-document post-processing (used for streaming fragments)    |

**Returns:** `Promise<Response>` with `Content-Type: text/html`.

#### Automatic context injected into every render

When `ctx` is provided (from `create_ctx(req)`), the following variables are automatically available in the template:

| Variable            | Source                                 | Description                           |
| ------------------- | -------------------------------------- | ------------------------------------- |
| `request_url`       | `ctx.request_url` (pathname + search)  | Relative URL, e.g. `/products?page=2` |
| `locale`            | `ctx.locale`                           | Active BCP 47 locale, e.g. `"sl-si"`  |
| `user`              | Session resolved via `resolve_session` | Logged-in user object or `null`       |
| `toasts`            | `ctx.toasts`                           | Array of pending toast notifications  |
| `rendered_at`       | ISO timestamp string                   | Render timestamp                      |
| `prefix`            | `ctx.prefix`                           | Route prefix or `null`                |
| `csrf_token`        | `X-CSRF-Token` request header          | CSRF token for forms                  |
| `dark_mode`         | `ctx.dark_mode`                        | Boolean, dark mode preference         |
| `theme_class`       | `ctx.theme_class`                      | CSS class for theme                   |
| `active_locales`    | `config/supported_locales.ts`          | Available locales for the locale switcher |
| `locale_names`      | `config/supported_locales.ts`          | Map of locale codes to display names   |
| `translations`      | `ctx.translations`                     | Merged translations for this request's UI locale and route namespace. Read via `{_ path }` / `{- path }`, not directly |

In development mode (`is_dev: true`), two additional debug variables are injected:

| Variable       | Description                                       |
| -------------- | ------------------------------------------------- |
| `toJSON`       | Compact JSON string of the template `data`        |
| `toPrettyJSON` | Pretty-printed JSON string of the template `data` |

---

## Template Helpers

Template helpers are functions available directly in your templates without needing to access them through an object prefix. They handle common formatting, display logic, and custom transformations.

### Default Helpers

Every template automatically has access to these built-in helpers:

#### `yes_no(value, type?)`

Displays a boolean/numeric value as a styled "Yes" or "No".

```ts
yes_no(val: number, type?: "both" | "yes_only", selectors?: Record<string, string>): string
```

**Parameters:**

- `val` - Number or boolean (0/false = "No", non-zero/true = "Yes")
- `type` - Style variant:
    - `"yes_only"` (default) - Shows only "Yes" with green background, nothing for "No"
    - `"both"` - Shows "Yes" in green and "No" in red
- `selectors` - Optional map of `{"0": "No text", "1": "Yes text"}` to customize labels

**Template example:**

```ree
<div class="status">
  {~ yes_no(record.is_active) }
</div>

<div class="verified">
  {~ yes_no(record.email_verified, "both") }
</div>
```

### `{#with expr} ... {/with}`

Sets the scope context for property access inside the block. All variable references within the block resolve against the given expression's properties, similar to JavaScript's `with` statement.

```ree
{#with props.record}
  <h1>{= title }</h1>
  <p>{= description }</p>
{/with}

<!-- Equivalent to: -->
<h1>{= props.record.title }</h1>
<p>{= props.record.description }</p>
```

**Important:** Only direct variable names (not dotted expressions) resolve through the with context:

```ree
{#with props.nested}
  {= name }        <!-- ✓ Resolves to props.nested.name -->
  {= props.x }     <!-- ✗ Still uses the original props parameter, not props.nested.props.x -->
{/with}
```

**Nesting and composition:**

```ree
{#with props.user}
  <h2>{= name }</h2>
  {#with address}
    <p>{= street }</p>
    <p>{= city }</p>
  {/with}
  {#each roles as role}
    <span>{= role }</span>
  {/each}
{/with}
```

This is especially useful in CRUD-generated templates where you frequently access deeply nested properties like `props.columns`, `props.record`, or `props.fields`.

#### `js_date_to_locale_string(date_string, locale?)`

Formats a date string as a localized date (MM/DD/YY format).

```ts
js_date_to_locale_string(dateString: string | Date, locale?: string): string
```

**Parameters:**

- `date_string` - ISO date string (e.g., `"2024-01-15T10:30:00Z"`)
- `locale` - BCP 47 locale (default: `props.locale`, resolved from the active locale)

**Template example:**

```ree
<p>Created: {= js_date_to_locale_string(record.created_at) }</p>
<p>Joined: {= js_date_to_locale_string(record.joined_date, "en-us") }</p>
```

#### `js_time_to_locale_string(date_string, locale?)`

Formats a date string's time portion according to locale (h:mm AM/PM format).

```ts
js_time_to_locale_string(dateString: string | Date, locale?: string): string
```

**Parameters:**

- `date_string` - ISO date string
- `locale` - BCP 47 locale (default: `props.locale`)

**Template example:**

```ree
<p>Opens at: {= js_time_to_locale_string(record.opens_at) }</p>
```

#### `js_datetime_to_locale_string(date_string, locale?)`

Formats a date string as full date+time according to locale (MM/DD/YY, h:mm AM/PM format).

```ts
js_datetime_to_locale_string(input: unknown, locale?: string): string
```

**Parameters:**

- `date_string` - ISO date string
- `locale` - BCP 47 locale (default: `props.locale`)

**Template example:**

```ree
<p>Last updated: {= js_datetime_to_locale_string(record.updated_at) }</p>
```

#### `display_currency(val, locale?, hide_zero?, symbol?)`

Formats a number as currency.

```ts
display_currency(val: number, locale?: string, hide_zero?: boolean, symbol?: string): string
```

**Parameters:**

- `val` - Numeric value
- `locale` - Locale for formatting (default: `props.locale`)
- `hide_zero` - If `true`, returns empty string for zero values (default: `false`)
- `symbol` - Currency symbol (default: `"€"`)

**Template example:**

```ree
<p>{~ display_currency(record.price) }</p>
<p>{~ display_currency(record.tax, "en-us", false, "$") }</p>
```

#### `display_percent(val, locale?)`

Formats a number as percentage.

```ts
display_percent(val: number, locale?: string): string
```

**Parameters:**

- `val` - Numeric value (e.g. `0.15` → `"15%"`)
- `locale` - Locale for formatting (default: `props.locale`)

**Template example:**

```ree
<p>Discount: {= display_percent(record.discount_rate) }</p>
```

#### `js_timestamp_to_locale_string(date_string, locale?)`

Formats a date string as full date+time with seconds according to locale (MM/DD/YY, h:mm:ss AM/PM format). Used in generated CRUD `form.ree` templates to display `updated_at` timestamps.

```ts
js_timestamp_to_locale_string(input: unknown, locale?: string): string
```

**Template example:**

```ree
<div class="text-sm">{~ js_timestamp_to_locale_string(record.updated_at ?? record.created_at) }</div>
```

#### `js_date_to_iso_string(date_string)`

Converts a date to ISO date format string.

```ts
js_date_to_iso_string(dateInput: string | Date): string
```

**Template example:**

```ree
<time datetime="{= js_date_to_iso_string(record.published_at) }">
  {= js_date_to_locale_string(record.published_at) }
</time>
```

#### `js_datetime_to_iso_string(date_string)`

Converts a datetime to ISO datetime format string (for `<input type="datetime-local">` values). Used in generated CRUD `form.ree` templates for datetime fields.

```ts
js_datetime_to_iso_string(dateInput: string | Date): string
```

**Template example:**

```ree
<input type="datetime-local" id="verified_at" name="verified_at" value="{~ js_datetime_to_iso_string(record.verified_at) }" />
```

#### `js_timestamp_to_iso_string(date_string)`

Converts a timestamp to ISO datetime format string with seconds.

```ts
js_timestamp_to_iso_string(dateInput: string | Date): string
```

#### `url(path)`

Ensures a path starts with `/` (useful for href attributes).

```ts
url(path: string): string
```

**Template example:**

```ree
<a href="{= url('dashboard') }">Dashboard</a>
<a href="{= url('/profile') }">Profile</a>
```

#### `localized_path(canonical_path)`

Converts a canonical URL path to the current locale's localized version using the pre-built route maps. All internal links, form actions, and redirects should use this helper so they work in every configured locale.

```ts
localized_path(canonicalPath: string): string
```

When the current locale is Slovenian (`sl-si`), `/auth/login` becomes `/avtentikacija/prijava`. If no localization exists, the canonical path is returned unchanged.

**Template example:**

```ree
<a href="{~ localized_path('/auth/login') }">Login</a>
<a href="{~ localized_path('/auth/profile') }">Profile</a>
<form method="POST" action="{~ localized_path(props.action) }">
```

See [CONTEXT.md](CONTEXT.md#route-alias) for documentation on URL localization via `route_name` keys in locale files.

#### `is_current(page_url)`

Returns CSS classes to highlight current page in navigation.

```ts
is_current(pageUrl: string): string
```

Returns `"font-bold nav-item current"` if the current page matches, otherwise `"nav-item"`.

**Template example:**

```ree
<nav>
  <a href="/home" class="{= is_current('/home') }">Home</a>
  <a href="/about" class="{= is_current('/about') }">About</a>
</nav>
```

### Additional Built-in Helpers

These helpers are also available in every template without passing them:

| Helper | Signature | Description |
| --- | --- | --- |
| `pill(text, class_name)` | `(string, string) => string` | Wraps text in a styled `<div>` with the given CSS class |
| `tags(val, color_class?, tag_translations?)` | `(string, string?, Record<string,string>?) => string` | Renders comma-separated tags as styled pills |
| `human_bytes(bytes)` | `(number) => string` | Formats bytes as human-readable (e.g. `"1.5 MB"`) |
| `is_checked(key, value, filter_params)` | `(string, string\|number, Record<string,string>) => boolean` | Checks if a filter value is active in URL params |
| `urlencode(str)` | `(string) => string` | URL-encodes a string |
| `urldecode(str)` | `(string) => string` | URL-decodes a string |
| `md(source)` | `(string) => string` | Renders a `markdown`-type field's stored value to HTML via `Bun.markdown.html()` - use with unescaped output (`{~ md(record.field) }`) |
| `image_thumbnail(src, size?)` | `(string, number?) => string` | Renders a square thumbnail `<img>` for a stored image path (default 100px), or a placeholder box when empty |
| `file_link(src)` | `(string) => string` | Renders a filename/download `<a>` link for a stored file path, or an em-dash when empty |
| `file_icon_name(filename)` | `(string) => string` | Resolves a `<ree-icon>` name from a filename's extension (PDF, Word, Excel, CSV, PowerPoint, Zip), falling back to a generic file icon |
| `key_values(obj)` | `(Record<string,any>) => string` | Renders object as HTML attribute key=value pairs |
| `nav_label(key, nav?)` | `(string, Record<string,any>?) => string` | Looks up a navigation label by dot-separated key |

### Custom Ad-hoc Helpers

You can pass custom helper functions in the `data` object. They become available directly in your template.

#### Basic Example

**Route handler:**

```typescript
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";

export async function GET_my_page(req: BunRequest) {
	const ctx = await create_ctx(req, import.meta.dir);
	return render("my-template", {
		data: {
			users: [
				{ id: 1, name: "alice", role: "admin" },
				{ id: 2, name: "bob", role: "user" },
			],
			// Custom helpers passed in data (no separate `helpers` option)
			uppercase: (text) => text.toUpperCase(),
			badge_color: (role) => (role === "admin" ? "bg-red-500" : "bg-blue-500"),
		},
		ctx,
	});
}
```

**Template (`my-template.ree`):**

```ree
<table>
  {#each props.users as user }
    <tr>
      <td>{= uppercase(user.name) }</td>
      <td><span class="{= badge_color(user.role) }">{= user.role }</span></td>
    </tr>
  {/each}
</table>
```

#### Combining Multiple Helpers

```typescript
const ctx = await create_ctx(req, import.meta.dir);
return render("dashboard", {
	data: {
		records: data,
		format_price: (amount) => `$${(amount / 100).toFixed(2)}`,
		format_date: (date) => new Date(date).toLocaleDateString("en-us"),
		status_badge: (status) => {
			const colors = { pending: "yellow", active: "green", inactive: "gray" };
			return `<span class="badge-${colors[status]}">${status}</span>`;
		},
	},
	ctx,
});
```

**Template:**

```ree
{#each props.records as record }
  <div class="card">
    <h3>{= record.title }</h3>
    <p>Price: {~ format_price(record.amount) }</p>
    <p>Updated: {= format_date(record.updated_at) }</p>
    <div>{~ status_badge(record.status) }</div>
  </div>
{/each}
```

### Helper Scope and Availability

- **Default helpers** (yes_no, js_date_to_locale_string, etc.) are always available - auto-injected by `render()`
- **Custom helpers** are passed as functions in the `data` object, called with `()` syntax
- **No separate `helpers` option** in `render()` - use `data` for custom helper functions
- **Default helpers can be overridden** by passing a function with the same name in `data`

---

### `get_render()`

Returns the raw render function for cases where you need to render a template to a string rather than a `Response` - for example, rendering email bodies or partial fragments.

```ts
const render_template = get_render();
const html = await render_template("emails/welcome", { name: "Alice" });
```

Throws if called before `initialize_render()`.

---

## Locale Resolution

`locale` is resolved in priority order:

1. `X-Locale` request header
2. `locale` cookie
3. `default_locale` from `config/supported_locales.ts`

---

## Usage Examples

### Basic route handler

```ts
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";

export async function GET(req: BunRequest) {
	const ctx = await create_ctx(req, import.meta.dir);
	return render("home/index", { data: { title: "Welcome" }, ctx });
}
```

### Passing a custom status code

```ts
const ctx = await create_ctx(req, import.meta.dir);
return render("errors/not-found", {
	data: { message: "Page not found" },
	status: 404,
	ctx,
});
```

### Adding custom response headers

```ts
const ctx = await create_ctx(req, import.meta.dir);
return render("dashboard/index", {
	data: { user },
	status: 200,
	headers: {
		"Cache-Control": "no-store",
		"X-Frame-Options": "DENY",
	},
	ctx,
});
```

### Rendering to a string (e.g. for emails)

```ts
import { get_render } from "$lib/render";

const render_template = get_render();
const emailHtml = await render_template("emails/welcome", { name: "Alice" });
```

### With multiple custom helpers

```typescript
const ctx = await create_ctx(req, import.meta.dir);
return render("products/list", {
	data: {
		products: await get_products(),
		search_query: new URL(req.url).searchParams.get("q"),
		// Custom helpers passed in data (no separate `helpers` option)
		price: (cents) => `$${(cents / 100).toFixed(2)}`,
		pub_date: (iso) => new Date(iso).toLocaleDateString(),
		stock_class: (qty) => (qty > 0 ? "in-stock" : "out-of-stock"),
		badge: (text, color = "blue") => `<span class="badge badge-${color}">${text}</span>`,
	},
	status: 200,
	ctx,
});
```

**Template:**

```ree
{#each props.products as product }
  <div class="product {= stock_class(product.quantity) }">
    <h2>{= product.name }</h2>
    <p>{~ price(product.price_cents) }</p>
    <p>Published: {= pub_date(product.created_at) }</p>
    <p>{~ badge(product.category, "green") }</p>
  </div>
{/each}
```

---

## Common Patterns for Beginners

### Pattern 1: Simple Formatting

Use helpers (passed in `data`) for one-off transformations of props.

```typescript
// In route handler, pass helper in data:
data: {
  records: data,
  shout: (text) => text.toUpperCase() + "!!!",
}
```

```ree
<p>{~ shout(record.message) }</p>  <!-- Output: "HELLO!!!" -->
```

### Pattern 2: Conditional Display

Use helpers to return different output based on a value.

```typescript
data: {
  records: data,
  account_status: (days_active) => {
    if (days_active < 7) return '<span class="new">New</span>';
    if (days_active < 30) return '<span class="active">Active</span>';
    return '<span class="veteran">Veteran</span>';
  },
}
```

```ree
{~ account_status(record.days_active) }
```

### Pattern 3: Chaining Data Transformation

Process data before display using helper logic.

```typescript
data: {
  records: data,
  initials: (first_name, last_name) =>
    (first_name[0] + last_name[0]).toUpperCase(),
  avatar_color: (user_id) => {
    const colors = ["red", "blue", "green", "yellow", "purple"];
    return colors[user_id % colors.length];
  },
}
```

```ree
<div class="avatar avatar-{= avatar_color(record.user_id) }">
  {= initials(record.first_name, record.last_name) }
</div>
```

### Pattern 4: Combining Default + Custom Helpers

You can use both default helpers and custom ones together. Default helpers are always available without passing them.

```typescript
data: {
  records: data,
  status_with_date: (status, date) => {
    const status_html = yes_no(status === "active", "both");
    const date_str = js_date_to_locale_string(date);
    return `${status_html} (${date_str})`;
  },
}
```

---

## Best Practices - Using `{#with}`

### Translation lookups don't need `{#with}`

`{_ path }` / `{- path }` already resolve against `props.translations` directly, with no repeated prefix
to eliminate and no missing-key crash risk - so wrapping a section in `{#with props.ui}`
to shorten repeated `props.ui.x` accesses is not needed for translation data:

```ree
<!-- No {#with} needed - {_ } already strips the prefix and adds a {last_segment} safety net -->
<h1>{_ ui.title }</h1>
<p>{_ ui.description }</p>
<h2>{_ ui.mission_title }</h2>
<p>{_ ui.mission_text }</p>
```

`{#with}` is still useful for non-translation data accessed repeatedly - `props.record`, a loop item, a
CRUD `props.columns` block - see below.

### `delete` is a JavaScript keyword

Bare identifiers inside a `{#with}` block that shadow JS reserved words cause a `SyntaxError` at template
compile time (`{= delete}` inside `{#with props.actions}`, for example). `{_ actions.delete}` sidesteps
this entirely - the path is parsed as a string, not evaluated as a bare JS identifier, so keyword
collisions never happen:

```ree
<!-- ✅ Works - {_ } never hits the keyword problem -->
<h2>{_ actions.delete}</h2>
<button>{_ actions.abort_delete}</button>
<button>{_ actions.confirm_delete}</button>
```

If you're inside a `{#with}` block for non-translation data and need a translation whose key happens to be
a keyword, `{_ }` still works unchanged since it doesn't participate in `with` scoping at all - it always
resolves against `props.translations` regardless of what `{#with}` block it's nested in.

### Local variables always win

Local variables (including destructured `props`, inner `{#each}` loop variables, and helpers) always take
precedence over `{#with}` context properties. This means you can mix `{#with}` with other blocks safely:

```ree
{#with props.record}
  {= name }

  {#if (props.record.id) && props.enable_delete }
    <!-- props is a local var → resolves correctly, not shadowed by with context -->
    <button>{_ actions.delete}</button>
  {/if}
{/with}
```

Helpers (`yes_no`, `localized_path`, `display_currency`, etc.) are injected as local variables at function scope, so they work normally inside `{#with}` blocks.

### Composition with `{#if}` and `{#each}`

`{#with}` nests cleanly inside control flow blocks:

```ree
{#each props.records as record}
  {#with record}
    <tr>
      <td>{= id }</td>
      <td>{= name }</td>
    </tr>
  {/with}
{:else}
  <p>{_ ui.no_records }</p>
{/each}
```

### `{#with}` scope doesn't reach into component slots

A custom-element tag's slot content (`<app-banner>...</app-banner>`) is compiled into its own slot
function, invoked with the raw top-level `props` object - **not** the `with`-scoped alias an enclosing
`{#with}` block created. Bare identifiers that only resolve through that `with` scope will throw
`ReferenceError: x is not defined` at render time, even though the exact same expression works fine
outside the component tag:

```ree
{#with props}
  {#if form_error}
    <!-- ❌ Breaks - form_error is not in scope inside the slot function -->
    <app-banner type="red">{= form_error}</app-banner>
  {/if}
{/with}
```

```ree
{#with props}
  {#if form_error}
    <!-- ✅ Works - props is always the real top-level object -->
    <app-banner type="red">{= props.form_error}</app-banner>
  {/if}
{/with}
```

Always use a fully-qualified `props.x` path (or `record.x`, etc. - whatever the outer non-`with` variable
is) for any expression inside a component tag's slot content. `{_ }`/`{- }` translation lookups are
unaffected since they never participate in `with` scoping to begin with.

### Nested `{#with}` blocks

You can nest `{#with}` blocks - the inner scope shadows the outer one for matching properties. `{_ }`/`{- }`
are unaffected by nesting depth, since they always resolve against `props.translations`, not the current
`with` scope:

```ree
{#with props.record}
  <h2>{_ child_ui.new_title }</h2>  <!-- unaffected by the {#with props.record} scope -->

  {#each items as item}
    <span>{= item.name }</span>     <!-- record's local scope still applies to non-translation data -->
  {/each}
{/with}
```

### CRUD template pattern - `{#with props}` + `{#with record}`

Generated CRUD index templates use a two-tier `{#with}` pattern to keep headers and cells clean for
non-translation, structural data (`columns`, the loop's `record`). The headers section is wrapped with
`{#with props}`, and each data row is wrapped with `{#with record}` (where `record` is the `{#each}` loop
variable). Translation lookups inside either block use `{_ }`/`{- }`, not the `with` scope:

```ree
<!-- HEADERS: wrapped with {#with props} → bare columns names; labels use {_ } -->
{#with props}
  <div>ID</div>
  <div class="{= columns.name.class }">{_ labels.name }</div>
  <div class="{= columns.email.class }">{_ labels.email }</div>
{/with}

<!-- ROWS: each record wrapped with {#with record} → bare field names -->
{#each props.records as record}
  {#with record}
    <div>{= id }</div>
    <div class="{= props.columns.name.class }">{= name }</div>
    <div class="{= props.columns.email.class }">{= email }</div>
  {/with}
{/each}
```

Key points:

- **Headers** (`{#with props}`): `{= columns.name.class }` resolves as `props.columns.name.class` (structural data, stays `{= }`). `{_ labels.name }` resolves against `props.translations.labels.name` regardless of the `with` scope.
- **Cells** (`{#with record}`): `{= name }` resolves as `record.name`. The class still uses the full `{= props.columns.name.class }` path because `props` is a local variable that takes precedence over the with context.
- **Nested child grids**: Child headers also use `{#with props}`, child rows use `{#with child}` for their cells - same pattern, different loop variable. Note `child_ui`/`child_fields` are handler-flattened plain data (from the child route's own `ctx.translations`, resolved separately), not `props.translations` - they stay `{= }`, not `{_ }`.
- **Generator alignment**: The `render_field_header()` function emits bare `{= columns.* }` (no `props.` prefix, structural data) and `{_ labels.* }` (translation, ignores `with` scope) - both expecting the `{#with props}` wrapper for the structural half. The `render_field_cell()` function emits bare `{= name }` field names (no `record.` prefix), expecting the `{#with record}` wrapper.

### When NOT to use `{#with}`

- **One-off accesses** - a single `props.xxx.yyy` doesn't justify wrapping
- **Translation lookups** - use `{_ }`/`{- }` directly, no wrapping needed or beneficial
- **Mixed sub-objects** - if a section accesses `props.record.z` and other unrelated data equally, one `{#with}` can't simplify all of it
- **Inside `<script>` tags with mixed references** - the overhead of tracking scope across long script blocks isn't worth it; keep full paths in scripts

---

## Template Engine (`$lib/template.ts`)

`create_template_engine` creates and configures the underlying template engine.

```ts
import { create_template_engine } from "$lib/template";

const engine = create_template_engine(is_dev);
```

| Option         | Dev value     | Prod value    |
| -------------- | ------------- | ------------- |
| `views`        | `apps/main`   | `apps/main`   |
| `shared_views` | `platform`    | `platform`    |
| `project_root` | repo root     | repo root     |
| `cache`        | `false`       | `true`        |
| `ext`          | `.ree`        | `.ree`        |
| `autoEscape`   | `true`        | `true`        |

Templates use the `.ree` extension and are resolved relative to the `apps/main/`
directory. A name with no file there and no matching mounted module falls back to
`shared_views` (`platform/`), which is how `render("notfound")` and the auth pages
resolve identically from all three apps.

---

## Template Engine - Full Reference

The engine is a file-based template compiler inspired by Eta.js and Svelte, optimised for the Bun runtime. It compiles `.ree` files to async functions and optionally caches them in production.

### Template Syntax

#### Output tags

| Tag         | Behaviour                      | Example                         |
| ----------- | ------------------------------ | ------------------------------- |
| `{= expr }` | Escaped HTML output            | `{= user.name }`                |
| `{~ expr }` | Unescaped / raw HTML output    | `{~ content.html }`             |
| `{_ path }` | Translation lookup, escaped    | `{_ labels.text_input }`        |
| `{- path }` | Translation lookup, unescaped  | `{- descriptions.card }`        |
| `{@ path }` | Translation lookup, markdown   | `{@ descriptions.card }`        |
| `{{ ... }}` | Raw JavaScript (double braces) | `{{ const x = items.length; }}` |

HTML escaping converts `& < > " '` to their entity equivalents. Use `{~ }` only when you fully trust the content.

#### Translation lookup tags: `{_ path }` / `{- path }` / `{@ path }`

Use these for every read from `props.translations` (labels, `ui.*`, `errors.*`, `messages.*`,
`descriptions.*`, `actions.*`, `nav`, `nav_prefix_title`, `nav_auth`, ...). `path` must be a simple
dotted property path - no arbitrary JS, no computed keys, no function calls:

```
{_ ui.title}
{_ labels.text_input}
{- descriptions.card}
{@ descriptions.card}
```

`{_ }` HTML-escapes; `{- }` does not, for the rare translation value that legitimately contains markup.
`{@ }` renders the resolved value through markdown (via `Bun.markdown.html`) to HTML - use it for a
translation value authored as markdown source (headings, lists, `**bold**`, links). An empty/absent
value renders nothing.
On a missing key - including `props.translations` being absent entirely, which is normal while
scaffolding a route's layout before its translation keys are wired up - all three render `{last_segment}`
(e.g. `{_ labels.text_input}` on a miss renders `{text_input}`), never throwing and never silently
rendering empty. This is the same marker convention `mark_missing_from()` (`lib/i18n.ts`) and
`nav_label()` use elsewhere. (`{@ }` wraps that `{text_input}` marker in a `<p>` per markdown rules.)

`{= }`/`{~ }` can technically still reach `props.translations` directly (`{= props.translations.ui.title }`)
but this is discouraged - it bypasses the missing-key marker, so a typo or an unwired key silently
renders as `""` instead of showing up as `{title}`. Reserve `{= }`/`{~ }` for everything that is not a
translation lookup: `props.user`, `props.record`, loop variables, computed expressions.

Translation lookup remains separate from direct value rendering so template expressions do not need ambiguous prefix-matching behavior.

#### Control flow

```
{#if condition }
  ...
{:else}
  ...
{/if}
```

```
{#switch value }
  {#case 10}
    ...
  {#case 100}
    ...
  {:else}
    ...
{/switch}
```

`{#switch}` compares the value with each `{#case}` expression using strict equality (`===`) and renders the first matching branch; `{:else}` (optional, must be last) is the default. This covers the `{:else if}` chains the engine deliberately does not support. The switch expression and case values may be any JS expression (`props.status`, `"admin"`, etc.).

{#each list as item, index }
  ...
{/each}

{#each list as item, index, key }
  ...
{/each}

{#each list as item }
  ...
{:else}
  (rendered when list is empty)
{/each}
```

`{#each}` works on both arrays and objects. For objects, `item` is the value and `key` is the property name.

#### Layouts and includes

```
{#layout('layouts/base') }
{#layout('layouts/base', { title: 'Home' }) }
```

Declares the layout for the current template. The rendered body of the current template is passed to the layout as `body`. Only one layout per template is supported, and it should be declared at the top.

```
{#include('partials/nav') }
{#include('partials/card', { title, href }) }
```

Includes another template inline. The included template receives a merged copy of the current data plus any extra data object passed as the second argument.

#### Component includes

**Always use ReeTag (`<ree-tag></ree-tag>`) for component includes.** For cases where the props object itself must be computed (e.g. spreading additional fields), use `{#include("$components/name", computedProps)}` directly.

**ReeTag - `<tag-name>` custom-element syntax:**

```
<app-banner type="red">{= props.form_errors }</app-banner>
<product-card product={= product } badge={= is_new ? 'NEW' : '' }>
	{= product.name }
</product-card>
```

Any tag whose name contains **at least one hyphen** is treated as a component invocation. The pre-processor converts it internally to `{#include("<resolved include path>", {children: <compiled slot>, attributes: { "type": "red" }})}`. The include path is resolved by an index built at startup (`precompile_templates()`, self-healed lazily in dev) in this order:

1. `components/<tag-name>.ree` → `$components/<tag-name>` (a shared component always shadows a same-named routes-tree file)
2. Any `*.ree` file named `<tag-name>` in the routes tree → views-relative name (e.g. `<star-rating>` resolves `apps/main/examples/kitchen_sink/star-rating.ree` as `examples/kitchen_sink/star-rating`)
3. Any same-named file in a mounted route-module root → `<module-code>/<name>` (views-tree files beat module files for a duplicate tag)

A tag with no matching file anywhere is passed through as literal HTML (e.g. the native `<date-input>` web component). Because tag names are global, a route-local component with a duplicate basename is only resolved for templates in its own subtree if it is the first match in glob order - keep component tag names unique across the tree.

**Locale variants of ReeTag components** resolve the same way as their include kind: `components/` components go through the raw `$components/` include path, whose variant chain keys on `props.locale`; routes-tree/module components go through `render()` by name, whose variant chain keys on `props.lang`. Today named renders pass `locale` but not `lang`, so a locale-suffixed variant of a routes-tree component (`star-rating.sl.ree`) is dormant until `lang` is provided - the same dormant state as every locale-suffixed named template.

- Slot content is compiled as its own function and passed as `props.children` - it shares the parent's helpers and receives the same top-level `props` object, but it does **not** inherit any `{#with}` block the parent is nested in (see "`{#with}` scope doesn't reach into component slots" below)
- HTML attributes are passed as `props.attributes` - template expressions `{= expr }`, `{~ expr }`, `{_ path }`, and `{- path }` inside attribute values ARE compiled, evaluated at render time (e.g. `title="{_ ui.reset_btn }"` resolves against `props.translations` with the same `{last_segment}` miss-marker `{_ }` gives everywhere else). `{@ path }` is body-only - it emits block-level HTML that can't sit inside a quoted attribute, so it is deliberately not recognized here.
- Tags **without** a hyphen (e.g. `<banner>`) are treated as literal HTML and passed through unprocessed
- Reads more like HTML - components can be authored and read in a natural slot/content style
- The component receives `children` and reads from `props.children` instead of digging into `attributes.text`

**Attribute spread shorthand - `...expr`:**

```
<my-h1 ...rest class="foo">{= title }</my-h1>
<date-input ...props.translations.errors min="1900-01-01"></date-input>
```

Any `...expr` token in a tag's attribute region is expanded into the key/value pairs of the referenced object, evaluated at render time - equivalent to `{~ key_values(expr) }`. Works on ReeTag component tags, plain hyphen-less HTML elements, and custom elements without a matching `components/*.ree` file (like `<date-input>`). `expr` may be a bare identifier (`...rest`) or a dotted member path (`...props.translations.errors`); it does not support arbitrary expressions like function calls, bracket indexing, or ternaries - assign to a local first (`{{ const x = a[i]; }}`) if the value isn't already a plain path. Literal attributes after a spread win over spread properties, matching HTML's last-wins semantics.

**Direct `{#include(...)}` - for computed prop objects:**

```
{#include("$components/card", { title, href, ...extra_props })}
{#include("$components/badge", { label: get_badge_label(record), color: get_badge_color(record) })}
```

Use this form when the props object itself must be built dynamically (computed keys, spread operator, conditional inclusion of fields). For static attributes, prefer ReeTag - it reads more like HTML and the component receives `children` naturally.

#### `<auto-complete>` component

The `<auto-complete>` component (`components/auto-complete.ree`) renders a searchable dropdown for foreign key fields with live search, keyboard navigation, and autoscroll.

**Required attributes** (from generated forms):

| Attribute    | Description                          | Example                            |
| ------------ | ------------------------------------ | ---------------------------------- |
| `field-name` | Field name for the hidden input      | `legal_entity_registration_number` |
| `fk-table`   | Foreign key table for search queries | `legal_entities`                   |
| `fk-column`  | Foreign key column name              | `registration_number`              |
| `base-url`   | Base URL for the options endpoint    | `/partners/legal-entities`         |

**Optional attributes:**

| Attribute | Description                                  | Default |
| --------- | -------------------------------------------- | ------- |
| `rows`    | Number of visible rows (dropdown max-height) | `6`     |

**Example - generated form field:**

```html
<auto-complete
	field-name="legal_entity_registration_number"
	fk-table="legal_entities"
	fk-column="registration_number"
	base-url="/partners/legal-entities"
	rows="8"
></auto-complete>
```

The component inherits `props.labels`, `props.record`, and `props.selectors` from the parent render scope. The hidden input value is pre-populated from `props.record.{fieldName}`, and the search input is pre-populated from `props.record.{fieldName}_display` (set by the edit handler).

**Direct usage in any template:**

```ree
<auto-complete
	field-name="company_id"
	fk-table="companies"
	fk-column="id"
	base-url="/admin/companies"
	rows="10"
></auto-complete>
```

Just `rows` is enough to control dropdown height - `max-height` is computed as `rows × 32px`. If both `rows` and `max-height` attributes are set, `max-height` takes precedence.

#### `<image-upload>` component

The `<image-upload>` component (`components/image-upload.ree`, `static/image-upload.js`) is a click-to-browse / drag-and-drop widget that uploads directly to `POST /images/save` (the same endpoint the full `/images/new` editor uses) and writes the returned `s3_url` into a hidden input named by the `name` attribute, so it submits with the surrounding form like any other field. These endpoints are served by the reeman app (`apps/reeman/server.ts`).

**Attributes:**

| Attribute | Required | Description                                                             | Example         |
| --------- | -------- | ------------------------------------------------------------------------ | --------------- |
| `name`    | Yes      | Form field name for the hidden input holding the uploaded path            | `portrait_image`|
| `value`   | No       | Existing stored path, for edit forms                                     | `record.portrait_image` |
| `label`   | No       | Field label shown above the dropzone                                     | `Portrait Image`|
| `folder`  | No       | S3/local storage subfolder for the upload                                | `teams/members` |
| `module`  | No       | Module code required to upload - see Upload authorization below          | `admin`         |

**Example:**

```ree
<image-upload name="portrait_image" value="{= record.portrait_image }" folder="members" label="{_ labels.portrait_image }" module="admin"></image-upload>
```

**Upload authorization:** `POST /images/save` always requires an authenticated session (`require_auth`). When `module` is set, the component also sends it as a form field, and the server additionally checks `require_module(auth_ctx, module)` - the request is rejected with `403 Forbidden` if the current user lacks that module. Leaving `module` unset means any authenticated user can upload; it does not bypass auth entirely. The page embedding `<image-upload>` should itself be gated (e.g. via `module` on its `RouteDefinition`, see [routes/AGENTS.md](../apps/main/AGENTS.md)) - the component only protects the upload action, not page visibility.

**Generator integration:** a column whose name ends in `_image` is auto-detected as `field.type === "image"` (see `IMAGE_SUFFIXES` in `config/db_structure.ts`) and gets:
- A form field rendered via `<image-upload>` (`generator/templates/fields/image.ree`).
- A grid cell rendered via `{~ image_thumbnail(record.field) }` - a 100x100 thumbnail helper (`lib/template_helpers.ts`), falling back to a placeholder box when empty.
- A `domain: "image"` entry in the generated `schema/table.ts` `columns` map, checked against the canonical `VARCHAR(255)` SQL type by `check_domain_compliance`.

`generate_input_field` (`generator/crud/form_ree.ts`) does not know a route's `module` at generation time, so the generated `<image-upload>` tag never sets `module` automatically - add it by hand to the generated `form.ree` where an upload should be gated.

**Seeding without the browser:** `bun reeman upload-image <table> <id> <column> <path|url> [--folder <name>] [--format webp|jpeg|png|avif] [--quality <1-100>]` (`generator/reeman/upload_image.ts`) runs a local file or remote URL through the same image pipeline (`lib/image_processor`) and writes the resulting URL straight into `<table>.<column> WHERE id = <id>` - no editor UI needed. Used to seed demo data from a module's install script.

#### `<file-upload>` component

The `<file-upload>` component (`components/file-upload.ree`, `static/file-upload.js`) is the document counterpart to `<image-upload>` - a click-to-browse / drag-and-drop widget that uploads directly to `POST /system/files/save` and writes the returned `s3_key` into a hidden input named by the `name` attribute, so it submits with the surrounding form like any other field. Accepted extensions: `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.txt`, `.csv`, `.zip`.

**Attributes:**

| Attribute       | Required | Description                                                        | Example         |
| --------------- | -------- | -------------------------------------------------------------------- | --------------- |
| `name`          | Yes      | Form field name for the hidden input holding the uploaded path       | `attachment_file` |
| `value`         | No       | Existing stored path, for edit forms                                 | `record.attachment_file` |
| `label`         | No       | Field label shown above the dropzone                                 | `Attachment`    |
| `folder`        | No       | S3/local storage subfolder for the upload (static, ignored if `show-folder` is set) | `invoices` |
| `folder-input`  | No       | ID of an existing input element to read the folder value from instead | `folder_field`  |
| `show-folder`   | No       | Renders its own folder text input above the dropzone (`"true"`)      | `true`          |
| `module`        | No       | Module code required to upload - same authorization model as `<image-upload>` | `admin` |

**Example:**

```ree
<file-upload name="attachment_file" value="{= record.attachment_file }" folder="invoices" label="{_ labels.attachment_file }" module="admin"></file-upload>
```

**Upload authorization:** identical model to `<image-upload>` - `POST /system/files/save` requires an authenticated session, and setting `module` additionally requires `require_module(auth_ctx, module)` server-side.

**Generator integration:** a column whose name ends in `_file` is auto-detected as `field.type === "file"` (see `FILE_SUFFIXES` in `config/db_structure.ts`) and gets:
- A form field rendered via `<file-upload>` (`generator/templates/fields/file.ree`).
- A grid cell rendered via `{~ file_link(record.field) }` - a filename/download-link helper (`lib/template_helpers.ts`) that renders an em-dash when empty. A companion `file_icon_name(filename)` helper resolves a `<ree-icon>` name by extension (PDF, Word, Excel, CSV, PowerPoint, Zip), falling back to a generic file icon.
- A `domain: "file"` entry in the generated `schema/table.ts` `columns` map, checked against the same canonical `VARCHAR(255)` SQL type as image fields by `check_domain_compliance`.

#### CRUD form-field ReeTags (`--template-tags tags` mode)

The Reeman CRUD generator's `--template-tags tags` flag (see [generator/AGENTS.md](../generator/AGENTS.md) "`--template-tags`") renders each form field as a single ReeTag call instead of the default inlined `<input>`/`<select>` markup. Each of the following components self-contains its own `<field-wrapper>`/`<label>`/`<validation-error>` and reads `name`/`label`/`value` from `props.attributes`:

| Component (`components/`)     | Generator field type      | Notes                                                                 |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------------- |
| `input-text.ree`               | `input` (default/text)     |                                                                        |
| `input-select.ree`             | `select`                   | Options via `props.options?.[name]`, not an HTML attribute            |
| `input-checkbox.ree`           | `checkbox`                 |                                                                        |
| `input-textarea.ree`           | `textarea`                 |                                                                        |
| `input-date-masked.ree`        | `date`                     | Wraps the `<date-input>` web component (masked, locale-aware) - pre-existing component, `input-date.ree` is a plain `<input type="date">` and is not used here |
| `input-datetime-local.ree`     | `datetime`/`timestamp`     | Plain `<input type="datetime-local">`, same as flat mode               |
| `input-yes-no.ree`             | `yes_no`                   | Hardcoded 0/1 `<select>`, labels via `props.selectors["0"]`/`["1"]`   |
| `input-markdown.ree`           | `markdown`                 | Wraps the `<markdown-editor>` web component                            |
| `input-tags-select.ree`        | `tags`                     | Checkbox-group against a fixed vocabulary (`props.tag_options?.[name]`) - **not** the same as `input-tags.ree` (free-text chip entry), a different widget entirely |
| `input-foreign-key.ree`        | plain foreign key          | Options via `props.fk_options?.[name]`                                |
| `auto-complete.ree`            | `autocomplete` foreign key | Existing component, unchanged - see dedicated section above           |
| `image-upload.ree`             | `image`                    | Existing component, unchanged - see dedicated section above           |
| `file-upload.ree`              | `file`                     | Existing component, unchanged - see dedicated section above           |

The generator's tag-mode wrapper calls are built in-memory (no `fields_tags/*.ree` files on disk) - see `TAGS_MODE_TAG`/`generate_tags_mode_field()` in `generator/crud/form_ree.ts`. Flat mode (`generator/templates/fields/*.ree`) still loads from disk via `apply_template()`.

### Path Resolution

Includes and layouts support several path styles:

| Prefix         | Resolves from                    | Example                         |
| -------------- | -------------------------------- | ------------------------------- |
| `$components/` | Project root `components/`       | `$components/button`            |
| `$lib/`        | Project root `lib/`              | `$lib/flash`                    |
| `./` or `../`  | Relative to the current template | `./sidebar`, `../shared/footer` |
| `/name`        | Views root (absolute)            | `/layouts/base`                 |
| `name`         | Views root (implicit)            | `layouts/base`                  |

Including a file with a non-`.ree` extension (e.g. `{#include('./styles.css') }`) injects its raw text content unescaped. Including a `.ree` file via an alias path compiles and renders it normally.

**Security:** path traversal outside the resolved base directory throws an error.

### Engine API

```ts
// Render a template file by name (views-root relative, no extension)
const html = await engine.render("home/index", data);

// Render from a template string directly
const html = await engine.renderString("<p>{= greeting }</p>", { greeting: "Hello" });

// Clear the compiled template cache (e.g. after hot-reload)
engine.clearCache();

// Write rendered output to a file (creates directories as needed)
await engine.writeOutput("dist/index.html", html);
```

**Precompiling at startup (`$lib/template/precompile.ts`):** call
`await precompile_templates(engine)` once on cold start. In prod it globs
`apps/main/`, mounted route-module roots, and `components/` for `*.ree`, compiles
each file once, and caches by template name and file path — `render()`, alias includes (`$components/…`), and ReeTag includes then hit memory instead of disk per
request (no per-render file read, no per-include recompile). It also builds the
component index (tag → include path) that powers ReeTag resolution from
`components/`, the routes tree, and module roots — see "Component includes"
above for the resolution order. Dev only builds thecomponent/name registry; templates still recompile per render for hot reload, and a tag missing from the
index triggers one lazy filesystem search (cached afterwards). The build is
two-pass — the complete component index is registered for every root before
any template is compiled, so ReeTag resolution never depends on root glob
order. A template that fails to compile aborts boot with a loud error listing
the offending file(s) (the project's fail-loud convention — no silent
fallback). `bootstrap()` already wires this in.

### Template examples

**Navigation menu**

```ree
<nav>
  {#each props.menuItems as item }
    <a href="{= item.url }" {#if item.active }class="active"{/if}>
      {= item.label }
    </a>
  {/each}
</nav>
```

**Iterating over an object**

```ree
{#each props.settings as value, i, key }
  <div>{= key }: {= value }</div>
{/each}
```

For objects, `item` is the value, `index` is the numeric position, and `key` is the property name.

**Pre-computing values before output**

```ree
{{ const sorted = props.posts.sort((a, b) => b.date - a.date) }}
{{ const recent = sorted.slice(0, 5) }}

{#each recent as post }
  <post-card post={= post }></post-card>
{/each}
```

**Form with per-field validation errors**

```ree
<form>
  {#each props.fields as field }
    <div class="field">
      <label>{= field.label }</label>
      <input name="{= field.name }" value="{= field.value || '' }">
      {#if field.error }
        <span class="error">{= field.error }</span>
      {/if}
    </div>
  {/each}
</form>
```

**Nested loops**

```ree
{#each categories as category }
  <section>
    <h2>{= category.name }</h2>
    <ul>
      {#each category.items as item }
        <li>{= item.title }</li>
      {/each}
    </ul>
  </section>
{/each}
```

---

## Troubleshooting

### Template Issues

**Unmatched braces / syntax error** - CSS and JS object literals like `{ color: red }` won't be parsed as tags since the engine only recognises `{=`, `{~`, `{#`, `{:`, `{/`, and `{{`. If you see unexpected output, check for a stray tag prefix.

**Template file not found** - the path is resolved relative to the `views` directory (or the alias root for `$components/` etc.). Verify the file exists without the extension, e.g. `engine.render("pages/home")` maps to `<views>/pages/home.ree`.

**Unclosed block error** - every `{#if}` needs `{/if}` and every `{#each}` needs `{/each}`. The error message lists which block types are still open.

**Multiple `{:else}` in same block** - only one `{:else}` is allowed per `{#if}` or `{#each}`.

**Include path escapes base directory** - path traversal outside the resolved root (e.g. `../../../../etc/passwd`) is blocked and throws. Use alias paths (`$lib/`, `$components/`) to reference files outside `views/`.

### Helper Issues

**"[function] is not defined"** - The helper function isn't available in the template. If it's a custom helper, make sure you pass it in the `data` object. Default helpers (yes_no, js_date_to_locale_string, etc.) are auto-injected.

```typescript
// ✅ CORRECT - custom helper passed in data
return render("template", {
	data: {
		records: data,
		uppercase: (x) => x.toUpperCase(),
	},
	ctx,
});
```

**"[function] is not a function"** - The helper exists but isn't being called correctly. Helpers must be functions that return a value.

```ree
{~ uppercase(record.name) }  <!-- ✅ Correct -->
{= uppercase(record.name) }  <!-- ✅ Also correct, escapes HTML -->
{~ record.uppercase }        <!-- ❌ Wrong - accessing as property -->
```

**Helper receives wrong type** - Make sure the data you pass matches what the helper expects.

```typescript
// ❌ Helper expects string but receives number
data: {
	shout: (text) => text.toUpperCase() + "!!!", // Will fail if text is a number
}

// ✅ Better - handle multiple types
data: {
	shout: (val) => String(val).toUpperCase() + "!!!",
}
```

**Helper can't access template variables** - Helpers only receive what you pass as arguments.

```ree
<!-- ❌ WRONG - helper can't see 'user' variable -->
{~ format_name(user) }

<!-- ✅ CORRECT - pass the value as argument -->
{~ format_name(record.user_name) }
```

---

## Global Template Variables (`lib/bootstrap.ts`)

`base_data` in `lib/bootstrap.ts` is passed to `initialize_render()` and merged into **every** template render automatically. No need to pass these values per-route.

| Variable                   | Type / Value                           | Description                                         |
| -------------------------- | -------------------------------------- | --------------------------------------------------- |
| `site_name`                | `string` - `"reepolee App v<version>"` | App name with version from `package.json`           |
| `year`                     | `number` - current year                | Useful for copyright footers                        |
| `is_dev`                   | `boolean`                              | `true` when server started with `--dev`             |
| `app_name`                 | `"main" \| "reeman" \| "reeqa"`     | Current application identity                         |
| `version`                  | `string`                               | Package version in production, short timestamp in dev |
| `dev_apps`                 | `Dev_app_link[]`                       | Local application links in development only          |
| `nav_groups`               | `NavRouteGroup[]`                      | Navigation groups built from registered routes        |
| `busy_poller`              | `boolean`                              | Enables busy-state polling for ReeQA                  |

These merge with any per-render `data` argument. Per-render data takes precedence over `base_data`.

### Using global variables in templates

```html
<footer>© {= year } {= site_name }</footer>

{#if is_dev }
<div class="dev-banner">Development mode</div>
{/if}
```

---

## Dev Mode Behaviour

When `is_dev` is `true`:

- **Template caching is disabled** - file changes are reflected immediately without restarting.
- **Live reload** is injected into every HTML response via `inject_live_reload()`.
- **`toJSON` / `toPrettyJSON`** debug variables are available in templates.
- **SSE endpoint** `/__reload` is registered for the live-reload client connection.
- **File watcher** is started via `start_watcher(notify_clients)` to push reload events on file changes.

---

## Migration Reference

### From EJS

| EJS                   | REE               |
| --------------------- | ----------------- |
| `<%= value %>`        | `{= value }`      |
| `<%- rawHtml %>`      | `{~ rawHtml }`    |
| `<% code %>`          | `{{ code }}`      |
| `<%- include('x') %>` | `{#include('x')}` |

### From Handlebars

| Handlebars        | REE                      |
| ----------------- | ------------------------ |
| `{{ value }}`     | `{= value }`             |
| `{{{ raw }}}`     | `{~ raw }`               |
| `{{#each items}}` | `{#each items as item }` |
| `{{#if cond}}`    | `{#if cond }`            |

### From Svelte

| Svelte                  | REE                      |
| ----------------------- | ------------------------ |
| `{value}`               | `{= value }`             |
| `{@html raw}`           | `{~ raw }`               |
| `{#each items as item}` | `{#each items as item }` |
| `{#if cond}`            | `{#if cond }`            |

---

## Complete Page Example

```ree
{#layout('layouts/main', { pageTitle: 'Product Catalog' })}

{{ const featured = props.products.filter(p => p.featured) }}
{{ const regular = props.products.filter(p => !p.featured) }}

<section class="featured">
  <h2>Featured Products</h2>
  <div class="grid">
    {#each featured as product, index }
      <product-card badge={= index === 0 ? 'NEW' : '' }>{= product.name }</product-card>
    {:else}
      <p>No featured products</p>
    {/each}
  </div>
</section>

<section class="catalog">
  <h2>All Products</h2>
  {#if regular.length > 0 }
    <div class="grid">
      {#each regular as product }
        <product-card product={= product }></product-card>
      {/each}
    </div>
  {:else}
    <p>Coming soon!</p>
  {/if}
</section>

<newsletter-signup></newsletter-signup>
```

---

## Complete Route Handler Example with Helpers

```typescript
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";

export async function GET_products(req: BunRequest) {
	const ctx = await create_ctx(req, import.meta.dir);
	const products = await get_products();

	return render("products/list", {
		data: {
			products,
			page_title: "Our Products",
			// Custom helpers passed in data (no separate `helpers` option)
			price: (cents) => `$${(cents / 100).toFixed(2)}`,
			publish_date: (iso) => new Date(iso).toLocaleDateString("en-us"),
			stock_badge: (quantity) => {
				if (quantity === 0) return '<span class="badge-red">Out of Stock</span>';
				if (quantity < 5) return '<span class="badge-yellow">Low Stock</span>';
				return '<span class="badge-green">In Stock</span>';
			},
			category_color: (category) => {
				const colors = { electronics: "blue", clothing: "pink", books: "purple" };
				return colors[category] || "gray";
			},
		},
		ctx,
	});
}
```

**Corresponding template:**

```ree
{#layout("layouts/shop")}

<h1>{= props.page_title }</h1>

<div class="product-grid">
  {#each props.products as product }
    <div class="product-card category-{= category_color(product.category) }">
      <h3>{= product.name }</h3>
      <p class="description">{= product.description }</p>

      <div class="price">{= price(product.price_cents) }</div>
      <div class="meta">{~ stock_badge(product.quantity) }</div>
      <div class="date">Available since {= publish_date(product.launch_date) }</div>

      <button>Add to Cart</button>
    </div>
  {:else}
    <p>No products available.</p>
  {/each}
</div>
```

---

## Missing Translation Keys

When a translation key is not found in the database, the system renders only the **last segment** of the key path. For example:

- Database key: `user.equipment.actions.new_equipment` → displays as `{new_equipment}`
- Database key: `actions.cancel` → displays as `{cancel}`

This behavior keeps the UI clean during development while still indicating that a key is missing. The full path is always available in the database and source code for reference.

**Implementation:** three producers share this convention. `mark_missing_from()` in `lib/i18n.ts` marks a missing value in a non-default locale when the default locale has that key, at translation-load time. `{_ path }` / `{- path }` template tags (see "Translation lookup tags" above) catch a key absent from `props.translations` entirely, at render time. `nav_label()` in `lib/template_helpers.ts` does the same for nav entries. All three extract only the last dot-segment for the placeholder.
