# Generator Internals

Detailed reference for the CRUD generator system. This is a companion to [AGENTS.md](../AGENTS.md) - read that first for the high-level overview and MUST-FOLLOW conventions.

---

## Database - Generator-specific

### Approved `db.unsafe()` exceptions

`db.unsafe()` is prohibited for hand-written code. The following are the **only** approved exceptions:

**1. Generator templates (generated CRUD SQL)**

Files: `generator/templates/sql.ts`, `sql_view.ts`, `nested_sql.ts`, `sql_offset.ts`, `sql_view_offset.ts`

These templates generate per-table `sql.ts` files that use `db.unsafe()` for dynamic `ORDER BY` clauses where the column name cannot be a bound parameter. Safety is enforced by the template output itself:

- `sort_field` is validated against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` - rejects anything that isn't a bare identifier
- `sort_direction` is clamped to `['asc', 'desc']`
- The `scope_clause` parameter is injected by the caller via `global_scope.ts` helper
- All other values (search terms, cursor IDs, limits) use `?` bound parameters
- The `scope_clause` is wrapped in parentheses and validated by the scope system before reaching the SQL

The generated output is never hand-edited - if regenerated, it gets the same safe pattern.

**2. Infrastructure / generator tools (not runtime routes)**

Files: `generator/ddl_cache.ts`, `generator/crud/sql_ts.ts`, `generator/schema/sqlite/sqlite_introspector.ts`, `generator/reeman/db.ts`, `generator/reeman/run_sql_file.ts`, `generator/reeman/quick_start.ts`, `generator/simple-route/index.ts`, `generator/user.test.ts`, `scripts/mcp/index.ts`

These use `db.unsafe()` for:

- PRAGMA queries (SQLite introspection: `table_info`, `table_xinfo`, `foreign_key_list`, `index_list`)
- Running `.sql` files in the reeman
- `SHOW CREATE TABLE` / `SHOW CREATE VIEW` for MySQL column flags and view definitions
- Test setup/teardown

These run in CLI/development contexts, not in request handlers. They do not process user input in SQL strings - table names come from DB foreign keys or hardcoded values.

**3. Hand-written system CRUD routes**

Files: `apps/reeman/users/sql.ts`, `apps/reeman/images/sql.ts`, `apps/reeman/images/sql_view.ts`, `apps/reeman/translations/sql.ts`, `apps/reeman/global_scopes/sql.ts`

These are hand-written (not generator-produced). They use `db.unsafe()` with the same `sort_field` regex validation. Do not use them as templates for new routes; the generator templates are the approved path for dynamic `ORDER BY` queries.

**4. Locale-table reads and writes**

Files: `lib/locale_write.ts`, `lib/localized_copy.ts`, `generator/locale_tables/*`

Content localization stores each locale in its own physical table (`frameworks` for the default locale, `frameworks_sl_si` for the rest - see `internals/CONTEXT.md` "Content localization"). A table name cannot be a bound parameter, so every statement that targets a locale table is built as a string and run through `db.unsafe()`.

This is safe by construction, not by validation:

- Table names come from `$config/supported_locales`' `locales` array, never from user input
- `locale_table()` returns the **base table** for any locale that is not in that array, so a spoofed `X-Locale` header or `locale` cookie can never name a table that does not exist
- Every identifier interpolated into SQL passes a `/^[a-zA-Z_][a-zA-Z0-9_]*$/` guard that throws rather than escaping
- All values remain `?` bound parameters

- Use JS Map()ed generator code partials for switching between SQLITE and MYSQL, will be easier to extend to other SQL servers.

### `config/db_structure.ts` constants

The file defines DB conventions used by generators:

| Constant              | Default                                                                | Purpose                                                            |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `IGNORE_TABLES`       | `modules, sessions, email, images, files, users, translations`         | Tables skipped during bulk generation                              |
| `MAINTENANCE_FIELDS`  | `created_at, updated_at`                                               | Fields managed by DB, excluded from form save                      |
| `IGNORE_INDEX_FIELDS` | `display, option_display, option_text, search_text, hashed_password, previous_hashed_password` | Fields excluded from index/list column display |
| `IGNORE_ORDER_FIELDS` | `option_display, search_text, hashed_password, previous_hashed_password` | Fields excluded from sort dropdown                               |
| `BOOLEAN_PREFIXES`    | `is_, has_, can_`                                                      | Prefixes for boolean fields (shown as yes/no selects)              |
| `DATE_SUFFIXES`       | `_on, _by`                                                             | Date field suffixes                                                |
| `DATETIME_SUFFIXES`   | `_at`                                                                  | Datetime field suffixes                                            |
| `CURRENCY_FIELD`      | `decimal(18,2)`                                                        | Column type treated as currency, renders with `display_currency()` |
| `PERCENT_FIELD`       | `decimal(12,4)`                                                        | Column type treated as percentage                                  |

---

## Generators

All generation goes through `reeman` - `bun reeman` for the interactive menu, or `bun reeman <subcommand> [args]`
for non-interactive/scripted use. There are no standalone `generator/*.ts` CLI entry points anymore; the
underlying logic lives in library modules (`generator/schema.ts`, `generator/crud/main.ts`,
`generator/add_locale.ts`, etc.) that both the interactive flows and the `reeman` subcommand dispatcher
(`generator/reeman/cli.ts`) call directly. The CLI-only `install` command is the exception: it deliberately
runs the unpacked marketplace `install.ps1` or `install.sh` as a subprocess.

| Subcommand                 | Description                                                                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema <table\|all>`       | `[--prefix <dir>] [--parent <table>]` - introspects DB, writes `apps/main/<table>/schema/`. `--parent` detects FK and nests child under `apps/main/<parent>/<child>/`.                                                          |
| `crud <table_name\|all>`    | `[--force] [--prefix <dir>] [--parent <table>]` - full pipeline: schema + CRUD generation for one table, or every table when the target is `all`/`all-tables`.                                                            |
| `bulk <table...>`           | Full pipeline for a specific set of tables. See [README.md](../README.md#reeman-subcommand-reference) for usage.                                                                                                          |
| `refresh-crud <table>`      | Regenerate CRUD for a route that already has a schema folder.                                                                                                                                                              |
| `install <archive.tar.gz>`  | CLI-only. Warns to back up the repository and database, unpacks one folder under `marketplace/`, runs the current platform installer, then asks whether to keep the unpacked folder.                                  |
| *(bare)* `bun reeman`       | Interactive terminal UI for resource generation, DB ops, locale management, and bulk CRUD generation.                                                                                                                     |
| `add-locale <locale_code>`  | `[--translate]` - adds a BCP 47 locale to the project.                                                                                                                                                                     |
| `sync-translations [ns...]` | `[--translate]` - syncs translation structure across configured locales, optionally filling missing translations via AI.                                                                                                 |
| **User**                    | `bun generator/user.ts` - creates a new user with hashed password (not part of reeman).                                                                                                                                    |
| **Validation**              | `generator/validation_generator.ts` is a library module (Zod schema generation), called internally by the CRUD generator - not a CLI command.                                                                            |
| **Simple route**            | `generator/simple-route/` - a skeleton for simple non-CRUD route generation.                                                                                                                                              |

See [README.md](../README.md#generators) for the common flags (`--force`, `--translate`, `--prefix`, `--parent`) and auto-formatting details, or run `bun reeman --help` for the full subcommand reference.

### reeman menu options

| Menu option          | Description                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Simple Table Page    | Create a simple route with DB query from template (select from modules table)                                                                                                                                |
| Simple Page          | Create a simple page that reads from a local data.json file (no DB needed)                                                                                                                                   |
| Single table         | Full pipeline: schema introspection + CRUD generation for one table (use Nested children for parent/child CRUD)                                                                                              |
| Schema only          | Introspect DB and write schema files only                                                                                                                                                                    |
| Bulk CRUD            | Select multiple tables without CRUD + a prefix, batch-generate full pipeline for all                                                                                                                         |
| All tables           | Full pipeline for every table in the database                                                                                                                                                                |
| Remove route         | Delete a registered route (folder, imports, nav) - skips system routes                                                                                                                                       |
| Remove module/prefix | Delete an entire prefixed route folder and all its sub-routes                                                                                                                                                |
| Set database type    | Switch between MySQL and SQLite, update .env DEV_CONNECTION_STRING                                                                                                                                               |
| Run SQL file         | Select and execute a .sql file (seed, init, etc.) against the database                                                                                                                                       |
| Set session driver   | Switch session store between Redis and DB-auto (MySQL/SQLite from DEV_CONNECTION_STRING)                                                                                                                         |
| Quick Start / Reset  | Orchestrated setup: DB type → SQL file → session driver → confirmed admin user, with prompt defaults read from `.env`                                                                                       |
| Refresh CRUD         | Regenerate CRUD for an existing route (overwrites files, keeps schema). Detects nested children and passes `--parent` when refreshing them. After refreshing a parent, offers to re-apply child integration. |
| Add locale           | Add a new BCP 47 locale to the system (database rows, config, etc.)                                                                                                                                          |

> **Post-generation behavior**: When using the reeman with "Run AI translation sync after generation" enabled, `notify_server_reload()` is called automatically after `sync_all_namespaces()` completes. This ensures the dev server reloads with all translated nav labels and CRUD keys committed to the database.

#### Bulk CRUD flow

1. Scans all DB tables, excludes those already having a `apps/main/*/schema/table.ts` folder
2. Shows remaining tables in an **interactive multi-select** (arrow keys, space to toggle, Ctrl+A for select all/deselect all, enter to confirm)
3. Asks for a module prefix (0 = no prefix, placed directly in `/routes`)
4. Runs the full pipeline for each selected table, nested under `--prefix <module>`

> **Automation / CI equivalent:** The same operation is available non-interactively via the CLI:
> `bun reeman bulk <table...> --prefix <module>`
> This runs the full pipeline (schema + CRUD, always forced) for the given tables without any prompts.
>
> To set pagination strategy for all generated tables, add `--pagination cursor` or `--pagination offset` (default).

#### Interactive single-select (`select_from_list`)

All single-choice lists (table selection, route selection, prefix selection) now use an interactive widget instead of typing a number:

- Arrow keys (`↑↓`) to navigate, **Enter** to confirm
- **Ctrl+C** aborts (exits the reeman)
- Defined in `generator/reeman/ui.ts` (`select_from_list()`), uses the same raw-mode pattern as `multi_select`

#### Interactive multi-select (`multi_select`)

A custom terminal widget in `generator/reeman/ui.ts` (`multi_select()`) that:

- Uses raw mode on stdin for real-time key handling
- Renders a checkbox list with arrow-key navigation
- **Space** toggles the current item
- **Ctrl+A** toggles select all / deselect all
- **Enter** confirms and returns selected values
- **Ctrl+C** aborts (exits the reeman)
- Falls back to all columns if nothing is selected (in field selection contexts)

### Nested CRUD (Master-Detail)

Nested CRUD creates a parent-child relationship where child records are scoped to a parent and managed via nested URLs. Generate with:

```sh
# Full pipeline for the parent (standalone)
bun reeman crud equipment

