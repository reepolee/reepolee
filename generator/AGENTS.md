# generator/ - Code Generators

> **CODE IS THE SOURCE OF TRUTH.** This is a map. Read the actual generator and its
> co-located `*.test.ts` before changing anything.
>
> **Golden rule: fix the generator, never the generated output.** This is a codegen app.
> Generated files under `routes/<table>/` are disposable - if output is wrong, fix the
> template or generator here, then regenerate.

## What lives here

Everything runs through `reeman`, the Reepolee Resource Manager - interactively (`bun reeman`), or as a scripted subcommand (`bun reeman <subcommand>
[args]`, see `bun reeman --help`). Most paired actions call the same library functions directly.
`install` is CLI-only and deliberately runs the unpacked platform installer as a subprocess.
`generator/reeman/cli.ts` is the subcommand dispatcher; `generator/reeman/index.ts` is the interactive menu.

| File                              | Role                                                              |
| --------------------------------- | ---------------------------------------------------------------- |
| `reeman.ts`                       | The actual entry point (`bun reeman` in package.json) - delegates to `reeman/cli.ts` for subcommands, `reeman/index.ts` for the interactive menu |
| `schema.ts`                       | Library: introspect DB -> `routes/<table>/schema/` (called by `bun reeman schema`/`crud`) |
| `crud/main.ts`                    | Library: generate CRUD routes + `.ree` templates from an existing schema (called by `bun reeman crud`/`refresh-crud`) |
| `add_locale.ts` / `remove_locale.ts` | Add/remove a configured BCP 47 locale (called by `bun reeman add-locale`/`remove-locale`) |
| `validation_generator.ts`         | Generate Zod validation schemas (called internally by the CRUD generator) |
| `user.ts`                         | Create a user with a hashed password - the one script still run directly (`bun generator/user.ts`), not part of reeman |
| `ai-provider.ts`, `openrouter.ts`, `translator.ts`, `translate_namespace.ts` | AI translation plumbing |
| `ddl_cache.ts`                    | DDL cache for introspection (`ddl_cache_types.ts`)               |
| `reeman/install_archive.ts`       | Validate and unpack one `.tar.gz` marketplace folder, then run its platform installer |

## Subfolders

| Folder              | Role                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `crud/`             | CRUD pipeline: `main.ts`, `file_writer.ts`, `index_ts.ts`, `form_ree.ts`, `index_ree.ts`, `sql_ts.ts`, `schema_reader.ts`, `route_registrar.ts`, `template_substitutor.ts`, `translation_sync.ts`, `child_section.ts` (nested), `refresh_fields.ts` |
| `schema/`           | Schema introspection: `introspector.ts`, `field_generator.ts`, `type_mapper.ts`, `file_writer.ts`, plus `mysql/` and `sqlite/` dialect introspectors |
| `reeman/`           | Everything reeman: `cli.ts` (non-interactive subcommand dispatcher), `index.ts` (interactive menu), `ui.ts` (prompts, session replay log), flows, callers, and utilities (`flows/`, `callers/`, `utils/`) |
| `templates/`        | **The actual codegen templates** (`.ree` and `.ts` with placeholders). NOT valid standalone TS - ignore for type-checking. |
| `simple-page/`, `simple-route/` | Scaffolds for non-CRUD pages/routes                            |

## Common flags

| Flag               | Meaning                                                        | Supported by                                    |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------ |
| `--force`          | Overwrite existing generated files without prompting           | `crud`, `bulk`                                   |
| `--translate`      | AI-translate generated keys into configured locales            | `crud`, `bulk`, `sync-translations`              |
| `--prefix <dir>`   | Nest generated routes under a subdirectory                     | `schema`, `crud`, `bulk`                         |
| `--parent <table>` | Mark as nested child of `<table>` (auto-detects FK, scopes)    | `schema`, `crud`, `refresh-crud`                 |
| `--pagination`     | `cursor` or `offset` (default: offset)                         | `schema`, `crud`, `bulk`, `refresh-crud`         |
| `--render-strategy`| `stream` or `load` (default: load)                              | `crud`, `bulk`                                   |
| `--template-tags`  | `flat` or `tags` (default: flat) - form field rendering mode, see below | `crud`, `bulk`, `refresh-crud`           |
| `--mode fields`    | Regenerate only field sections in `form.ree`/`index.ree`       | `refresh-crud`                                   |

`crud <table>` runs the full pipeline for one table; `crud all` (or `all-tables`) runs it for every table.

Run `bun reeman --help` for the complete subcommand list. The CRUD generator runs `reettier` on the generated route directory automatically.

### `--template-tags`: form field rendering mode

Controls how `generate_input_field()` (`crud/form_ree.ts`) renders each form field:

- `flat` (default) - loads a per-field-type snippet from `generator/templates/fields/*.ree`, which inlines raw `<input>`/`<select>`/`<label>` markup plus `<field-wrapper>`/`<validation-error>`. Use when a field's HTML needs per-field customization after generation.
- `tags` - loads from `generator/templates/fields_tags/*.ree` instead, each a single ReeTag component call (e.g. `<input-text name="..." label="..." value="...">`) that wraps its own `<field-wrapper>`/`<validation-error>` internally. Reusable components live in `components/input-*.ree` (see [routes/AGENTS.md](../routes/AGENTS.md) "Templates & components"). Use once a form's layout is stable and won't need per-field HTML edits - the generated `form.ree` is shorter and layout tweaks made in the shared component apply to every table using it.

Sticky per-entity: persisted as a `template_tags` const in the table's `schema/table.ts`, written at first scaffold (default `"flat"`) and re-patched in place (`load_table_schema()`, `crud/schema_reader.ts`) whenever `--template-tags` is explicitly passed on a later `crud`/`bulk`/`refresh-crud` run - mirrors `pagination_strategy`'s persistence model. Omitting the flag on a given run reads and keeps the existing `table.ts` value; it is never silently reset.

Nested CRUD's hidden parent-FK input is always raw HTML in both modes (no ReeTag needed for a hidden field). Child tables render with their own `template_tags` value independently of the parent's.

## Deep dives

- [internals/GENERATOR_INTERNALS.md](../internals/GENERATOR_INTERNALS.md) - reeman menu, pagination SQL, nesting, placeholder naming, `db.unsafe()` exceptions, column-comment field types, fulltext search.
- [internals/ARCHITECTURE.md](../internals/ARCHITECTURE.md) - schema detection, FK strategy, generated-code lifecycle, protected markers.
- [internals/DEVELOPMENT_GUIDE.md](../internals/DEVELOPMENT_GUIDE.md) - step-by-step generation and schema-change workflows.
- [generator/README.md](README.md) - quick command reference.
- [internals/REE_TEMPLATES.md](../internals/REE_TEMPLATES.md) - the `.ree` template language the templates are written in.
