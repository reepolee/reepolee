#!/usr/bin/env bun
/**
 * reeman non-interactive CLI - `bun reeman <subcommand> [args]`.
 *
 * Most interactive actions are also reachable here for scripted use, and call
 * the same underlying library functions. CLI-only actions such as marketplace
 * installation live here when an interactive menu equivalent is not needed.
 *
 * Returns true if a known subcommand was handled (caller should exit),
 * false if argv[2] isn't a recognized subcommand (caller should fall
 * through to the interactive menu).
 */

import { rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { db_cli } from "$config/db_cli";

import { add_locale_to_system } from "../add_locale";
import { add_locale_alias_to_system } from "../add_locale_alias";
import { remove_locale_from_system } from "../remove_locale";
import { add_module } from "./add_module";
import { find_missing_keys, write_missing_sql } from "./insert_translations";
import { find_orphaned_keys, write_prune_sql } from "./prune_translations";
import { install_marketplace_archive } from "./install_archive";
import { pack_marketplace_folder } from "./pack_archive";
import { convert_json_to_sql } from "./json_to_sql";
import { execute_sql_file } from "./run_sql_file";
import { generate_schema } from "../schema";
import { run_full_pipeline } from "./callers/resource_caller";
import { refresh_crud_fields_only, refresh_crud_for_table, update_pagination_strategy } from "./refresh_crud";
import { sync_locale_tables_command } from "./sync_locale_tables";
import { remove_examples_folder, remove_prefix_folder } from "./remove_prefix_route";
import { remove_route } from "./remove_route";
import { set_db_type } from "./set_db_type";
import { set_session_driver } from "./set_session_driver";
import { sync_all_namespaces, sync_single_namespace } from "../translate_namespace";
import { upload_image } from "./upload_image";
import { color, confirm, GREEN, log_command, RED, YELLOW } from "./ui";

// ---------------------------------------------------------------------------
// Shared flag parsing for the CRUD generator commands (schema/crud/full/all)
// ---------------------------------------------------------------------------

function parse_crud_flags(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			force: { type: "boolean", default: false },
			translate: { type: "boolean", default: false },
			prefix: { type: "string", default: "" },
			parent: { type: "string", default: "" },
			"route-name": { type: "string", default: "" },
			pagination: { type: "string" },
			"render-strategy": { type: "string" },
			"template-tags": { type: "string" },
			"grid-columns": { type: "string" },
		},
		allowPositionals: true,
		strict: false,
	});

	const raw_pagination = values.pagination;
	const pagination_method: "cursor" | "offset" | undefined = raw_pagination === "cursor" || raw_pagination === "offset" ? raw_pagination : undefined;

	const raw_render = values["render-strategy"];
	const render_strategy: "stream" | "load" | undefined = raw_render === "stream" || raw_render === "load" ? raw_render : undefined;

	const raw_template_tags = values["template-tags"];
	const template_tags: "flat" | "tags" | undefined = raw_template_tags === "flat" || raw_template_tags === "tags" ? raw_template_tags : undefined;

	// Comma-separated index-grid column selection. Anything outside the list is
	// written with grid: false. Omitted entirely means "apply the default cap".
	const raw_grid_columns = values["grid-columns"];
	const parsed_grid_columns = raw_grid_columns ? String(raw_grid_columns).split(",").map((c) => c.trim()).filter(Boolean) : [];
	const grid_columns = parsed_grid_columns.length > 0 ? parsed_grid_columns : undefined;

	return {
		table: positionals[0] !== undefined ? String(positionals[0]) : undefined,
		force: Boolean(values.force),
		translate: Boolean(values.translate),
		prefix: String(values.prefix ?? ""),
		parent: String(values.parent ?? ""),
		route_name: String(values["route-name"] ?? ""),
		pagination_method,
		render_strategy,
		template_tags,
		grid_columns,
	};
}