# Full pipeline for the child (nested under parent)
bun reeman crud equipment_items --parent equipment

# Specify pagination strategy for schema generation
bun reeman crud users --pagination cursor
```

The child is placed at `apps/main/equipment/equipment_items/` (directly under the parent, no `/children/` subfolder). The generator:

- Creates **scoped SQL** (all queries accept `parent_id`, filter by FK)
- Generates **nested routes** (e.g. `/equipment/:code/equipment_items/:id/edit`)
- Registers routes via `// GEN:ROUTES:CHILD:START` markers in `routes.ts`
- **Modifies parent files**: adds child query to `sql.ts`, loads `child_records` in the edit handler, appends inline child list to `form.ree`
- **Skips** `form.ree`, `index.ree`, dead handler exports, and unused imports for the child (lean footprint)

When a parent route is refreshed via the reeman's "Refresh CRUD" option, child routes are auto-detected under the parent directory. The user is offered to re-apply child integration after the parent refresh.

The child grid also drops the parent's own denormalized display column. A view column named `<singular(parent_table)>_display`, such as `team_display`, is excluded from `generate_child_section_html`'s grid/dialog fields. It is redundant there because the child grid is already scoped to one parent record.

### Currency field rendering

Fields with column type `DECIMAL(18,2)` (configured as `CURRENCY_FIELD` in `config/db_structure.ts`) are automatically rendered with `{~ display_currency(value)}` in index pages and nested child lists. The raw column type is preserved in `attributes.column_type` during schema generation. `display_currency()` is a built-in template helper; see `REE_TEMPLATES.md` for the full list of available helpers.

