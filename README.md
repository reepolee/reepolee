# Reepolee Framework

<img src="static/github-reepolee.svg" style="margin-bottom:1rem; width:200px">

An MIT-licensed, database-first framework for long-lived business applications on Bun.

**Zero runtime dependencies.** Only dev dependencies.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

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

1. **Create a project**

   ```bash
   bun create reepolee/reepolee my-reepolee-project
   cd my-reepolee-project
   ```

   `bun create` fetches the starter as a tarball, so the template's Git history never
   arrives - nothing to clean up - and it initializes a fresh repository with a
   single initial commit.

2. **Run the install script**

   ```bash
   bun reepolee:install
   ```

   This script installs:
   - Project dependencies via `bun install`
   - `tw` - the Tailwind v4 Standalone Executable
   - `reettier` - the Ree template formatter
   - `reesql` - the SQL formatter
   - `vendor/` folder - vendored packages
   - `libvips` - VIPS CLI for image processing

   The bootstrap runs once: a marker file in `.reepolee/` records the
   initialization, so running `bun reepolee:install` again leaves your files
   untouched. The bootstrap runs only in a true `bun create` destination. A normal
   Git clone retains the template's `bun-create` metadata, so `postinstall` exits
   before changing package metadata, project files, or Git history. Use the manual
   clone setup below when working from a clone.

   Global tools added by the bootstrap are recorded in the project's ignored
   `.reepolee/` directory. Remove only those Reepolee-owned tools with:

   ```bash
   bun run reepolee:uninstall
   ```

   Use `bun run reepolee:uninstall --dry-run` to inspect the receipt without
   removing anything. Tools that existed before the bootstrap, or were updated
   rather than first installed by it, are not recorded and are never removed.

   Use `bun run reepolee:uninstall --force` to remove every recognized Reepolee
   global prerequisite regardless of who installed it. Combine it with
   `--dry-run` to inspect the complete removal set first.

3. **Verify the setup**

   ```bash
   bun dev
   ```

   If you see `Listening on http://localhost:2338` and the page loads in a browser, your setup is complete.

#### Manual setup (clone)

If you cloned the repository instead of using the release archive:

```bash
cp .env.example .env          # edit DEV_CONNECTION_STRING
bun install
bun dev                       # server with hot-reload (CSS rebuilt on change by the dev watcher)
```

Reeman Quick Start reads the following values from `.env` as defaults for its
admin-user prompts:

```dotenv
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=password
```

Quick Start still asks you to review or change each value, shows all three
resolved values, and asks for confirmation before creating the user.

#### Prerequisites reference

The `bun get:pre` command fetches all globally installed tools and vendored files needed to run this project. Verify with:

```bash
bun -v
tw --help | grep v   # or findstr v on Windows (the Tailwind binary is deliberately named tw)
reettier --version
```

If some are already installed, pick individual scripts:

| Purpose                  | Script            | What it does                                                                                                                                                                |
| ------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tailwind CSS          | `bun get:tw`      | Downloads standalone Tailwind v4 binary to `~/bin/tw` (avoids npm collision issues)                                                                                        |
| reettier                 | `bun get:reettier` | Downloads & installs the `reettier` binary from GitHub releases                                                                                                            |
| reesql                   | `bun get:reesql`  | Downloads & installs the `reesql` binary from GitHub releases                                                                                                              |
| Zod (vendored)           | `bun get:zod`     | Downloads `vendor/zod.min.js` from jsDelivr ESM                                                                                                                             |  
| Zod types (vendored)     | `bun get:zod-types` | Fetches the matching zod npm tarball and copies only its `.d.ts` files into `vendor/zod-types/`, so `vendor/zod.min.js` type-checks against zod's real API              |
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
bun dev                         # Main server with hot reload and CSS watcher
bun dev:worker                  # Main server plus queue worker
bun dev:reeman                  # Reeman only
bun dev:reeqa                   # ReeQA only
bun dev:all                     # Main, Reeman, ReeQA, worker, and CSS watcher
bun run worker                  # Background worker only
```

For local headless automation, use the dedicated agent-mode commands and ports described
in [Agent Mode](internals/AGENT_MODE.md). It is development-only and intentionally does
not use the normal login, session, or CSRF flow.

## Testing

```bash
bun test					# Full suite (--parallel)
bun run db:clone-test				# Clone development DB into the test DB (requires TEST_CONNECTION_STRING)
bun run db:clone-production		# Replace production DB with development DB (requires confirmation)
bun run sql <file.sql>				# Run SQL (file or stdin) against the dev DB - read-only by default, --allow-changes for writes
bun run docs:check                       # Verify relative links across repository documentation
```

Set `TEST_CONNECTION_STRING` in `.env` to a database with "test" in the name. The safety guard refuses non-test databases.

Install pre-commit hooks to run, we supply `reettier`:

```bash
bun git:hooks
```

## Production

```bash
bun run css:build				# Build minified CSS
bun start						# bun apps/main/server.ts --prod
```

### Required environment

`bun start` (`--prod`) refuses to boot unless these are set:

| Var             | Value                        | Notes                                                                   |
| --------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `CSRF_SECRET`   | 32+ chars                    | HMAC key for CSRF tokens. Must not change between deploys.               |
| `RATE_LIMITING` | `true`                       | Plus `TRUST_PROXY` - see [RUNTIME.md](internals/RUNTIME.md#rate-limiting). |

Generate the CSRF secret once and keep it stable - a value that changes on restart
invalidates every form open in a browser:

```bash
openssl rand -base64 48
```

CSRF tokens are signed and bound to the requesting browser, with no fallback for the
older unsigned tokens - a stale token costs one 403 and is replaced on the next page
load. Details in [RUNTIME.md](internals/RUNTIME.md#csrf).

Versioning and distribution packaging are maintainer workflows. This checkout does not define
`release` or `release:update-hashes` package scripts. Do not copy release commands from older
documentation without first confirming the current release tooling and target branch.

You can also start PM2 for long term running

```bash
pm2 start operations/ecosystem.config.cjs
```

and then use `pm2 logs` or `pm2 monit` to check the runtime progress.

---

## Architecture

- **Runtime**: Bun only. No runtime dependencies.
- **Entry**: `apps/main/server.ts` - Bun server with route table from `apps/main/routes.ts`.
- **Templates**: `.ree` files in `apps/main/`, custom engine at `lib/template_engine.ts`.
- **Routes**: Route handlers export named functions, registered in `routes.ts`.
- **Database**: Bun's `SQL` API → MySQL or SQLite via `config/db.ts`.
- **CSS**: Tailwind v4 via standalone CLI.
- **Auth**: Cookie-based sessions, invite-only registration, profile management.
- **Generators**: CRUD/schema/resource generators in `generator/`.

---

## Translations - co-located JSON

UI translations are stored either in co-located `{locale}.json` files or an optional `locales/{locale}.json` directory. A route namespace such as `auth.login` maps to `platform/auth/login/{locale}.json` or `platform/auth/login/locales/{locale}.json`; root fallback strings use the same layout at the repository root. Do not use both layouts for the same namespace and locale.

To change translations, use one of:

- edit the namespace JSON file directly
- `bun reeman sync-translations --translate` - AI-powered sync across namespace files
- `/translations` admin UI in the reeman app (`bun run dev:reeman`) - manual editing through the app

For external translation services, use the versioned bundle workflow:

- `bun reeman export-translation-bundle translation.json --target-locale de-de` exports every current `en-us.json`, keyed by repository-relative path.
- Translate only the string leaves in `files.*.translations`; preserve keys, placeholders, hashes, and metadata.
- `bun reeman import-translation-bundle translation.json` validates and archives it as one `locales-archive/{locale}.json` file.
- Add `--install` to restore the translated files into their co-located live folders, or import the archived locale from Reeman's Locales page.

Imports accept partial file/key sets and merge them into the existing archived locale. Source paths ending in either `en-us.json` or the target locale filename are normalized. Unknown paths or keys, invalid value types, and damaged placeholders are rejected; omitted translations remain unchanged.

**Translation reload endpoint:** The server exposes `POST /__reload-translations` so generators and the queue worker can push fresh translations to a running server without a restart. It is disabled by default. To enable it, set `INTERNAL_ADMIN_ENDPOINTS=true` and a generated `RELOAD_SECRET` of at least 32 characters in `.env`; callers pass that value in `X-Reload-Secret`.

See [AGENTS.md Translations](AGENTS.md#translations-file-first-authoritative-policy) and [internals/CONTEXT.md](internals/CONTEXT.md) for the full merge model, root fallback semantics, the prune tool, and limitations.

---

## Auth

See [`internals/CONTEXT.md`](internals/CONTEXT.md#auth-surface-what-the-core-expects-from-the-auth-plugin) for the auth plugin contract, or inspect `platform/auth/` for the implementation.

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

Generator actions run through `reeman` - either interactively (`bun reeman`) or as a non-interactive
subcommand (`bun reeman <subcommand> [args]`). Interactive actions are also available as scripted commands
and share their underlying library functions. The CLI-only marketplace installer is the exception: it runs
the unpacked platform installer as a subprocess. User creation remains available through `generator/user.ts`.

```bash
bun reeman                                                                    # Interactive menu
bun reeman schema <table_name|all> [--prefix <dir>] [--parent <table>]       # Introspect DB → schema/
bun reeman crud <table_name> [--force] [--prefix <dir>] [--parent <table>]   # Full pipeline: schema + CRUD
bun reeman crud all [--force] [--translate] [--prefix <dir>]                 # Full pipeline for every table
bun reeman bulk <table...> [--prefix <dir>]                                  # Full pipeline for a specific set of tables
bun reeman refresh-crud <table> [--mode fields|full]                         # Regenerate CRUD for an existing route
bun reeman install <archive.tar.gz>                                          # Install a marketplace archive
bun reeman sync-translations [namespace...] [--translate]                    # Sync translation keys across configured locales
bun reeman insert-translations                                                # Add template keys missing from the co-located locale files
bun reeman prune-translations                                                 # Report locale-file keys no longer referenced in templates
bun reeman add-locale <locale_code> [--translate]                            # Add a BCP 47 locale
bun reeman add-locale-alias <alias_locale> <target_locale>                   # Point one locale at another's translations
bun reeman remove-locale <locale_code> [--force] [--new-default <code>]      # Remove a locale and its translations
bun reeman sync-locale-tables [table|all] [--dry-run]                        # Reconcile the per-locale clone tables
bun reeman remove-examples [--force] [--delete-translations]                 # Delete the shipped demo routes (apps/main/examples/)
bun reeman remove-route <url> [--force] [--delete-translations]              # Delete one registered route
bun reeman remove-prefix-folder <name> [--force] [--delete-translations]     # Delete a prefixed route folder and its sub-routes
bun reeman run-sql-file <path> [--force]                                     # Execute a .sql file against the configured DB
bun reeman json-to-sql <path> --table <name> [--slug <slug>]                 # Turn a JSON file into a seeded table
bun reeman set-db-type <mysql|sqlite>                                        # Switch DB type and rewrite DEV_CONNECTION_STRING
bun reeman set-session-driver <auto|redis>                                   # Switch the session driver in .env
bun reeman check-domain-compliance [--verbose] [--fix]                       # Flag columns outside the canonical domain types
bun reeman --help                                                            # Full subcommand reference
bun generator/user.ts                                                        # Create a user with hashed password
```

See [internals/GENERATOR_INTERNALS.md](internals/GENERATOR_INTERNALS.md#generators) for the full documentation on common flags, reeman options, nested CRUD, and cursor & offset pagination.

### Generated folder structure

Generated files per route:

```
apps/main/<table>/
- schema/                  # Schema generator output
  - table.generated.ts     # Auto-generated field definitions + TS types
  - table.ts               # User-editable: exports fields, v_fields, columns
  - validation_server.ts   # Zod validation schemas
