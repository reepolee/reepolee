# Render Module - `$lib/render.ts`

A lightweight rendering layer that wraps a template engine, injects shared context, and returns typed `Response` objects. Works alongside `$lib/template.ts` which configures the underlying engine.

---

## Setup

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
| `lang`              | `X-Lang` header → `lang` cookie → `en` | Active language code                  |
| `locale`            | `ctx.locale`                           | Locale string, e.g. `"sl-SI"`         |
| `user`              | Session resolved via `resolve_session` | Logged-in user object or `null`       |
| `toasts`            | `ctx.toasts`                           | Array of pending toast notifications  |
| `rendered_at`       | ISO timestamp string                   | Render timestamp                      |
| `prefix`            | `ctx.prefix`                           | Route prefix or `null`                |
| `csrf_token`        | `X-CSRF-Token` request header          | CSRF token for forms                  |
| `dark_mode`         | `ctx.dark_mode`                        | Boolean, dark mode preference         |
| `theme_class`       | `ctx.theme_class`                      | CSS class for theme                   |
| `active_languages`  | Filtered language list                 | Available languages for language switch|
| `language_names`    | Language name map                      | Map of language codes to display names|
| `translations`      | `ctx.translations`                     | Merged translations for this request's lang + route namespace. Read via `{_ path }` / `{- path }`, not directly |

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
- `locale` - Language code (default: `props.locale`, resolved from the active language)

**Template example:**

```ree
<p>Created: {= js_date_to_locale_string(record.created_at) }</p>
<p>Joined: {= js_date_to_locale_string(record.joined_date, "en-US") }</p>
```

#### `js_time_to_locale_string(date_string, locale?)`

Formats a date string's time portion according to locale (h:mm AM/PM format).

```ts
js_time_to_locale_string(dateString: string | Date, locale?: string): string
```

**Parameters:**

- `date_string` - ISO date string
- `locale` - Language code (default: `props.locale`)

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
- `locale` - Language code (default: `props.locale`)

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
<p>{~ display_currency(record.tax, "en-US", false, "$") }</p>
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

Converts a canonical URL path to the current language's localized version using the pre-built route maps. All internal links, form actions, and redirects should use this helper so they work in every language.

```ts
localized_path(canonicalPath: string): string
```

When the current language is Slovenian (`sl`), `/auth/login` becomes `/avtentikacija/prijava`. If no localization exists, the canonical path is returned unchanged.

**Template example:**

```ree
<a href="{~ localized_path('/auth/login') }">Login</a>
<a href="{~ localized_path('/auth/profile') }">Profile</a>
<form method="POST" action="{~ localized_path(props.action) }">
```