### Placeholder naming convention

Generator templates in `generator/templates/` and their `.replaceAll()` calls in `generator/crud/` use `__category.property__` as the placeholder format:

- Double-underscore prefix and suffix: `__` … `__`
- Dot-separated hierarchy: `category` (the domain, e.g. `table`, `field`, `sql`, `child`, `parent`, `form`, `grid`, `ui`, `translation`) and `property` (the specific value)

Examples of the convention:

| Category        | Placeholder                                                                                                                                     | Purpose                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `__field`       | `__field.name__`, `__field.type__`, `__field.label__`, `__field.first__`                                                                        | Field-level attributes    |
| `__table`       | `__table.exact__`, `__table.singular__`, `__table.headers__`                                                                                    | Table-level metadata      |
| `__sql`         | `__sql.id_type__`, `__sql.tag_functions__`, `__sql.route_param_functions__`, `__sql.create_record_arg__`, `__sql.fk_select_functions__`         | SQL/injected code blocks  |
| `__child`       | `__child.headers__`, `__child.cells__`, `__child.grid_cols__`, `__child.records__`, `__child.ui__`, `__child.parent_label__`, `__child.table__` | Child section variables   |
| `__parent`      | `__parent.table__`, `__parent.fk_column__`, `__parent.route_param__`, `__parent.path__`, `__parent.fk_init__`                                   | Parent reference values   |
| `__form`        | `__form.input_fields__`                                                                                                                         | Form template injection   |
| `__grid`        | `__grid.num_columns_auto__`                                                                                                                     | Grid layout values        |
| `__ui`          | `__ui.empty_text__`                                                                                                                             | UI text labels            |
| `__translation` | `__translation.plural_label__`, `__translation.singular_label__`, `__translation.singular_label_cap__`                                          | Translation key templates |

