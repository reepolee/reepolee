# Studio DDL Editor: Technical Manual

Studio is an optional main-router module mounted at /studio. It is server rendered,
permission gated, CSRF protected, and uses full-page navigation plus
POST/redirect/GET mutations.

## Architecture

Request flow:

1. Browser requests /studio with optional path and object query parameters.
2. Main middleware applies rate limiting, language, CSRF, and Studio authorization.
3. page.ts builds request-scoped data and renders index.ree in the Studio layout.
4. handlers.ts validates mutations and redirects after writes.
5. The domain layer reads and writes an allowlisted SQL file with embedded metadata.

The browser never owns a complete StudioFile. Every mutation reloads and parses the
current source, applies one validated operation, writes it, and reparses it.

## File Layout

The studio module lives at `apps/reeman/studio` and is served by the reeman
app. Its `install.sh`/`install.ps1` copy the folder to a customer project's
`routes/studio` (registering the `studio` module via `bun reeman add-module
studio` and executing the module-owned translation SQL). The folder contains:

- index.ts: route definitions
- page.ts: GET rendering and page data
- handlers.ts: POST handlers, redirects, and toasts
- index.ree: server-rendered workspace
- lib/types.ts: typed DDL model
- lib/sql_files.ts: discovery and path allowlist
- lib/ddl_parser.ts: statement splitting and classification
- lib/column_parser.ts: columns and table foreign keys
- lib/sql_tokens.ts: balanced parentheses and quoted strings
- lib/ddl_writer.ts: table rendering and file serialization
- lib/domain_types.ts: canonical types and naming
- lib/studio_metadata.ts: embedded domain mapping persistence
- lib/form_data.ts: untrusted form validation and overlay
- lib/model.ts: file IO and table/view actions
- lib/*.test.ts: focused domain tests

static/studio.js contains transient form enhancement only. The two manuals remain under
studio/. All server implementation files stay below the project 300-line guideline.

## Routing and Authorization

The internal `apps/reeman/routes.ts` mounts `apps/reeman/studio` as the virtual `studio`
route namespace. The public route registry omits Studio. A customer installation uses
the normal `try_load_routes` entry for the copied `routes/studio` folder (see the
`install.sh`/`install.ps1` scripts in this folder).

The parent route definition has module studio. The normal route builder applies
require_module_mw and publisher signaling to every Studio route.

Routes:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /studio | File chooser, table form, or view |
| POST | /studio/table/save | Validate and rewrite one table |
| POST | /studio/table/new | Add a default table |
| POST | /studio/table/copy | Clone a table definition |
| POST | /studio/table/delete | Remove table-related statements |
| POST | /studio/view/generate | Generate or replace v_<table> |
| POST | /studio/preview | Validate form data and return DDL text |

The module seed contains studio. Users also need studio in modules_tags.

## Read and Save Flow

GET creates RequestContext, lists files, validates an optional path, parses the SQL,
applies embedded mappings, detects missing conventional domain types, and selects a table
or view before rendering through the Studio layout.

Save performs these steps:

1. Parse URL-encoded form data.
2. Validate path and table identity.
3. Reload the current SQL file.
4. Clone server-owned columns using stable source indexes.
5. Overlay validated editable fields in submitted DOM order.
6. Mark only the selected table dirty.
7. Serialize SQL with its metadata footer, write it atomically, and redirect.

Validation covers row alignment, maximum count, snake-case and duplicate names, SQL type
shape, nullability, booleans, and table.column references. Existing modifier order,
unknown raw modifiers, comments, generated spacing, and unchanged FK actions survive.

## Parser and Writer

The parser targets Reepolee conventions, not arbitrary SQL. It respects SQL strings,
top-level parentheses, gap comments, trigger bodies, top-level column commas, inline
references, and table foreign keys. Unknown statements remain raw and byte-identical.

Generated columns preserve whitespace between AS and the opening parenthesis. This fixes
the former difference between AS(expr) and AS (expr).

serialize_studio_file regenerates only dirty or new CREATE TABLE statements. All other
statements use their original gap and text.

New tables expand to a drop, create, optional name index, and SQLite updated-at trigger.
They are inserted before the first view.

## Views and Studio Metadata

View generation detects explicit references and conventional *_id names, emits left
joins, and handles repeated aliases. It writes a drop plus create statement.

The end of each SQL file contains line-commented JSON between reepolee-studio markers.
It stores only table and column domain mappings, so the complete file remains directly
executable by MySQL and SQLite. Missing or malformed metadata is ignored.

## Domain Types

Canonical mappings remain in config/domain_types/sqlite.ts and mysql.ts. Studio adds
input metadata through the existing generator type mappers. It maintains no separate
SQL taxonomy.

Name detection covers conventional core fields, configured image/file/boolean rules,
date and timestamp suffixes, and duration suffixes.

## Client Enhancement

static/studio.js handles add, remove, drag order, domain/type synchronization, debounced
preview, hide-system state, favorites, recents, and unsaved-change warnings.

It does not render the page, route between objects, persist DDL state, or write files.
Successful mutations always reload the full page.

## Translations and Styles

Studio translations are co-located English and Slovenian JSON files in the
`apps/reeman/studio/locales/` directory.

The template uses a Studio copy of the application layout so tables and views can occupy
the sidebar while the logo still returns to the main application. It shares the application
CSS, form controls, icons, banners, dialogs, language selector, and theme behavior. There is
no Studio-specific CSS build.

## Verification

Focused checks:

    bun test apps/reeman/studio/lib
    bun run typecheck
    bun naming:check

Before delivery run the full test suite and exercise the normal main server in a browser.
Confirm both dialects, themes, responsive widths, preview, save/reload, all table actions,
permissions, CSRF, SQL diffs, and embedded metadata.

## Distribution

The studio module ships inside the reeman app (`apps/reeman/studio`). Its
`install.sh`/`install.ps1` copy the complete module to a customer project's
`routes/studio`, register the `studio` route module (`bun reeman add-module
studio`), and execute the module-owned translation SQL for the project's
dialect. In the reepolee dev repo itself the module stays mounted from
`apps/reeman/studio`.