// ---------------------------------------------------------------------------
// Namespace resolution for sync-translations - accepts either a route path
// (e.g. "routes/system/users") or a dotted namespace (e.g. "system.users"),
// matching sync_translations.ts's original dir_to_namespace() (now folded in here).
// ---------------------------------------------------------------------------

function resolve_sync_namespace(arg: string): string {
	const routes_root = join(process.cwd(), "routes");
	const full_path = join(process.cwd(), arg);
	const rel = relative(routes_root, full_path).replaceAll("\\", "/");
	if (rel === "." || rel === "" || rel.startsWith("..")) { return arg; }
	return rel.split("/").join(".");
}

/**
 * Load the DDL cache for a generator subcommand, always re-introspecting first.
 *
 * Schema changes are normally made outside reeman (direct mysql/sqlite3 calls,
 * migration tools), and those leave the on-disk cache valid for its 24h TTL.
 * Reading it would generate against a schema that no longer exists, so the CLI
 * refreshes unconditionally - same as the interactive menu's startup
 * (reeman/index.ts). Introspection is one pass over the DB, paid once per command.
 */
async function load_fresh_ddl_cache(): Promise<void> {
	const { invalidate_cache, load_ddl_cache } = await import("../ddl_cache");
	invalidate_cache();
	await load_ddl_cache({ force_refresh: true });
}

