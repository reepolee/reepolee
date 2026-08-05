# reepolee - Agent Guide (Index)

First, read and respect ~/.agents/AGENTS.md

> This file is an **index**, not a manual. It points you at the docs and the code.
> Read it first, then **read the actual code** for the area you're touching.
> **Agent-created documents go in `.agents/`.** All plans, notes, logs, working docs—everything an agent writes goes there.

## ⚠️ PRIMARY RULE: CODE IS THE SOURCE OF TRUTH

**When any document (including this one) disagrees with the code, the code wins.**

Docs drift. Treat every `.md` file as a *map*, not gospel. Before you act on anything a
doc claims (a path, a function name, a flag, a default), **open the file and confirm it
in the source.** Workflow:

1. Read this index to find *where* the relevant code lives.
2. Read that code (and its co-located `*.test.ts`) to learn how it *actually* behaves.
3. Only then make a change.
4. If you find a doc that no longer matches the code, fix the doc (or flag it) - don't propagate the stale claim.

The one thing docs are authoritative for is **project policy you cannot derive from code**
(conventions, the DB-first translation rule, "fix generators not generated code"). Those
rules live below and in the linked guides - follow them.

## Path / Slash convention (authoritative)

| Concept              | Format                                           | Example                          |
| -------------------- | ------------------------------------------------ | -------------------------------- |
| `clean_prefix`       | No leading/trailing slashes                      | `"admin"`                        |
| `route_prefix`       | Leading `/` if non-empty, no trailing `/`        | `"/admin"` or `""`               |
| Route URL            | Leading `/`, no trailing `/` (except root `"/"`) | `"/admin/users"`                 |
| Nav/translation keys | Dot-separated, no slashes                        | `"admin.users"`                  |
| Filesystem paths     | Via `path.join()` with individual segments       | `join("routes","admin","users")` |

1. Normalize raw input via `normalize_prefix()` (`$lib/helpers`) -> `{ clean, route }`.
2. Never concatenate paths with `+` or template literals, except `route_prefix + "/name"`.
3. `mount_prefix(prefix, routes)` requires `prefix` and all `routes` keys to start with `/`.
4. Use `path.join()` for filesystem ops, never string concatenation.
5. Nav/translation namespace keys always use dots, never slashes.

## Translations: DB-first (authoritative policy)

The `translations` table is the source of truth `(locale, namespace, key_path, translation)`.

- **DO NOT** create or edit `*.json` files in `routes/` to change translations.
- **DO** edit via SQL `UPDATE/INSERT`, `bun reeman sync-translations`, via MCP or the `/system/translations` admin UI.
- `.reepolee/i18n/*.json` are a **read-only export for the VSCode extension** (autocomplete/lookup). They are not loaded at runtime and are not the source of truth - never edit them to change a translation; the DB is authoritative and these files are regenerated from it.

Full merge model, root fallback, and the prune tool: [internals/CONTEXT.md](internals/CONTEXT.md) and `lib/i18n.ts`.

## Commands

`package.json` `scripts` is the source of truth. Common ones:

| Purpose            | Command                                              |
| ------------------ | ---------------------------------------------------- |
| Dev (full)         | `bun dev`                                            |
| Worker only        | `bun run worker`                                     |
| Agent mode         | `bun run agent`                                      |
| Prod               | `bun start`                                          |
| Test / watch       | `bun test` / `bun test --watch`                      |
| Format             | `bun run format` (reettier)                          |
| reeman generator   | `bun run reeman`                                     |
| MCP server         | `bun run mcp`                                        |
| Clone test DB      | `bun run db:clone-test`                              |
| Sync translations  | `bun reeman sync-translations`                       |
| Prerequisites      | `bun run get:pre`                                    |

See [README.md](README.md) for setup, the full command list, and generator usage.

## Where to look (documentation map)

