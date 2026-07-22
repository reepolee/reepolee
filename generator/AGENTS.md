# generator/ - Code Generators

> **CODE IS THE SOURCE OF TRUTH.** This is a map. Read the actual generator and its
> co-located `*.test.ts` before changing anything.
>
> **Golden rule: fix the generator, never the generated output.** This is a codegen app.
> Generated files under `routes/<table>/` are disposable - if output is wrong, fix the
> template or generator here, then regenerate.

## What lives here

All generators run via `bun generator/<name>.ts`. Entry points:

| File                              | Role                                                              |
| --------------------------------- | ---------------------------------------------------------------- |
| `resource.ts`                     | Full pipeline orchestrator: schema + CRUD (`<table>`, `all`, `bulk`) |
| `schema.ts`                       | Introspect DB -> `routes/<table>/schema/`                        |
| `crud.ts`                         | Generate CRUD routes + `.ree` templates from an existing schema  |
| `reeman.ts`                          | Interactive reeman runner (the recommended entry for humans)        |
| `sync_translations.ts`            | Sync translation keys across languages                           |
| `add_language.ts` / `remove_language.ts` | Add/remove a configured language                          |
| `validation_generator.ts`         | Generate Zod validation schemas                                  |
| `user.ts`                         | Create a user with a hashed password                             |
| `ai-provider.ts`, `openrouter.ts`, `translator.ts`, `translate_namespace.ts` | AI translation plumbing |
| `ddl_cache.ts`                    | DDL cache for introspection (`ddl_cache_types.ts`)               |

## Subfolders

| Folder              | Role                                                                       |
| ------------------- | -------------------------------------------------------------------------- |
| `crud/`             | CRUD pipeline: `main.ts`, `file_writer.ts`, `index_ts.ts`, `form_ree.ts`, `index_ree.ts`, `sql_ts.ts`, `schema_reader.ts`, `route_registrar.ts`, `template_substitutor.ts`, `translation_sync.ts`, `child_section.ts` (nested), `refresh_fields.ts` |
| `schema/`           | Schema introspection: `introspector.ts`, `field_generator.ts`, `type_mapper.ts`, `file_writer.ts`, plus `mysql/` and `sqlite/` dialect introspectors |
| `resource/`         | Resource orchestrator: `main.ts`, `runner.ts`, `db.ts`, `helpers.ts`       |
| `reeman/`              | reeman flows, callers, and utilities (`index.ts`, `flows/`, `callers/`, `utils/`) |
| `templates/`        | **The actual codegen templates** (`.ree` and `.ts` with placeholders). NOT valid standalone TS - ignore for type-checking. |
| `simple-page/`, `simple-route/` | Scaffolds for non-CRUD pages/routes                            |

## Common flags

| Flag               | Meaning                                                        | Supported by                          |
| ------------------ | -------------------------------------------------------------- | ------------------------------------- |
| `--force`          | Overwrite existing generated files without prompting           | `crud.ts`, `resource.ts`              |
| `--translate`      | AI-translate generated keys into configured languages          | `resource.ts`                         |
| `--prefix <dir>`   | Nest generated routes under a subdirectory                     | `schema.ts`, `crud.ts`, `resource.ts` |
| `--parent <table>` | Mark as nested child of `<table>` (auto-detects FK, scopes)    | `schema.ts`, `crud.ts`, `resource.ts` |
| `--pagination`     | `cursor` or `offset` (default: offset)                         | `resource.ts`, `schema.ts`            |
| `--refresh-fields` | Regenerate only field sections in `form.ree`/`index.ree`       | `crud.ts`                             |

The CRUD generator runs `reettier` on the generated route directory automatically.

## Deep dives

- [internals/GENERATOR_INTERNALS.md](../internals/GENERATOR_INTERNALS.md) - reeman menu, pagination SQL, nesting, placeholder naming, `db.unsafe()` exceptions, column-comment field types, fulltext search.
- [internals/ARCHITECTURE.md](../internals/ARCHITECTURE.md) - schema detection, FK strategy, generated-code lifecycle, protected markers.
- [internals/DEVELOPMENT_GUIDE.md](../internals/DEVELOPMENT_GUIDE.md) - step-by-step generation and schema-change workflows.
- [generator/README.md](README.md) - quick command reference.
- [internals/REE_TEMPLATES.md](../internals/REE_TEMPLATES.md) - the `.ree` template language the templates are written in.