- {locale}.json            # Co-located UI translations (one file per locale)
- index.ts                 # Route handlers (CRUD)
- sql.ts                   # SQL queries (CRUD)
- sql_view.ts              # View-based queries (if view exists, CRUD)
- form.ree                 # Create/edit form (CRUD)
- index.ree                # List/index page (CRUD)
```

### Translation Reload Endpoint

The server exposes a `POST /__reload-translations` endpoint that generators and the queue worker call after writing translated values to the co-located locale files. This triggers `reload_all_translations()` and `reload_route_maps()` on the running server so navigation labels, route names, and all in-memory translations update immediately without a server restart.

Callers:

- `bun reeman sync-translations` - after syncing all namespaces
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

| Flag               | Description                                                                                  | Supported by                        |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| `--force`          | Overwrite existing generated files without prompting.                                        | `crud`, `all`, `bulk`               |
| `--translate`      | Use the configured AI provider to auto-translate generated translation keys into configured locales. | `crud`, `all`, `bulk`, `sync-translations` |
| `--prefix`         | Nest generated routes under a subdirectory (e.g. `--prefix admin`).                          | `schema`, `crud`, `all`, `bulk`     |
| `--parent`         | Mark as nested child of `<table>`. Auto-detects FK, scopes routes/queries.                   | `schema`, `crud`, `refresh-crud`    |
| `--pagination`     | Pagination strategy: `cursor` or `offset` (default: offset).                                 | `schema`, `crud`, `all`, `bulk`, `refresh-crud` |
| `--refresh-fields` | Regenerate only field sections in form.ree/index.ree using CRUD markers.                     | `refresh-crud --mode fields`        |

### Reeman subcommand reference

`bun reeman <subcommand> [table] [--force] [--translate] [--prefix <dir>] [--pagination <type>] [--parent <table>]`

| Subcommand      | Description                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `schema all`    | Generate schemas for all eligible tables (introspects DB).                                    |
| `schema <name>` | Generate schema for a single table.                                                           |
| `crud <name>`   | Full pipeline for a single table: schema + CRUD.                                              |
| `crud all`      | Full pipeline for every table in the database.                                                |
| `bulk <t...>`   | Full pipeline for a specific set of tables (e.g. ones without CRUD yet). Same as reeman's interactive Bulk CRUD flow. |
| `refresh-crud <name>` | Regenerate CRUD for a route that already has a schema folder.                            |
| `install <archive.tar.gz>` | Unpack and run a platform-specific marketplace installer.                       |
| `sync-translations [namespace...] [--translate]` | Sync translation structure across configured locales, optionally filling missing values with the configured AI provider. |
| `add-locale <locale_code> [--translate]` | Add a BCP 47 locale to `config/supported_locales.ts` and initialize its `{locale}.json` files. |
| `insert-translations` | Scan `.ree` templates and add referenced translation keys missing from the co-located locale files. |
| `prune-translations` | Scan `.ree` templates and report (optionally delete) locale-file keys no longer referenced. |

Run `bun reeman --help` for the complete list, including route removal, DB/session config, and translation subcommands.

### Session replay log

Every reeman action - interactive or scripted - is appended as a plain command line to both `.reepolee/reeman.sh` and `.reepolee/reeman.ps1` in the project root. Replay a whole session later on any platform with `bash .reepolee/reeman.sh` or `pwsh .reepolee/reeman.ps1`. In the interactive menu, the "Press Enter to continue..." prompt after an action also offers `[c]` to copy the equivalent CLI command to your system clipboard (via OSC 52 - works locally and over SSH).

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

## Marketplace

Marketplace apps are distributed as `.tar.gz` archives. Each archive must contain exactly one top-level folder with:

- `mysql/*.sql` and `sqlite/*.sql` - seed data for the demo's tables, one file per dialect.
- `install.ps1` - the Windows installer.
- `install.sh` - the macOS and Linux installer.
- Any images or other assets the seed data references.

Install an archive from the project root:

```bash
bun reeman install ./studio.tar.gz
```

Reeman warns you to back up the repository and database, then asks for confirmation before making changes. It unpacks the archive to `marketplace/<folder>/`, runs `install.ps1` on Windows or `install.sh` on macOS and Linux from the project root, and finally asks whether to keep or remove the unpacked marketplace folder. The installer script is trusted project code and may modify routes, configuration, and database data.

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