| Doc                                                      | Use it for                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------- |
| [README.md](README.md)                                  | Setup, prerequisites, CLI usage, generator overview                  |
| [internals/CONTEXT.md](internals/CONTEXT.md)                      | Glossary - project-specific terminology and concepts                  |
| [internals/ARCHITECTURE.md](internals/ARCHITECTURE.md)            | Schema detection, FK strategy, generated-code lifecycle, pagination  |
| [internals/DEVELOPMENT_GUIDE.md](internals/DEVELOPMENT_GUIDE.md)  | Step-by-step CRUD generation, customization, schema changes          |
| [internals/QUICK_REFERENCE.md](internals/QUICK_REFERENCE.md)      | Cheat sheet - commands, file structure, customization zones          |
| [internals/REE_TEMPLATES.md](internals/REE_TEMPLATES.md)          | `.ree` template engine + render API reference                        |
| [internals/GENERATOR_INTERNALS.md](internals/GENERATOR_INTERNALS.md) | Generator deep-dive - reeman, pagination, nesting, naming, `unsafe()` |
| [internals/AGENT_CRUD_WORKFLOW.md](internals/AGENT_CRUD_WORKFLOW.md) | Agent-safe CRUD editing - files to inspect, `unsafe()` rules       |
| [internals/TESTING.md](internals/TESTING.md)                      | Test runner, fixtures, mock patterns, isolation                      |
| [internals/MCP_SERVER.md](internals/MCP_SERVER.md)                | MCP server tools (`scripts/mcp/`)                                    |
| [internals/AGENT_MODE.md](internals/AGENT_MODE.md)                | `--agent` headless mode - auth, env vars, safety                     |
| [internals/RUNTIME.md](internals/RUNTIME.md)                      | Git hooks, dev-mode quirks, SQL pooling, Redis, rate limiting, global scopes |

## Discovering the reepolee MCP server

This repo ships an MCP server (`scripts/mcp/`) that may already be connected to your
session as **`reepolee`**. Its tools are prefixed `mcp__reepolee__*`. **Check for these
tools first and prefer them** over hand-rolled equivalents - they are project-aware and
safer:

- Adding a user? Use `run_generator` with `name="user"` (wraps `generator/user.ts`) - do
  not hand-write an `INSERT`. `run_sql` is read-only (SELECT/EXPLAIN/PRAGMA/SHOW only) and
  cannot write.
- Inspecting the DB? `list_db_tables`, `get_table_structure`, `run_sql`.
- Generating/CRUD/translations? `run_generator`, `refresh_crud`, `sync_translations`, `insert_translations`, `add_translations`.
- Templates, routes, code search? `render_template`, `list_routes`, `search_code`.

If the tools are not present, the server may just be unregistered in the current client -
start it with `bun run mcp` (see below). Full tool inventory: [internals/MCP_SERVER.md](internals/MCP_SERVER.md).

## Per-folder guides

Each major folder has its own `AGENTS.md` index pointing into its code:

| Folder                                | Guide                                       |
| ------------------------------------- | ------------------------------------------- |
| [generator/](generator/AGENTS.md)     | Code generators (schema, CRUD, reeman, etc.)   |
| [lib/](lib/AGENTS.md)                 | Runtime libraries (render, routing, i18n, middleware) |
| [routes/](routes/AGENTS.md)           | Route system, handlers, CRUD, middleware    |
| [queue/](queue/README.md)             | Redis-backed background job queue           |

## Project specifics

Bun project for server-side rendering with a custom `.ree` template engine. Use Bun
native APIs (e.g. `bun:sql` for MySQL/SQLite) over external deps. Reference:
<https://bun.com/docs/>, <https://bun.com/docs/guides>.

## Context & Pattern Principles (Anti-Anchoring Guardrails)

### 1. Source of Truth & State Hierarchy
- **Current Constraints Over Repository Examples:** Treat existing codebase implementation patterns as historical context, NOT absolute authority. If existing code uses deprecated APIs, anti-patterns, or legacy syntax, DO NOT replicate them simply because they exist in the repository.
- **Evaluation Order:** Always evaluate solutions against current runtime specifications, framework best practices, and explicit project guidelines BEFORE referencing surrounding code style.

### 2. Modern Standards & Deprecation Awareness
- **Identify and Isolate:** Before writing code, actively check if the surrounding file uses deprecated libraries, outdated language syntax, or anti-patterns (e.g., callbacks vs. async/await, outdated state management, deprecated SDK methods).
- **Refactor Scope:** Do not passively propagate bad patterns to new code. If a new function touches a file with outdated patterns:
  - Implement the new functionality using modern standards.
  - Do NOT rewrite unrelated code unless explicitly instructed (avoid scope creep).
  - Bridge the modern implementation to the existing caller cleanly.

### 3. Disregard Historical Context Traces
- **Ignore Git Churn & Historical Comments:** Ignore outdated TODOs, commented-out dead code, and historical workarounds unless directly relevant to the target bug.
- **Ignore Discarded Patterns:** If past commits or adjacent files demonstrate trial-and-error attempts, treat them as failed experiments—do not attempt to re-implement or adapt them.
- **Focus:** Strictly on the current code state (HEAD). Do not match outdated patterns unless specifically asked.

### 4. Code Generation Rules
- **Modern Defaults First:** Always default to modern idiomatic practices (e.g., strict typing, explicit immutability, modern error handling).
- **Explicit Warning:** If forced to use an outdated pattern due to tight coupling, flag it explicitly with a comment: `// COMPATIBILITY: [Reason]`.