async function run_all_tables(flags: ReturnType<typeof parse_crud_flags>): Promise<boolean> {
	const { get_available_tables } = await import("./db");
	const tables = await get_available_tables();
	let success = true;
	for (const table of tables) {
		const ok = await run_full_pipeline(table, {
			prefix: flags.prefix,
			force: flags.force,
			translate: flags.translate,
			pagination_method: flags.pagination_method,
			render_strategy: flags.render_strategy,
			template_tags: flags.template_tags,
		});
		if (!ok) success = false;
	}
	return success;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function print_help(): void {
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
      --grid-columns picks exactly which columns the index grid displays (comma-separated,
      no count limit). Columns left out are written with grid: false - hidden from the
      grid but still available for filtering. Omit the flag to apply the default cap of
      5 usable columns. Only applies when scaffolding schema/table.ts for the first time;
      an existing table.ts keeps its hand-tuned columns map.

  bulk <table...> [--prefix <dir>] [--translate] [--pagination cursor|offset] [--render-strategy stream|load] [--template-tags flat|tags]
      Full pipeline for a specific set of tables (e.g. ones without CRUD yet). Always forces overwrite.

  refresh-crud <table> [--mode fields|full] [--prefix <dir>] [--parent <table>]
               [--pagination cursor|offset] [--template-tags flat|tags] [--translate] [--reinject-children]
      Regenerate CRUD for a route that already has a schema folder. fields mode only
      touches .ree field sections (preserves CSS/layout) and reuses the existing schema.
      full re-introspects the DB, rewrites schema/table.generated.ts, then overwrites all
      generated files. Neither mode rewrites schema/table.ts wholesale - full mode merges
      columns added to the DB since scaffolding into its columns map, leaving existing
      entries untouched.
      --reinject-children re-applies child integration to a parent's files.
      --template-tags controls form field rendering: "flat" (raw <input>/<select> markup,
      default) or "tags" (single ReeTag component per field, e.g. <input-text>) - sticky
      per-entity, persisted to schema/table.ts whenever explicitly passed.

${color("Routes:", GREEN)}
  install <archive.tar.gz>
      Warn to back up the repository and database, unpack one marketplace folder,
      run its platform install script, then ask whether to keep or remove it.

  pack <folder>
      Archive a marketplace/<folder> into marketplace/<folder>.tar.gz.

  add-module <name>
      Add an installed routes/<name> module to the modules table and route registry.

  remove-route <url> [--force] [--delete-translations]
      Delete a registered route (folder, imports, nav). System routes are protected.

  remove-prefix-folder <name> [--force] [--delete-translations]
      Delete an entire prefixed route folder and all its sub-routes.

  remove-examples [--force] [--delete-translations]
      Delete the shipped demo routes (routes/examples/). Same removal as
      remove-prefix-folder, named for the step every new project takes.

${color("Database & config:", GREEN)}
  set-db-type <mysql|sqlite>
      Switch the active database type and update CONNECTION_STRING in .env.

  set-session-driver <auto|redis>
      Switch the session driver and update .env.

  run-sql-file <path> [--force]
      Execute a .sql file against the configured database.

  json-to-sql <path> --table <name> [--slug <slug>]
      Convert a JSON file ({"data": [...]} or a bare [...] array) into a new
      table - writes paired sql/mysql/NN-<slug>.sql + sql/sqlite/NN-<slug>.sql
      with system columns (id, display, created_at, updated_at) and INSERT
      statements seeded from the rows.

  upload-image <table> <id> <column> <path|url> [--folder <name>] [--format webp|jpeg|png|avif] [--quality <1-100>]
      Process a local file or remote URL through the image pipeline (crop-free,
      same processor the web editor uses) and write the resulting URL into
      <table>.<column> WHERE id = <id>. Useful for seeding/backfilling image
      fields without the browser editor.

${color("Languages:", GREEN)}
  add-locale <locale_code> [--translate]
      Add a BCP 47 locale to the system.

  add-locale-alias <alias_locale> <target_locale>
      Serve an existing locale's UI strings from another configured locale.

  remove-locale <locale_code> [--force] [--new-default <locale_code>]
      Remove a language and all its translations.

  sync-locale-tables [table|all] [--dry-run]
      Create, alter, and drop the per-locale clone tables (e.g. frameworks_sl_si)
      so they match their base table plus the configured locales. Idempotent.
      Runs automatically after crud/refresh-crud and after add-locale/remove-locale.

${color("Translations:", GREEN)}
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

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const KNOWN_SUBCOMMANDS = new Set([
	"schema",
	"crud",
	"bulk",
	"refresh-crud",
	"install",
	"pack",
	"add-module",
	"add-locale",
	"add-locale-alias",
	"remove-locale",
	"sync-locale-tables",
	"remove-route",
	"remove-prefix-folder",
	"remove-examples",
	"set-db-type",
	"set-session-driver",
	"run-sql-file",
	"json-to-sql",
	"upload-image",
	"sync-translations",
	"check-domain-compliance",
	"prune-translations",
	"insert-translations",
]);

export async function run_cli(argv: string[]): Promise<boolean> {
	const [subcommand, ...rest] = argv;
	if (!subcommand) return false;

	if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
		print_help();
		process.exit(0);
	}

	// Log the exact invocation so the session replay log (.reepolee/reeman.sh
	// and .ps1) captures scripted reeman runs the same way it captures menu-driven
	// ones - no per-branch reconstruction, no risk of the logged line drifting
	// from what was actually typed. remove-route/remove-prefix-folder/set-db-type/
	// set-session-driver log themselves (via show_cli_tip) once they know the
	// resolved values (e.g. whether translations were actually deleted), so
	// they're skipped here to avoid a duplicate line.
	const SELF_LOGGING = new Set(["remove-route", "remove-prefix-folder", "remove-examples", "set-db-type", "set-session-driver"]);
	if (KNOWN_SUBCOMMANDS.has(subcommand) && !SELF_LOGGING.has(subcommand)) { await log_command(`bun reeman ${argv.join(" ")}`); }

	switch (subcommand) {
		case "install": {
			const archive_path = rest[0] ?? "";
			if (!archive_path || rest.length !== 1) {
				console.error("Usage: bun reeman install <archive.tar.gz>");
				process.exit(1);
			}
			try {
				console.log(color("Marketplace installers can modify repository files and the database.", YELLOW));
				console.log(color("Back up the repository and database before continuing.", YELLOW));
				const proceed = await confirm("Continue with marketplace installation?", "n");
				if (!proceed) {
					console.log(color("Installation cancelled.", YELLOW));
					process.exit(0);
				}
				const module_root = await install_marketplace_archive(archive_path);
				console.log(`${color("✓", GREEN)} Marketplace archive installed: ${module_root}`);
				const remove_unpacked = await confirm("Remove the unpacked marketplace folder?", "n");
				if (remove_unpacked) {
					await rm(module_root, { recursive: true, force: true });
					console.log(`${color("✓", GREEN)} Removed unpacked marketplace folder: ${module_root}`);
				} else {
					console.log(`${color("✓", GREEN)} Kept unpacked marketplace folder: ${module_root}`);
				}
				process.exit(0);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`${color("Install failed:", RED)} ${message}`);
				process.exit(1);
			}
		}

		case "pack": {
			const folder_name = rest[0] ?? "";
			if (!folder_name || rest.length !== 1) {
				console.error("Usage: bun reeman pack <folder>");
				process.exit(1);
			}
			try {
				const archive_path = await pack_marketplace_folder(folder_name);
				console.log(`${color("✓", GREEN)} Packed marketplace archive: ${archive_path}`);
				process.exit(0);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`${color("Pack failed:", RED)} ${message}`);
				process.exit(1);
			}
		}

		case "add-module": {
			const module_code = rest[0] ?? "";
			if (!module_code || rest.length !== 1) {
				console.error("Usage: bun reeman add-module <name>");
				process.exit(1);
			}
			await add_module(module_code);
			process.exit(0);
		}

		case "schema": {
			const flags = parse_crud_flags(rest);
			if (!flags.table) {
				console.error("Usage: bun reeman schema <table | all | all-tables> [--prefix <dir>] [--parent <table>]");
				process.exit(1);
			}
			await load_fresh_ddl_cache();
			const success = await generate_schema(flags.table, {
				prefix: flags.prefix,
				parent_table: flags.parent,
				pagination_strategy: flags.pagination_method,
				route_name: flags.route_name,
				grid_columns: flags.grid_columns,
			});
			process.exit(success ? 0 : 1);
		}

		case "crud": {
			const flags = parse_crud_flags(rest);
			if (!flags.table) {
				console.error(
					"Usage: bun reeman crud <table | all | all-tables> [--force] [--prefix <dir>] [--parent <table>] [--translate] [--pagination cursor|offset] [--render-strategy stream|load] [--template-tags flat|tags]"
				);
				process.exit(1);
			}
			await load_fresh_ddl_cache();
			const success = flags.table === "all" || flags.table === "all-tables"
				? await run_all_tables(flags)
				: await run_full_pipeline(flags.table, {
					prefix: flags.prefix,
					parent_table: flags.parent,
					force: flags.force,
					translate: flags.translate,
					pagination_method: flags.pagination_method,
					render_strategy: flags.render_strategy,
					route_name: flags.route_name,
					template_tags: flags.template_tags,
					grid_columns: flags.grid_columns,
				});
			process.exit(success ? 0 : 1);
		}

		case "bulk": {
			const flags = parse_crud_flags(rest);
			const { positionals } = parseArgs({ args: rest, allowPositionals: true, strict: false });
			const tables = positionals.map((p) => String(p));
			if (tables.length === 0) {
				console.error("Usage: bun reeman bulk <table...> [--prefix <dir>] [--translate] [--pagination cursor|offset] [--render-strategy stream|load] [--template-tags flat|tags]");
				process.exit(1);
			}
			await load_fresh_ddl_cache();
			const { run_bulk_generator } = await import("./callers/resource_caller");
			const result = await run_bulk_generator(
				tables,
				flags.prefix,
				flags.translate,
				flags.pagination_method ?? "offset",
				flags.render_strategy ?? "load",
				flags.template_tags
			);
			console.log(`${color("✓", GREEN)} Bulk complete: ${result.success}/${tables.length} generated`);
			process.exit(result.fail === 0 ? 0 : 1);
		}

		case "add-locale": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: { translate: { type: "boolean", default: false } },
				allowPositionals: true,
				strict: false,
			});
			const locale_code = positionals[0] !== undefined ? String(positionals[0]) : "";
			if (!locale_code) {
				console.error("Usage: bun reeman add-locale <locale_code> [--translate]");
				process.exit(1);
			}
			const success = await add_locale_to_system(locale_code, { translate: Boolean(values.translate) });
			process.exit(success ? 0 : 1);
		}

		case "add-locale-alias": {
			const alias_locale = rest[0] || "";
			const target_locale = rest[1] || "";
			if (!alias_locale || !target_locale) {
				console.error("Usage: bun reeman add-locale-alias <alias_locale> <target_locale>");
				process.exit(1);
			}
			const success = await add_locale_alias_to_system(alias_locale, target_locale);
			process.exit(success ? 0 : 1);
		}

		case "sync-locale-tables": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: { "dry-run": { type: "boolean", default: false } },
				allowPositionals: true,
				strict: false,
			});
			const target = positionals[0] !== undefined ? String(positionals[0]) : "";
			const table = target && target !== "all" ? target : undefined;
			const success = await sync_locale_tables_command(table, Boolean(values["dry-run"]));
			process.exit(success ? 0 : 1);
		}

		case "remove-locale": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					force: { type: "boolean", default: false },
					"new-default": { type: "string", default: "" },
				},
				allowPositionals: true,
				strict: false,
			});
			const lang_code = positionals[0] !== undefined ? String(positionals[0]) : "";
			if (!lang_code) {
				console.error("Usage: bun reeman remove-locale <lang_code> [--force] [--new-default <lang>]");
				process.exit(1);
			}
			const success = await remove_locale_from_system(lang_code, {
				force: Boolean(values.force),
				new_default: values["new-default"] ? String(values["new-default"]) : undefined,
			});
			process.exit(success ? 0 : 1);
		}

		case "remove-route": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					force: { type: "boolean", default: false },
					"delete-translations": { type: "boolean" },
				},
				allowPositionals: true,
				strict: false,
			});
			const url = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			if (!url) {
				console.error("Usage: bun reeman remove-route <url> [--force] [--delete-translations]");
				process.exit(1);
			}
			await remove_route(url, Boolean(values.force), values["delete-translations"] === undefined ? undefined : Boolean(values["delete-translations"]));
			process.exit(0);
		}

		case "remove-prefix-folder": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					force: { type: "boolean", default: false },
					"delete-translations": { type: "boolean" },
				},
				allowPositionals: true,
				strict: false,
			});
			const name = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			if (!name) {
				console.error("Usage: bun reeman remove-prefix-folder <name> [--force] [--delete-translations]");
				process.exit(1);
			}
			await remove_prefix_folder(name, Boolean(values.force), values["delete-translations"] === undefined ? undefined : Boolean(values["delete-translations"]));
			process.exit(0);
		}

		case "remove-examples": {
			const { values } = parseArgs({
				args: rest,
				options: {
					force: { type: "boolean", default: false },
					"delete-translations": { type: "boolean" },
				},
				allowPositionals: true,
				strict: false,
			});
			await remove_examples_folder(Boolean(values.force), values["delete-translations"] === undefined ? undefined : Boolean(values["delete-translations"]));
			process.exit(0);
		}

		case "set-db-type": {
			const type = rest[0];
			if (type !== "mysql" && type !== "sqlite") {
				console.error("Usage: bun reeman set-db-type <mysql|sqlite>");
				process.exit(1);
			}
			const result = await set_db_type(type);
			process.exit(result ? 0 : 1);
		}

		case "set-session-driver": {
			const driver = rest[0];
			if (driver !== "auto" && driver !== "redis") {
				console.error("Usage: bun reeman set-session-driver <auto|redis>");
				process.exit(1);
			}
			await set_session_driver(driver);
			process.exit(0);
		}

		case "refresh-crud": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					mode: { type: "string", default: "full" },
					prefix: { type: "string", default: "" },
					parent: { type: "string", default: "" },
					"route-name": { type: "string", default: "" },
					pagination: { type: "string" },
					"template-tags": { type: "string" },
					translate: { type: "boolean", default: false },
					"reinject-children": { type: "boolean", default: false },
				},
				allowPositionals: true,
				strict: false,
			});
			const table = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			const mode = values.mode === "fields" ? "fields" : "full";
			const pagination_raw = values.pagination;
			const pagination_method: "cursor" | "offset" | undefined = pagination_raw === "cursor" || pagination_raw === "offset" ? pagination_raw : undefined;
			const template_tags_raw = values["template-tags"];
			const template_tags: "flat" | "tags" | undefined = template_tags_raw === "flat" || template_tags_raw === "tags" ? template_tags_raw : undefined;
			const prefix = String(values.prefix ?? "");
			const parent = String(values.parent ?? "") || undefined;
			const route_name = String(values["route-name"] ?? "") || undefined;
			const translate = Boolean(values.translate);

			if (!table) {
				console.error("Usage: bun reeman refresh-crud <table> [--mode fields|full] [--prefix <dir>] [--parent <table>] [--pagination cursor|offset] [--template-tags flat|tags] [--translate] [--reinject-children]");
				process.exit(1);
			}

			if (pagination_method) { await update_pagination_strategy({ table, prefix, parent }, pagination_method); }

			const success = mode === "fields"
				? await refresh_crud_fields_only(table, prefix, parent, route_name, translate, template_tags)
				: await refresh_crud_for_table(table, prefix, parent, route_name, translate, template_tags);

			if (success && mode === "full" && values["reinject-children"]) {
				const { discover_routes_with_schema } = await import("./utils/route_scan");
				const routes = discover_routes_with_schema();
				const child_routes = routes.filter((r) => r.parent === table && r.prefix === prefix);
				for (const child of child_routes) {
					console.log(`\n  ${color("Re-injecting child:", GREEN)} ${child.table}`);
					await refresh_crud_for_table(child.table, child.prefix, child.parent, child.route_name, translate);
				}
			}

			process.exit(success ? 0 : 1);
		}

		case "run-sql-file": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: { force: { type: "boolean", default: false } },
				allowPositionals: true,
				strict: false,
			});
			const relative_path = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			if (!relative_path) {
				console.error("Usage: bun reeman run-sql-file <path> [--force]");
				process.exit(1);
			}
			const success = await execute_sql_file(relative_path, Boolean(values.force));
			process.exit(success ? 0 : 1);
		}

		case "json-to-sql": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					table: { type: "string" },
					slug: { type: "string" },
				},
				allowPositionals: true,
				strict: false,
			});
			const json_path = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			const table = values.table ? String(values.table) : undefined;
			if (!json_path || !table) {
				console.error("Usage: bun reeman json-to-sql <path> --table <name> [--slug <slug>]");
				process.exit(1);
			}
			try {
				const result = await convert_json_to_sql(json_path, table, {
					slug: values.slug ? String(values.slug) : undefined,
				});
				console.log(`${color("✓", GREEN)} Wrote ${result.mysql_path}`);
				console.log(`${color("✓", GREEN)} Wrote ${result.sqlite_path}`);
				console.log(`${result.row_count} row(s) seeded.`);
				await log_command(
					`bun reeman json-to-sql ${json_path} --table ${table}${values.slug ? ` --slug ${values.slug}` : ""}`,
					`Converted JSON to SQL: ${result.mysql_path}`
				);
				process.exit(0);
			} catch (err) {
				console.error(`${color("✗", RED)} ${err}`);
				process.exit(1);
			}
		}

		case "upload-image": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					folder: { type: "string", default: "" },
					format: { type: "string", default: "webp" },
					quality: { type: "string", default: "85" },
				},
				allowPositionals: true,
				strict: false,
			});
			const [table, id, column, source] = positionals.map((p) => String(p));
			if (!table || !id || !column || !source) {
				console.error("Usage: bun reeman upload-image <table> <id> <column> <path|url> [--folder <name>] [--format webp|jpeg|png|avif] [--quality <1-100>]");
				process.exit(1);
			}
			const s3_url = await upload_image({
				table,
				id,
				column,
				source,
				folder: String(values.folder ?? ""),
				format: String(values.format ?? "webp"),
				quality: Number(values.quality ?? 85),
			});
			process.exit(s3_url ? 0 : 1);
		}

		case "sync-translations": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: { translate: { type: "boolean", default: false } },
				allowPositionals: true,
				strict: false,
			});
			const translate = Boolean(values.translate);
			const scope_ns = positionals.map((p) => String(p));

			const { init_queue, is_queue_available, is_worker_alive } = await import("$queue/index");
			await init_queue();
			const queue_mode = is_queue_available() && (await is_worker_alive()) && translate;
			if (queue_mode) { console.log(`${color("Redis available", GREEN)} - translation jobs will be processed by queue worker.`); }

			if (translate) {
				await sync_all_namespaces();
			} else if (scope_ns.length > 0) {
				for (const namespace of scope_ns) { await sync_single_namespace(resolve_sync_namespace(namespace), false); }
			} else {
				const rows = (await db_cli`SELECT DISTINCT namespace FROM translations ORDER BY namespace`) as { namespace: string; }[];
				for (const row of rows) { await sync_single_namespace(row.namespace, false); }
			}

			const { notify_server_reload } = await import("$lib/server_notify");
			await notify_server_reload();
			console.log(`${color("✓", GREEN)} Translations synced (translate: ${translate})${queue_mode ? " - jobs enqueued, check /system/queues for progress" : ""}`);
			process.exit(0);
		}

		case "check-domain-compliance": {
			// run_check() reads --verbose straight off Bun.argv (the live process
			// argv), so bun reeman check-domain-compliance --verbose already works
			// without extra plumbing here.
			const { values } = parseArgs({
				args: rest,
				options: { fix: { type: "boolean", default: false } },
				strict: false,
			});
			const checker = await import("$root/scripts/check_domain_compliance");
			const exit_code = await checker.run_check();
			if (values.fix && checker.last_non_compliant.length > 0) {
				const sql = await checker.generate_alter_sql_with_constraints(checker.last_non_compliant);
				const filepath = await checker.write_alter_sql(sql);
				console.log(`${color("✓", GREEN)} ALTER TABLE SQL written to: ${filepath}`);
			}
			process.exit(exit_code);
		}

		case "prune-translations": {
			const cwd = process.cwd();
			const routes_dir = join(cwd, "routes");
			const public_dir = join(cwd, "public");
			const result = await find_orphaned_keys(db_cli, [routes_dir, public_dir], cwd);
			if (result.orphans.length === 0) {
				console.log(`${color("✓ No unused translation keys found.", GREEN)}`);
				process.exit(0);
			}
			const { path } = write_prune_sql(result.orphans, cwd);
			console.log(`${color("✓", GREEN)} Wrote ${result.orphans.length} DELETE statement(s) to: ${path}`);
			process.exit(0);
		}

		case "insert-translations": {
			const cwd = process.cwd();
			const routes_dir = join(cwd, "routes");
			const public_dir = join(cwd, "public");
			const components_dir = join(cwd, "components");
			const result = await find_missing_keys(db_cli, [routes_dir, public_dir, components_dir], cwd);
			if (result.missing.length === 0) {
				console.log(`${color("✓ No missing translation keys found.", GREEN)}`);
				process.exit(0);
			}
			const { path } = write_missing_sql(result.missing, cwd);
			console.log(`${color("✓", GREEN)} Wrote missing-key INSERT statements to: ${path}`);
			process.exit(0);
		}

		default:
			console.error(`${color(`Unknown reeman subcommand: "${subcommand}"`, RED)}`);
			console.error(`${color("Run `bun reeman --help` for usage, or `bun reeman` with no arguments for the interactive menu.", YELLOW)}`);
			process.exit(1);
	}
}