Rules:

1. Always use `\`**`and`**` as delimiters.
2. Use dots (`.`) to separate the category from the property, never underscores.
3. Tablenames/fieldnames that are substituted verbatim (not placeholders) use double-underscore too but are themselves values, not placeholders - e.g. `__field.name__` gets replaced by the actual column name at generation time.
4. Compound words within the property segment still use underscores (e.g. `__child.singular_label__` has property `singular_label`). The dot separates _category from property_, not every word boundary.
5. Every template placeholder MUST have a corresponding `.replaceAll()` call in the generating `.ts` file, and both must use the identical string.

### Pagination strategies

Generated CRUD index views support two pagination strategies, selectable per-route via the `pagination_strategy` export in `schema/table.ts`.

Set to `"cursor"` for keyset-based pagination (stable on real-time data) or `"offset"` (default) for LIMIT/OFFSET pagination (requires `COUNT(*)` on every request).

```ts
export const pagination_strategy: "cursor" | "offset" = "offset";
```

#### Cursor (keyset pagination)

Uses the last-seen record's `id` and sort-field value as a cursor. No offset arithmetic, stable for real-time data.

**URL params:** `after`, `before`, `last`, `limit`, `order_by`, `query`, `scope`

| Action | URL              | SQL strategy                                                                             | JS rev? |
| ------ | ---------------- | ---------------------------------------------------------------------------------------- | :-----: |
| First  | (no cursor)      | `ORDER BY sort ASC, id ASC LIMIT limit`                                                  |   No    |
| Next   | `?after=id,val`  | `WHERE (sort > val OR (sort = val AND id > id)) ORDER BY sort ASC, id ASC LIMIT limit`   |   No    |
| Prev   | `?before=id,val` | `WHERE (sort < val OR (sort = val AND id < id)) ORDER BY sort DESC, id DESC LIMIT limit` |   Yes   |
| Last   | `?last`          | `ORDER BY sort DESC, id DESC LIMIT limit`                                                |   Yes   |

