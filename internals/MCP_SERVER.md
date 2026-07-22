# MCP Server

> Code is the source of truth. The tool inventory below can drift - the authoritative list
> is what `scripts/mcp/index.ts` actually registers. Verify counts there before quoting them.

The project includes a **Model Context Protocol (MCP) server** under `scripts/mcp/` that
exposes project capabilities as tools for AI assistants.

- **Entry point:** `scripts/mcp/index.ts` (registration), with `db.ts`, `project.ts`, `operations.ts` providing tool groups.
- **Start:** `bun run mcp` (script: `bun run scripts/mcp/index.ts`). Config in `mcp.json` at project root.
- **Protocol:** JSON-RPC 2.0 over stdio. Compatible with Claude Desktop, VS Code, Cursor, and any MCP client.
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
| `read_template_file`   | Read a .ree file only under `routes/` or `components/`      |
| `render_template_file` | Execute and render an approved .ree file; requires explicit local opt-in |

Template rendering executes local template code. It is disabled until the local
operator sets `MCP_ENABLE_TEMPLATE_RENDER=true` for the MCP process.

## Mutation capability

The default tool list is inspection-only. Generators, translation writes,
translation reloads, CRUD regeneration, and DDL cache rescans are not exposed
until the local operator starts MCP with `MCP_ENABLE_MUTATIONS=true`.

Database inspection accepts one `SELECT` statement only. SQLite inspection uses
a separate read-only connection. MySQL requires `MCP_READONLY_CONNECTION_STRING`
for a separate database user with only `SELECT` privileges and no file privileges.

## Project tools

| Tool                  | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `get_project_context` | Read `llms.txt` for full project overview                  |
| `list_routes`         | List all registered routes with metadata                   |
| `list_templates`      | List all .ree templates with type (route/component/layout) |
| `list_translations`   | List available languages and translation namespaces        |
| `get_translations`    | Get translations for a language and optional namespace     |
| `list_config`         | Show project configuration (DB, languages, conventions)    |
| `list_generators`     | List available code generators                             |
| `search_code`         | Search authored code with ripgrep; excludes secrets, VCS metadata, dependencies, and archives |
| `get_route_detail`    | Inspect files in a route directory                         |
| `run_generator`       | Invoke a code generator; only with mutation capability      |
| `reload_translations` | Trigger translation reload; only with mutation capability   |

## Database tools

| Tool                  | Description                                          |
| --------------------- | ---------------------------------------------------- |
| `list_db_tables`      | List all database tables and views                   |
| `get_table_structure` | Get full schema for a table (columns, types, FKs)    |
| `get_db_config`       | Show DB connection details and naming conventions    |
| `run_sql`             | Run one read-only `SELECT` query, with a result cap   |

## Operations tools

| Tool                | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `get_queue_status`  | Show background job queue status (requires REDIS_URL) |
| `run_tests`         | Run bun test with optional filter                     |
