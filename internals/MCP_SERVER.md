# MCP Server

> Code is the source of truth. The tool inventory below can drift - the authoritative list
> is what `scripts/mcp/index.ts` actually registers. Verify counts there before quoting them.

The project includes a **Model Context Protocol (MCP) server** under `scripts/mcp/` that
exposes project capabilities as tools for AI assistants.

- **Entry point:** `scripts/mcp/start.ts` enables protocol-safe stdio before loading `index.ts` (registration), with `db.ts`, `project.ts`, and `operations.ts` providing tool groups.
- **Start:** `bun run mcp`. Config in `mcp.json` at project root.
- **Protocol:** JSON-RPC 2.0 over stdio. Compatible with Claude Desktop, VS Code, Cursor, and any MCP client.
- **Transport contract:** stdout contains JSON-RPC frames only. Startup and diagnostic output goes to stderr. Closing client stdin shuts down database connections and exits cleanly.
- **Exposure:** Local stdio only. Do not expose this process, its stdio, or an MCP bridge on a network port.
- **Dependencies:** Bun native APIs only (no npm deps).

## Template tools

| Tool                   | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `render_template`      | Execute and render a .ree template string; requires explicit local opt-in |
| `validate_template`    | Check .ree template syntax without rendering                |
| `compile_template`     | Show generated JavaScript for a .ree template               |
| `analyze_template`     | Extract structure (layout, includes, components, variables) |
| `list_components`      | List all .ree component files                               |
| `get_component_source` | Read a component's .ree source                              |
| `read_template_file`   | Read a .ree file only under the main app, `platform/`, or `components/`      |
| `render_template_file` | Execute and render an approved .ree file; requires explicit local opt-in |

Template rendering executes local template code. It is disabled until the local
operator sets `MCP_ENABLE_TEMPLATE_RENDER=true` for the MCP process.

## Mutation capability

The default tool list is inspection-only. Generators, translation writes,
translation reloads, CRUD regeneration, and the arbitrary-SQL dev runner
(`run_sql_dev`) are not exposed until the local operator starts MCP with
`MCP_ENABLE_MUTATIONS=true`.

`mcp.json` is the checked-in registration and enables mutations (`MCP_ENABLE_MUTATIONS=true`). In it, `cwd: "."` is relative to the
directory from which the client loads the configuration, so keep the config at
the project root or replace `cwd` with the absolute project path in a client-level
registration.

Verify launch, initialization, tool discovery, stdout framing, capability
filtering, and clean shutdown with:

```sh
bun run mcp:check
bun run mcp:check:mutations
bun run mcp:check:exit
```

Database inspection accepts one `SELECT` statement only. SQLite inspection uses
a separate read-only connection. MySQL requires `MCP_READONLY_CONNECTION_STRING`
for a separate database user with only `SELECT` privileges and no file privileges.

## Project tools

| Tool                  | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `get_project_context` | Read `llms.txt` for full project overview                  |
| `list_routes`         | List all registered routes with metadata                   |
| `list_templates`      | List all .ree templates with type (route/component/layout) |
| `list_translations`   | List available locales and translation namespaces          |
| `get_translations`    | Get translations for a locale and optional namespace       |
| `list_config`         | Show project configuration (DB, locales, conventions)      |
| `list_generators`     | List available code generators                             |
| `search_code`         | Search authored code with ripgrep; excludes secrets, VCS metadata, dependencies, and archives |
| `get_route_detail`    | Inspect route type, storage, relevant files, and a safe project-local BREAD data path |
| `run_generator`       | Invoke a code generator and return captured diagnostics plus structured BREAD file outcomes; only with mutation capability |
| `reload_translations` | Trigger translation reload; only with mutation capability   |

## Database tools

| Tool                  | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `list_db_tables`      | List all database tables and views. A `locale_clone_of` field marks a per-locale clone table - never write one directly, write its base table instead |
| `get_table_structure` | Get full schema for a table (columns, types, FKs)    |
| `get_db_config`       | Show DB connection details and naming conventions    |
| `run_sql`             | Run one read-only `SELECT` query, with a result cap   |
| `run_sql_dev`         | Run SQL against the app's dev DB via `unsafe()`; returns `{ meta, records }`; read-only by default (single SELECT + result cap), pass `allow_changes: true` for writes/DDL; only with mutation capability |

## Operations tools

| Tool                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `get_queue_status`  | Show background job queue status (SQL or Redis store)  |
| `run_tests`         | Run bun test with optional filter                     |
| `sync_translations` | Sync translation data across namespaces; `translate` optionally invokes the configured AI provider |
| `insert_translations` | Scan .ree templates for missing file keys and optionally add them to locale files |
| `add_translations`  | Add supplied values to locale files, report incomplete groups and empty values, and optionally reject an incomplete batch atomically |
| `prune_translations` | Find file-backed keys no longer referenced in templates and optionally delete them |
| `refresh_crud`      | Regenerate an existing CRUD route; only with mutation capability |
| `check_domain_compliance` | Report columns outside the canonical domain types |

All translation-writing and synchronization operations require
`MCP_ENABLE_MUTATIONS=true`. `insert_translations` and `prune_translations`
default to inspection and mutate locale files only when `apply_changes` is true.
Call `reload_translations` after `add_translations`; `sync_translations` reloads
the server maps as part of its operation.


## CODEX has some config.toml which needs to be set up.
