/**
 * Help text for the reeman non-interactive CLI (`bun reeman --help`).
 * Split out of cli.ts so the dispatcher stays focused on routing subcommands.
 */

import { color, GREEN } from "./ui";

export function print_help(): void {
	console.log(`
${color("Reeman", GREEN)} - Reepolee resource generator

${color("Usage:", GREEN)}
  bun reeman                       Interactive menu
  bun reeman <subcommand> [args]   Non-interactive CLI

${color("CRUD generators:", GREEN)}
  schema <table|all|all-tables> [--prefix <dir>] [--parent <table>] [--grid-columns <a,b,c>]
      Introspect the DB and write schema files only.

  crud <table|all|all-tables> [--force] [--prefix <dir>] [--parent <table>] [--route-name <name>]
       [--translate] [--pagination cursor|offset] [--render-strategy stream|load] [--template-tags flat|tags]
       [--grid-columns <a,b,c>]
      Full pipeline: schema + CRUD generation for one table, or every table when
      <table> is "all"/"all-tables".
      For a table carrying archived_at, config.ts declares its global_scopes and
      the reserved __live/__archived/__all scope rows are seeded automatically, which is
      what puts the archived view in the index-page scope dropdown. Existing rows are
      never overwritten; edit the declaration to add custom scope keys.
      --grid-columns picks exactly which columns the index grid displays (comma-separated,
      no count limit). Columns left out are written with grid: false - hidden from the
      grid but still available for filtering. Omit the flag to apply the default cap of
      5 usable columns. When config.ts already exists, only the grid visibility
      of already-present columns is updated to match - width, class, domain, filter,
      localized and comments on those entries are left untouched.

  bulk <table...> [--prefix <dir>] [--translate] [--pagination cursor|offset] [--render-strategy stream|load] [--template-tags flat|tags]
      Full pipeline for a specific set of tables (e.g. ones without CRUD yet). Always forces overwrite.

  refresh-crud <table> [--mode fields] [--prefix <dir>] [--parent <table>] [--translate]
      Refresh generated .ree field sections while preserving config.ts, validation_server.ts,
      and layout customizations. For structural schema changes, remove the route and generate
      it again.

  create_bread --from <schema.json> [--force] [--prefix <dir>] [--route-name <name>]
       [--pagination cursor|offset] [--render-strategy stream|load] [--template-tags flat|tags]
      Generate a single-content BREAD resource for a non-DB data source from a synthetic
      schema. The schema must contain one primary-key column named "id". Produces
      store.ts (Item/RESOURCE_NAME) instead of sql.ts - every function is a placeholder
      stub; implement it against whatever actually holds the resource's data.
      --template-tags controls form field rendering: "flat" (raw <input>/<select> markup,
      default) or "tags" (single ReeTag component per field, e.g. <input-text>) - sticky
      per-entity, persisted to config.ts whenever explicitly passed during generation.

  create_localized_bread --from <schema.json> [--force] [--prefix <dir>] [--route-name <name>]
       [--pagination cursor|offset] [--render-strategy stream|load] [--template-tags flat|tags]
      Same as create_bread, but the generated store.ts stub and form/index UI expect the
      resource's store to hold content per locale (locale_code parameters, locale-tabs
      form fields, copy-locale route) - for a developer-owned store that separates content
      by locale, not a DB table.

${color("Routes:", GREEN)}
  install <archive.tar.gz>
      Warn to back up the repository and database, unpack one marketplace folder,
      run its platform install script, then ask whether to keep or remove it.

  pack <folder>
      Archive a marketplace/<folder> into marketplace/<folder>.tar.gz.

  add-module <name>
      Add an installed routes/<name> module to the modules table and route registry.

  remove-route <url> [--force]
      Delete a registered route (folder, imports, nav). System routes are protected.

  remove-prefix-folder <name> [--force]
      Delete an entire prefixed route folder and all its sub-routes.

  remove-examples [--force]
      Delete the shipped demo routes (routes/examples/). Same removal as
      remove-prefix-folder, named for the step every new project takes.

${color("Database & config:", GREEN)}
  set-db-type <mysql|sqlite>
      Switch the active database type and update DEV_CONNECTION_STRING in .env.

  set-session-driver <auto|redis>
      Switch the session driver and update .env.

  set-repo <owner/repo>
      Link this project to a GitHub repo for dev-mode issue reports
      (Ctrl+Shift+I) - writes package.json "ree.issue_repo". Does not
      touch git remotes.

  run-sql-file <path> [--force]
      Execute a .sql file against the configured database.

  json-to-sql <path> --table <name> [--slug <slug>]
      Convert a JSON file ({"data": [...]} or a bare [...] array) into a new table.

  spreadsheet-to-sql <path.xls|path.xlsx> --table <name> [--slug <slug>] [--sheet <name>]
      Convert a named worksheet, or the first non-empty worksheet when --sheet is
      omitted, from an XLS/XLSX file into a new table.
      Both commands write paired MySQL/SQLite SQL files, normalize imported columns
      through the canonical DOMAIN_TYPES taxonomy, and seed INSERT statements.

  upload-image <table> <id> <column> <path|url> [--folder <name>] [--format webp|jpeg|png|avif] [--quality <1-100>]
      Process a local file or remote URL through the image pipeline (crop-free,
      same processor the web editor uses) and write the resulting URL into
      <table>.<column> WHERE id = <id>. Useful for seeding/backfilling image
      fields without the browser editor.

${color("Languages:", GREEN)}
  install-locale <locale_code> [--activate]
      Install an archived locale (locales-archive/) - copies its translation
      files back into place and registers it in supported locales. No AI call:
      the archived files are the curated translations. --activate also serves
      it to visitors immediately.

  add-locale <locale_code> [--translate]
      Add a BCP 47 locale to the system.

  add-locale-alias <alias_locale> <target_locale>
      Serve an existing locale's UI strings from another configured locale.

  activate-locales <locale_code...>
      Turn on one or more locales already in \`locales\` (translations already
      generated) but not yet in \`active_locales\` - runs each locale's
      prepared init SQL and flips the config. Fast path vs. add-locale.

  remove-locale <locale_code> [--force] [--new-default <locale_code>]
      Remove a language and all its translations.

  sync-locale-tables [table|all] [--dry-run]
      Create, alter, and drop the per-locale clone tables (e.g. frameworks_sl_si)
      so they match their base table plus the configured locales. Idempotent.
      Runs automatically after crud/refresh-crud and after add-locale/remove-locale.

${color("Translations:", GREEN)}
  export-translation-bundle [output.json] [--target-locale <locale_code>]
      Export every active en-us.json file into one versioned v2 translation archive.
      Route translations are source-validated leaves under the routes map.

  import-translation-bundle <file.json> [--install] [--activate]
      Validate and merge a translated v2 archive as locales-archive/<locale>.json.
      --install also restores its compatible route translations
      to the co-located live files; --activate serves the locale immediately.

  archive-live-translations
      Snapshot every current co-located non-English translation into its
      locales-archive/<locale>.json routes and generated CRUD tables maps.

  sync-translations [namespace...] [--translate]
      Sync translation structure across languages. With --translate, scans every
      namespace and fills in missing translations via the configured AI provider. Without it,
      only syncs structure for the given namespace(s) (path or dotted form), or all
      namespaces when none are given. Same as \`bun sync:translations\`.

  check-domain-compliance [--verbose] [--fix]
      Report columns not matching the canonical domain type taxonomy.
      --fix writes an ALTER TABLE SQL script for non-compliant columns.

  prune-translations
      Write DELETE statements for DB translation keys no longer referenced in templates.

  insert-translations
      Write INSERT statements for keys referenced in templates but missing from the DB.

Every subcommand run here is also appended to .reepolee/reeman.sh and
.reepolee/reeman.ps1, so a scripted session can be replayed later on any platform.
`);
}