**Center display:** `"{records.length} / {total}"` (e.g. "20 / 100")

#### Offset (LIMIT/OFFSET) - opt-in

Classic positional pagination using `LIMIT ? OFFSET ?`. Supports numbered page arithmetic. Always used for nested children.

**URL params:** `offset`, `limit`, `order_by`, `query`, `scope`

**Center display:** `"{offset+1}-{offset+limit} / {total}"` (e.g. "21-40 / 100")

#### Template files

| Strategy | SQL template                        | Header template          | Index GET template          | Query strategy                |
| -------- | ----------------------------------- | ------------------------ | --------------------------- | ----------------------------- |
| Cursor   | `generator/templates/sql.ts`        | `index/header.ts`        | `index/index_get.ts`        | `index/query_table.ts`        |
| Offset   | `generator/templates/sql_offset.ts` | `index/header_offset.ts` | `index/index_get_offset.ts` | `index/query_table_offset.ts` |

Nested children always use offset: `nested_sql.ts` and `index/nested_header.ts`.

### Tags translation

Tags fields (columns ending in `_tags`) render checkboxes whose options are read from the configured tags lookup table. `generator/crud/sql_ts.ts` emits a `get_<field>_options()` function per tags field that runs `SELECT code AS tag_key, name AS tag_value FROM <tags_table> ORDER BY name ASC`. The tag code (e.g. `admin`) is the stored value; the `name` column supplies the displayed label.

Tag labels therefore live in the lookup table, not in the co-located `{locale}.json` files - edit the row's `name` to change a label. Because the lookup is by code rather than by a template expression, the prune tool cannot see these labels statically (see the i18n limitations in [CONTEXT.md](CONTEXT.md#translations-i18n)).

### Image upload fields

Columns ending in `_image` (`IMAGE_SUFFIXES` in `config/db_structure.ts`) are auto-detected as `field.type === "image"` in `resolve_domain_type()`/`generate_fields_object()` (`generator/schema/field_generator.ts`), same mechanism as the `_tags` suffix above. This drives three things:

- **Form field**: `generate_input_field` (`generator/crud/form_ree.ts`) dispatches to `generator/templates/fields/image.ree`, which renders a `<image-upload>` ReeTag (see [REE_TEMPLATES.md](REE_TEMPLATES.md#image-upload-component)) instead of a plain text input.
- **Grid cell**: `render_field_cell` (`generator/crud/render_field_cell.ts`) emits `{~ image_thumbnail(record.field) }` - a 100x100 thumbnail helper (`lib/template_helpers.ts`) - instead of the raw path string.
- **Domain compliance**: the column is assigned `domain: "image"` in the generated `schema/table.ts`, checked against the canonical `VARCHAR(255)` SQL type from `config/domain_types/{mysql,sqlite}.ts` by `check_domain_compliance`.

`generate_input_field` does not know a route's `module` at generation time, so the generated `<image-upload>` tag never sets the `module` attribute automatically - add it by hand in `form.ree` when the upload should require a specific module.

### File upload fields

Columns ending in `_file` (`FILE_SUFFIXES` in `config/db_structure.ts`) are auto-detected as `field.type === "file"` in `resolve_domain_type()`/`generate_fields_object()` (`generator/schema/field_generator.ts`), same mechanism as `_image`/`_tags` above. This drives three things:

- **Form field**: `generate_input_field` (`generator/crud/form_ree.ts`) dispatches to `generator/templates/fields/file.ree`, which renders a `<file-upload>` ReeTag instead of a plain text input.
- **Grid cell**: `render_field_cell` (`generator/crud/render_field_cell.ts`) emits `{~ file_link(record.field) }` - a filename/download-link helper (`lib/template_helpers.ts`) that renders an em-dash when empty - instead of the raw path string. A companion `file_icon_name(filename)` helper resolves a `<ree-icon>` name (PDF, Word, Excel, CSV, PowerPoint, Zip, plain text) by extension, falling back to a generic "file" icon.
- **Domain compliance**: the column is assigned `domain: "file"` in the generated `schema/table.ts`, checked against the canonical `VARCHAR(255)` SQL type from `config/domain_types/{mysql,sqlite}.ts` by `check_domain_compliance` - same canonical type as image fields.

### Markdown fields

A column is treated as `field.type === "markdown"` when either:

- **SQLite**: the raw column type string is exactly `MARKDOWN` (e.g. `bio MARKDOWN DEFAULT ''`) - matched directly in `generator/schema/sqlite/sqlite_type_mapper.ts`'s `to_html_input()`, since SQLite has no real column comments.
- **MySQL**: the column is `TEXT` (or similar) with `COMMENT 'MARKDOWN'` - resolved via the plain-word comment override described below.

This drives:

- **Form field**: `generate_input_field` (`generator/crud/form_ree.ts`) dispatches to `generator/templates/fields/markdown.ree`, rendering a `<markdown-editor>` custom element (`static/web-components/markdown-editor.js`, styled by `css/markdown-editor.css`).
- **Grid cell**: `render_field_cell` (`generator/crud/render_field_cell.ts`) emits `{~ md(record.field) }` wrapped in a `line-clamp-5` container - the `md()` helper (`lib/template_helpers.ts`) renders the stored markdown source to HTML via `Bun.markdown.html()`.

Use `md()` for rendering a stored markdown-type field's value; this is distinct from the `{@ path }` template tag, which renders a *translation* value as markdown (see [REE_TEMPLATES.md](REE_TEMPLATES.md)).

### Field hints

Every generated `field-wrapper` (all field types under `generator/templates/fields/`, plus the base `generator/templates/form.ree`) is a two-column responsive layout: the `<form>` itself gets `lg:max-w-[100ch] lg:grid-cols-2 lg:gap-x-6`, and each `field-wrapper` uses `lg:col-span-2 lg:grid-cols-subgrid` to split into a left column (label + input + validation error, wrapped in its own `<div class="grid">`) and a right column - a `<p class="text-xs text-neutral-500 ...">` slot for hint text, vertically centered next to the field.

The generator leaves that slot as an inert HTML comment, `<!-- hints.__field.name__ -->`, so a fresh generation renders no hint by default. To activate it for a field, replace the comment with `{_ hints.<field_name>}` and add the corresponding `hints.<field_name>` key to the route's translation namespace. `apps/reeman/global_scopes/form.ree` is the reference example - every field there has a populated hint. Because this is inside the `<!-- GEN:FIELDS:START/END -->` managed section, hand-added hints are preserved by `bun reeman refresh-crud <table> --mode fields` as long as the field-wrapper's structure is otherwise unchanged (see [CRUD refresh (field-only)](CONTEXT.md#crud-refresh-field-only)).

### Column comment-driven field type

The generator reads DB column comments at introspection time to determine field types. Two formats are supported:

- **Plain word**: setting the comment to a type name (e.g. `autocomplete`, `textarea`, `markdown`) sets the field type directly.
- **JSON**: a JSON object like `{type: "autocomplete", rows: 6}` provides fine-grained attribute overrides.

JSON comments take precedence over plain-word comments when both are present.

### Fulltext search

When a table has a `search_text` column, the CRUD generator produces `MATCH(search_text) AGAINST(? IN BOOLEAN MODE)` queries instead of `LIKE '%term%'`. This applies to both the WHERE clause and the COUNT query on search.

Requires a MySQL FULLTEXT index - add manually:

```sql
CREATE FULLTEXT INDEX idx_search_text ON table_name(search_text);
```
