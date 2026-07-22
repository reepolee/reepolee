# Reepolee Framework

<img src="static/github-reepolee.svg" style="margin-bottom:1rem; width:200px">

An MIT-licensed, database-first framework for long-lived business applications on Bun.

**Zero runtime dependencies.** Only dev dependencies.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE.md)

---

## Installation

### Installing Bun

Reepolee has one hard prerequisite - Bun. Use the official installer:

**macOS / Linux / WSL**  

```bash
curl -fsSL https://bun.sh/install | bash       
```

**Windows**

```bash
powershell -c "irm bun.sh/install.ps1|iex"   
```

Verify the install:

```bash
bun --version
```

Upgrade to canary (already Rust-based) for the latest features:

```bash
bun upgrade --canary
```

If `bun: command not found`, the installer's `~/.bun/bin` directory isn't on your `$PATH` - open a new terminal or run `source ~/.bashrc` (or `~/.zshrc`) to pick up the change.

### Quick start

#### One-command setup (recommended)

Reepolee is in beta. APIs, generators, and project conventions may change before 1.0.

1. **Clone a project**

   ```bash
   git clone https://github.com/reepolee/reepolee.git my-reepolee-project
   cd my-reepolee-project
   ```

2. **Run the install script**

   ```bash
   bun reepolee:install
   ```

   This script installs:
   - Project dependencies via `bun install`
   - `@tailwindcss/cli` - the Tailwind v4 CLI
   - `concurrently` - runs the Tailwind watcher and dev server side-by-side
   - `reettier` - the Ree template formatter
   - `reesql` - the SQL formatter
   - `vendor/` folder - vendored packages
   - `libvips` - VIPS CLI for image processing

3. **Verify the setup**

   ```bash
   bun dev
   ```

   If you see `Listening on http://localhost:2338` and the page loads in a browser, your setup is complete.

#### Manual setup (clone)

If you cloned the repository instead of using the release archive:

```bash
cp .env.example .env          # edit CONNECTION_STRING
bun install
bun get:pre                   # fetch prerequisites
bun dev                       # tailwind watch + server with hot-reload
```

#### Prerequisites reference

The `bun get:pre` command fetches all globally installed tools and vendored files needed to run this project. Verify with:

```bash
bun -v
tailwindcss -h | grep v   # or findstr v on Windows
conc -v
reettier --version
```

If some are already installed, pick individual scripts:

| Purpose                  | Script            | What it does                                                                                                                                                                |
| ------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tailwind CSS CLI         | `bun get:tw`      | `bun add -g @tailwindcss/cli`                                                                                                                                               |
| Concurrently             | `bun get:conc`    | `bun add -g concurrently`                                                                                                                                                   |
| reettier                 | `bun get:reettier` | Downloads & installs the `reettier` binary from GitHub releases                                                                                                            |
| reesql                   | `bun get:reesql`  | Downloads & installs the `reesql` binary from GitHub releases                                                                                                              |
| Zod (vendored)           | `bun get:zod`     | Downloads `vendor/zod.min.js` from jsDelivr ESM                                                                                                                             |  
| highlight.js (vendored)  | `bun get:hljs`    | Downloads `vendor/highlight.min.js` from jsDelivr ESM                                                                                                                       |
| Temporal polyfill (vendored) | `bun get:temporal` | Downloads `vendor/temporal.min.js` from esm.sh                                                                                                                           |
| Alien DeepSignals (vendored) | `bun get:signals` | Downloads `static/alien-deepsignals.min.js` from esm.sh                                                                                                                    |
| DPU polyfill (vendored)  | `bun get:dpu`     | Downloads `static/dpu.min.js` (HTML `<template>` setters polyfill from GoogleChromeLabs) for DPU streaming support                                                          |
| libvips (installed)      | `bun get:vips`    | Downloads & installs libvips for image processing (crop, resize). Supports Windows (from GitHub releases), macOS (Homebrew), and Linux (apt/dnf/pacman). Auto-adds to PATH. |