See [CONTEXT.md](CONTEXT.md#route-alias) for documentation on URL localization via `route_name` keys in the translations table.

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
		format_date: (date) => new Date(date).toLocaleDateString("en-US"),
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

## Language Resolution

`lang` is resolved in priority order:

1. `X-Lang` request header
2. `lang` cookie
3. Falls back to `"en"`

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
- **Nested child grids**: Child headers also use `{#with props}`, child rows use `{#with child}` for their cells - same pattern, different loop variable. Note `child_ui`/`child_fields` are handler-flattened plain data (from the child route's own `ctx.translations`, resolved separately), not `props.translations` - they stay `{= }`, not `{_ }`. See `internals/adr/0001-translation-lookup-tags.md`.
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

| Option       | Dev value   | Prod value  |
| ------------ | ----------- | ----------- |
| `views`      | `../routes` | `../routes` |
| `cache`      | `false`     | `true`      |
| `ext`        | `.ree`      | `.ree`      |
| `autoEscape` | `true`      | `true`      |

Templates use the `.ree` extension and are resolved relative to the `routes/` directory.

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

See `internals/adr/0001-translation-lookup-tags.md` for the full design rationale.

#### Control flow

```
{#if condition }
  ...
{:else}
  ...
{/if}
```

```
{#each list as item }
  ...
{/each}

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

Any tag whose name contains **at least one hyphen** is treated as a component invocation. The pre-processor converts it internally to `{#include("$components/tag-name", {children: <compiled slot>, attributes: { "type": "red" }})}`.

- Slot content is compiled in the parent's scope and passed as `props.children`
- HTML attributes are passed as `props.attributes` - template expressions `{= expr }`, `{~ expr }`, `{_ path }`, and `{- path }` inside attribute values ARE compiled, evaluated at render time (e.g. `title="{_ ui.reset_btn }"` resolves against `props.translations` with the same `{last_segment}` miss-marker `{_ }` gives everywhere else). `{@ path }` is body-only - it emits block-level HTML that can't sit inside a quoted attribute, so it is deliberately not recognized here.
- Tags **without** a hyphen (e.g. `<banner>`) are treated as literal HTML and passed through unprocessed
- Reads more like HTML - components can be authored and read in a natural slot/content style
- The component receives `children` and reads from `props.children` instead of digging into `attributes.text`

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

The `<image-upload>` component (`components/image-upload.ree`, `static/image-upload.js`) is a click-to-browse / drag-and-drop widget that uploads directly to `POST /system/images/save` (the same endpoint the full `/system/images/new` editor uses) and writes the returned `s3_url` into a hidden input named by the `name` attribute, so it submits with the surrounding form like any other field.

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

**Upload authorization:** `POST /system/images/save` always requires an authenticated session (`require_auth`). When `module` is set, the component also sends it as a form field, and the server additionally checks `require_module(auth_ctx, module)` - the request is rejected with `403 Forbidden` if the current user lacks that module. Leaving `module` unset means any authenticated user can upload; it does not bypass auth entirely. The page embedding `<image-upload>` should itself be gated (e.g. via `module` on its `RouteDefinition`, see [routes/AGENTS.md](../routes/AGENTS.md)) - the component only protects the upload action, not page visibility.

**Generator integration:** a column whose name ends in `_image` is auto-detected as `field.type === "image"` (see `IMAGE_SUFFIXES` in `config/db_structure.ts`) and gets:
- A form field rendered via `<image-upload>` (`generator/templates/fields/image.ree`).
- A grid cell rendered via `{~ image_thumbnail(record.field) }` - a 100x100 thumbnail helper (`lib/template_helpers.ts`), falling back to a placeholder box when empty.
- A `domain: "image"` entry in the generated `schema/table.ts` `columns` map, checked against the canonical `VARCHAR(255)` SQL type by `check_domain_compliance`.

`generate_input_field` (`generator/crud/form_ree.ts`) does not know a route's `module` at generation time, so the generated `<image-upload>` tag never sets `module` automatically - add it by hand to the generated `form.ree` where an upload should be gated.

### Path Resolution

Includes and layouts support several path styles:

| Prefix         | Resolves from                    | Example                         |
| -------------- | -------------------------------- | ------------------------------- |
| `$components/` | Project root `components/`       | `$components/button`            |
| `$routes/`     | Project root `routes/`           | `$routes/home/hero`             |
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

## Global Template Variables (`server.ts`)

`base_data` in `server.ts` is passed to `initialize_render()` and merged into **every** template render automatically. No need to pass these values per-route.

| Variable                   | Type / Value                           | Description                                         |
| -------------------------- | -------------------------------------- | --------------------------------------------------- |
| `site_name`                | `string` - `"reepolee App v<version>"` | App name with version from `package.json`           |
| `year`                     | `number` - current year                | Useful for copyright footers                        |
| `is_dev`                   | `boolean`                              | `true` when server started with `--dev`             |
| `url(p)`                   | `(p: string) => string`                | Ensures a path starts with `/`; use in `href` attrs |
| `menu_entries_crud_routes` | `CrudRoute[]`                          | CRUD routes flagged with `is_menu_entry: true`      |

These merge with any per-render `data` argument. Per-render data takes precedence over `base_data`.

### Using global variables in templates

```html
<footer>© {= year } {= site_name }</footer>

<a href="{= url('dashboard') }">Dashboard</a>

{#if is_dev }
<div class="dev-banner">Development mode</div>
{/if} {#each menu_entries_crud_routes as entry }
<a href="{= entry.path }">{= entry.label }</a>
{/each}
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
			publish_date: (iso) => new Date(iso).toLocaleDateString("en-US"),
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

**Implementation:** three producers share this convention. `mark_missing_from()` in `lib/i18n.ts` backfills a non-English language when English has a key it doesn't, at translation-load time. `{_ path }` / `{- path }` template tags (see "Translation lookup tags" above) catch a key absent from `props.translations` entirely, at render time. `nav_label()` in `lib/template_helpers.ts` does the same for nav entries. All three extract only the last dot-segment for the placeholder.