We need vips from [libvips](https://github.com/libvips/libvips) for image manipulation. Yes, we know `Bun.Image()` exists, but we need the crop function.

---

## Editor setup

### VS Code

The [Ree Templates extension](https://marketplace.visualstudio.com/items?itemName=reepolee.ree-templates) adds syntax highlighting and formatting for `.ree` files. Install from the marketplace or via CLI:

```bash
code --install-extension reepolee.ree-templates
```

**Tailwind IntelliSense** - works inside `.ree` files if you tell it to. Add to VSCode settings:

```json
"tailwindCSS.includeLanguages": { "ree": "html" }
```

**TypeScript** - the language server picks up `.ts` files natively, no extra configuration needed.

### Other editors

Treat `.ree` as HTML. The HTML syntax highlighter handles most of Ree fine - the tag prefixes (`{=`, `{~`, `{_`, `{-`, `{#`, `{:`, `{/`, `{{`) are visually distinct enough that the HTML grammar ignores them cleanly.

---

## Optional tooling

| Tool | Command | Purpose |
| ---- | ------- | ------- |
| **oxlint** | `bun add -g oxlint` | JS/TS linting (not required, nothing depends on it) |
| **gh** (GitHub CLI) | Per-platform install | Create pull requests, manage issues, run deploy workflows from CLI |
| **jq** | Per-platform install | Filter NDJSON SQL logs |
| **certbot** | Per-platform install | TLS certificates on the production server (reverse proxy) |

Install whichever fits your workflow. None are needed to run Reepolee.

### libvips (image processing)

The image editor / avatar pipeline relies on the native libvips library. Reepolee ships a small installer (`bun get:vips`) that fetches a prebuilt libvips for your platform so you don't have to install it through a system package manager. The installer supports Windows (prebuilt from GitHub releases), macOS (Homebrew), and Linux (apt/dnf/pacman), and adds libvips to your PATH automatically.

If you don't use the image editor or avatar uploads, you can skip this - the rest of the app runs without libvips.

---

## Development

```bash
bun dev						# Full dev (tailwind watch + server with --hot reload)
bun run worker   				# Start background worker separately
```

## Testing

```bash
bun test					# Full suite (--parallel)
bun run db:clone-test				# Clone production DB → test DB (requires TEST_CONNECTION_STRING)
```

Set `TEST_CONNECTION_STRING` in `.env` to a database with "test" in the name. The safety guard refuses non-test databases.

Install pre-commit hooks to run, we supply `reettier`:

```bash
bun git:hooks
```

## Production

```bash
bun run css:build				# Build minified CSS
bun start						# bun server.ts --prod
```

To bump the version:

```bash
bun pm version patch				# Bump package.json version
bun run release					# Bump version, commit, and package the release archive via the sibling ../reelease project
```

You can also start PM2 for long term running

```bash
pm2 start operations/ecosystem.config.cjs
```

and then use `pm2 logs` or `pm2 monit` to check the runtime progress.

---

## Architecture

- **Runtime**: Bun only. No runtime dependencies.
- **Entry**: `server.ts` - `Bun.serve()` with route table from `routes.ts`.
- **Templates**: `.ree` files in `routes/`, custom engine at `lib/template_engine.ts`.
- **Routes**: Route handlers export named functions, registered in `routes.ts`.
- **Database**: Bun's `SQL` API → MySQL or SQLite via `config/db.ts`.
- **CSS**: Tailwind v4 via standalone CLI.
- **Auth**: Cookie-based sessions, invite-only registration, profile management.
- **Generators**: CRUD/schema/resource generators in `generator/`.

---

## Translations - DB-only

Translations are stored entirely in the `translations` table in the database. The DB is the single source of truth - no JSON files. Every translation is a row `(lang, namespace, key_path, translation)`.

To change translations, use one of:

- `UPDATE translations SET translation = ...` or `INSERT INTO translations (...) VALUES (...)` - direct DB edits
- `bun run sync:languages` - AI-powered sync that scans the DB, translates missing keys across all namespaces, and writes results back to the DB
- `/system/translations` admin UI - manual editing through the app

**Translation reload endpoint:** The server exposes `POST /__reload-translations` so generators and the queue worker can push fresh translations to a running server without a restart. It is disabled by default. To enable it, set `INTERNAL_ADMIN_ENDPOINTS=true` and a generated `RELOAD_SECRET` of at least 32 characters in `.env`; callers pass that value in `X-Reload-Secret`.

See [AGENTS.md Translations](AGENTS.md#translations-db-first-authoritative-policy) and [internals/CONTEXT.md](internals/CONTEXT.md) for the full merge model, root fallback semantics, the prune tool, and limitations.

---

## Auth

See [`internals/CONTEXT.md`](internals/CONTEXT.md#auth-surface-what-the-core-expects-from-the-auth-plugin) for the auth plugin contract, or inspect `routes/system/auth/` for the implementation.

| Route                                  | Access        | Description                   |
| -------------------------------------- | ------------- | ----------------------------- |
| `/login`                               | Public        | Login form                    |
| `/logout`                              | Any session   | Clear session and redirect    |
| `/register/:username/:invitation_code` | Invite link   | Register with invitation code |
| `/profile`                             | Authenticated | Edit name, nickname, avatar   |
| `/password`                            | Authenticated | Change password               |
| `/invite`                              | Admin         | Generate invitation links     |
| `/invite/confirm/:token`               | Admin         | View invitation details       |

---

## Generators

```bash
bun generator/resource.ts <table_name> [--force] [--translate] [--prefix <dir>]      # Full pipeline: schema + CRUD
bun generator/resource.ts all [--force] [--translate] [--prefix <dir>]                # Full pipeline for all tables
bun generator/resource.ts bulk [--prefix <dir>]                                        # Batch-generate missing CRUDs
bun generator/schema.ts <table_name|all> [--prefix <dir>] [--parent <table>]              # Introspect DB → schema/
bun generator/crud.ts <table_name> [--force] [--prefix <dir>] [--parent <table>]      # CRUD routes + templates
bun generator/sync_translations.ts [--translate]                                        # Sync translation keys across languages
bun generator/add_language.ts --translate                                                # Add a new language
bun generator/validation_generator.ts                                                   # Generate Zod validation schemas
bun generator/reeman.ts                                                                     # Interactive reeman runner
bun generator/user.ts                                                                    # Create a user with hashed password
```

See [internals/GENERATOR_INTERNALS.md](internals/GENERATOR_INTERNALS.md#generators) for the full documentation on common flags, reeman options, nested CRUD, and cursor & offset pagination.

### Generated folder structure

Generated files per route:

```
routes/<table>/
├-- schema/                  # Schema generator output
│   ├-- table.generated.ts   # Auto-generated field definitions + TS types
│   ├-- table.ts             # User-editable: exports fields, v_fields, columns
│   └-- validation-server.ts # Zod validation schemas
├-- translations/            # DB translation keys (generated by sync_translations)
├-- index.ts                 # Route handlers (CRUD)
├-- sql.ts                   # SQL queries (CRUD)
├-- sql_view.ts              # View-based queries (if view exists, CRUD)
├-- form.ree                 # Create/edit form (CRUD)
└-- index.ree                # List/index page (CRUD)
```

### Translation Reload Endpoint

The server exposes a `POST /__reload-translations` endpoint that generators and the queue worker call after writing translated values to the database. This triggers `reload_all_translations()` and `reload_route_maps()` on the running server so navigation labels, route names, and all in-memory translations update immediately without a server restart.

Callers:

- `generator/sync_translations.ts` - after syncing all namespaces
- `generator/schema.ts` - after writing schema/nav translations
- `generator/crud/main.ts` - after writing CRUD translations
- `worker.ts` - after each `translate_batch` job completes

To enable the endpoint, set `INTERNAL_ADMIN_ENDPOINTS=true` and a generated
`RELOAD_SECRET` of at least 32 characters in `.env`. Callers must pass
`X-Reload-Secret: <value>` as a header:

```bash
curl -X POST http://localhost:2338/__reload-translations \
	-H "X-Reload-Secret: $RELOAD_SECRET"
```

Without both settings, the endpoint is not registered and behaves as a normal 404.

---

### `route_param` - Non-integer Primary Keys

Every generated `schema/table.ts` includes `export const route_param = "id";`. For tables with non-integer PKs (e.g. VARCHAR `id`), change this value to use a different column for URL routing. The CRUD generator adapts all layers:

- **Links** in `index.ree` use the route_param column
- **Delete form** POSTs to the route_param URL
- **SQL** generates `delete_record_by_route_param(value)`
- **Delete pipeline** uses the route_param directly (no extra SELECT)

### Auto-formatting

The CRUD generator runs `reettier` on the generated route directory automatically.

### Common flags

| Flag               | Description                                                                                  | Supported by                          |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `--force`          | Overwrite existing generated files without prompting.                                        | `crud.ts`, `resource.ts`              |
| `--translate`      | Use the configured AI provider to auto-translate generated translation keys into configured languages. | `resource.ts`                         |
| `--prefix`         | Nest generated routes under a subdirectory (e.g. `--prefix admin`).                          | `schema.ts`, `crud.ts`, `resource.ts` |
| `--parent`         | Mark as nested child of `<table>`. Auto-detects FK, scopes routes/queries.                   | `schema.ts`, `crud.ts`, `resource.ts` |
| `--pagination`     | Pagination strategy: `cursor` or `offset` (default: offset).                                 | `resource.ts`, `schema.ts`            |
| `--refresh-fields` | Regenerate only field sections in form.ree/index.ree using CRUD markers.                     | `crud.ts`                             |

### Resource generator usage

`bun generator/resource.ts <command> [table] [--force] [--translate] [--prefix <dir>] [--pagination <type>] [--parent <table>]`

| Command             | Description                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `schema all`        | Generate schemas for all eligible tables (introspects DB).                                |
| `schema all-tables` | Same as `schema all` (explicit alias).                                                    |
| `schema <name>`     | Generate schema for a single table.                                                       |
| `crud all`          | Generate CRUD for all tables with existing schemas.                                       |
| `crud <name>`       | Generate CRUD from existing schema for a single table.                                    |
| `bulk`              | Auto-detect tables without CRUD folders and batch-generate all (same as reeman's Bulk CRUD). |
| `all`               | Full pipeline: `schema all-tables` + `crud all`.                                          |
| `<table>`           | Full pipeline for a single table (schema + CRUD).                                         |

### Formatting on save

For `.ts`, `.js`, and `.sql` files, use `reettier` / `reesql` via the Emerald Walk run-on-save extension:

```json
"emeraldwalk.runonsave": {
	"commands": [
		{
			"match": "\\.(js|ts)$",
			"cmd": "reettier \"${file}\""
		},
		{
			"match": "\\.(sql)$",
			"cmd": "reesql \"${file}\""
		}
	]
},
```

---

## Containers

We use Podman by default on our Mac Minis. The scripts can also run with Apple's native
`container` CLI on macOS 26+ by setting `CONTAINER_ENGINE=container`.

```bash
chmod +x ../containers/containers.sh
../containers/containers.sh

# Apple container runtime
container system start
CONTAINER_ENGINE=container ../containers/containers.sh
CONTAINER_ENGINE=container bun run db:clone-test
```

## SeaweedFS S3 Server

There is a SeaweedFS-only start file. It uses the same `CONTAINER_ENGINE` switch.

```bash
chmod +x ../containers/seaweed.sh
../containers/seaweed.sh

# Apple container runtime
CONTAINER_ENGINE=container ../containers/seaweed.sh
```

## Command Code MCP

```bash
cmd mcp add --transport stdio reepolee -- bun run scripts/mcp/index.ts
```


## 💖 Support & Sponsor Reepolee Framework

Reepolee Framework is built to keep web development fast, simple, and free of `node_modules` bloat. It is 100% free and open source. 

If Reepolee Framework saves you time, powers your projects, or helps you ship clean static sites faster, consider supporting its ongoing maintenance and development!

[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-easypink?style=for-the-badge&logo=github)](https://github.com/sponsors/alesvaupotic)

### How your support helps:
- 🛠️ Maintenance & Bun compatibility updates
- 🚀 New features (plugin architecture, recipes)
- 📚 Continuous documentation improvements

---

[reepolee.com](https://www.reepolee.com)
