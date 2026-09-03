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
import { join } from "node:path";
import { parseArgs } from "node:util";

import { delete_file_translation, read_all_translation_rows } from "$lib/translation_files";

import { add_locale_to_system } from "../add_locale";
import { add_locale_alias_to_system } from "../add_locale_alias";
import { activate_locales_in_system } from "../activate_locale";
import { install_locale_from_archive, list_archived_locales } from "../install_locale";
import { archive_translation_bundle, export_translation_bundle, migrate_legacy_translation_archive } from "../translation_bundle";
import { remove_locale_from_system } from "../remove_locale";
import { add_module } from "./add_module";
import { find_missing_keys, write_missing_translations } from "./insert_translations";
import { find_orphaned_keys } from "./prune_translations";
import { install_marketplace_archive } from "./install_archive";
import { pack_marketplace_folder } from "./pack_archive";
import { convert_json_to_sql, convert_spreadsheet_to_sql } from "./data_to_sql";
import { execute_sql_file } from "./run_sql_file";
import { generate_schema } from "../schema";
import { create_bread, create_localized_bread } from "../crud/create_bread";
import type { SyntheticSchema } from "../schema/types";
import { run_full_pipeline } from "./callers/resource_caller";
import { refresh_crud_fields_only } from "./refresh_crud";
import { sync_locale_tables_command } from "./sync_locale_tables";
import { remove_examples_folder, remove_prefix_folder } from "./remove_prefix_route";
import { remove_route } from "./remove_route";
import { set_db_type } from "./set_db_type";
import { set_repo } from "./set_repo";
import { set_session_driver } from "./set_session_driver";
import { sync_all_namespaces, sync_single_namespace } from "../translate_namespace";
import { upload_image } from "./upload_image";
import { color, confirm, GREEN, log_command, RED, YELLOW } from "./ui";
import { MAIN_APP } from "$config/paths";
import { load_fresh_ddl_cache, parse_crud_flags, resolve_sync_namespace, run_all_tables } from "./cli_crud";
import { print_help } from "./cli_help";

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const KNOWN_SUBCOMMANDS = new Set([
	"schema",
	"crud",
	"create_bread",
	"create_localized_bread",
	"bulk",
	"refresh-crud",
	"install",
	"pack",
	"add-module",
	"install-locale",
	"export-translation-bundle",
	"import-translation-bundle",
	"migrate-translation-archive",
	"add-locale",
	"add-locale-alias",
	"activate-locales",
	"remove-locale",
	"sync-locale-tables",
	"remove-route",
	"remove-prefix-folder",
	"remove-examples",
	"set-db-type",
	"set-session-driver",
	"set-repo",
	"run-sql-file",
	"json-to-sql",
	"spreadsheet-to-sql",
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
	const SELF_LOGGING = new Set(["remove-route", "remove-prefix-folder", "remove-examples", "set-db-type", "set-session-driver", "set-repo"]);
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
				grid_column_definitions: flags.grid_column_definitions,
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
					form_hints: flags.form_hints,
					form_details: flags.form_details,
					grid_columns: flags.grid_columns,
					grid_column_definitions: flags.grid_column_definitions,
				});
			process.exit(success ? 0 : 1);
		}

		case "create_bread":
		case "create_localized_bread": {
			const { values } = parseArgs({
				args: rest,
				options: { from: { type: "string" } },
				allowPositionals: true,
				strict: false,
			});
			const schema_path = values.from;
			if (typeof schema_path !== "string" || !schema_path) {
				console.error(`Usage: bun reeman ${subcommand} --from <schema.json> [--force] [--prefix <dir>] [--route-name <name>]`);
				process.exit(1);
			}
			const flags = parse_crud_flags(rest);
			try {
				const schema_text = await Bun.file(schema_path).text();
				const schema = JSON.parse(schema_text) as SyntheticSchema;
				const generator = subcommand === "create_localized_bread" ? create_localized_bread : create_bread;
				const success = await generator(schema, {
					prefix: flags.prefix,
					route_name: flags.route_name,
					pagination_strategy: flags.pagination_method,
					render_strategy: flags.render_strategy,
					template_tags: flags.template_tags,
					force: flags.force,
					interactive: true,
				});
				process.exit(success ? 0 : 1);
			} catch (error) {
				console.error("Failed to read synthetic schema:", error instanceof Error ? error.message : error);
				process.exit(1);
			}
		}

		case "bulk": {
			const flags = parse_crud_flags(rest);
			const tables = flags.positionals;
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

		case "install-locale": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: { activate: { type: "boolean", default: false } },
				allowPositionals: true,
				strict: false,
			});
			const locale_code = positionals[0] !== undefined ? String(positionals[0]) : "";
			if (!locale_code) {
				const available = await list_archived_locales();
				console.error("Usage: bun reeman install-locale <locale_code> [--activate]");
				if (available.length > 0) console.error(`   Archived locales: ${available.join(", ")}`);
				process.exit(1);
			}
			const success = await install_locale_from_archive(locale_code, { activate: Boolean(values.activate) });
			process.exit(success ? 0 : 1);
		}

		case "export-translation-bundle": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: { "target-locale": { type: "string" } },
				allowPositionals: true,
				strict: false,
			});
			const output_file = positionals[0] !== undefined ? String(positionals[0]) : "translation-bundle-en-us.json";
			const target_locale = values["target-locale"] ? String(values["target-locale"]) : null;
			const bundle = await export_translation_bundle(output_file, target_locale);
			console.log(`${color("✓", GREEN)} Exported ${Object.keys(bundle.files).length} English translation file(s) to ${output_file}.`);
			process.exit(0);
		}

		case "import-translation-bundle": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					install: { type: "boolean", default: false },
					activate: { type: "boolean", default: false },
				},
				allowPositionals: true,
				strict: false,
			});
			const bundle_file = positionals[0] !== undefined ? String(positionals[0]) : "";
			if (!bundle_file) {
				console.error("Usage: bun reeman import-translation-bundle <file.json> [--install] [--activate]");
				process.exit(1);
			}
			const bundle = await archive_translation_bundle(bundle_file);
			console.log(`${color("✓", GREEN)} Archived translated bundle as locales-archive/${bundle.target_locale}.json.`);
			if (values.install) {
				const success = await install_locale_from_archive(bundle.target_locale!, { activate: Boolean(values.activate) });
				process.exit(success ? 0 : 1);
			}
			process.exit(0);
		}

		case "migrate-translation-archive": {
			const written = await migrate_legacy_translation_archive();
			console.log(`${color("✓", GREEN)} Migrated ${written.length} archived locale bundle(s).`);
			process.exit(0);
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

		case "activate-locales": {
			const locale_codes = rest.filter((arg) => !arg.startsWith("--"));
			if (locale_codes.length === 0) {
				console.error("Usage: bun reeman activate-locales <locale_code...>");
				process.exit(1);
			}
			const result = await activate_locales_in_system(locale_codes);
			if (!result.ok) { console.error(`✗ ${result.error || "Failed to activate locale(s)."}`); }
			process.exit(result.ok ? 0 : 1);
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
				},
				allowPositionals: true,
				strict: false,
			});
			const url = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			if (!url) {
				console.error("Usage: bun reeman remove-route <url> [--force]");
				process.exit(1);
			}
			await remove_route(url, Boolean(values.force));
			process.exit(0);
		}

		case "remove-prefix-folder": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					force: { type: "boolean", default: false },
				},
				allowPositionals: true,
				strict: false,
			});
			const name = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			if (!name) {
				console.error("Usage: bun reeman remove-prefix-folder <name> [--force]");
				process.exit(1);
			}
			await remove_prefix_folder(name, Boolean(values.force));
			process.exit(0);
		}

		case "remove-examples": {
			const { values } = parseArgs({
				args: rest,
				options: {
					force: { type: "boolean", default: false },
				},
				allowPositionals: true,
				strict: false,
			});
			await remove_examples_folder(Boolean(values.force));
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

		case "set-repo": {
			const owner_repo = rest[0];
			if (!owner_repo) {
				console.error("Usage: bun reeman set-repo <owner/repo>");
				process.exit(1);
			}
			const result = await set_repo(owner_repo);
			process.exit(result ? 0 : 1);
		}

		case "refresh-crud": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					mode: { type: "string", default: "fields" },
					prefix: { type: "string", default: "" },
					parent: { type: "string", default: "" },
					"route-name": { type: "string", default: "" },
					translate: { type: "boolean", default: false },
				},
				allowPositionals: true,
				strict: false,
			});
			const table = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			const prefix = String(values.prefix ?? "");
			const parent = String(values.parent ?? "") || undefined;
			const route_name = String(values["route-name"] ?? "") || undefined;
			const translate = Boolean(values.translate);

			if (!table) {
				console.error("Usage: bun reeman refresh-crud <table> [--mode fields] [--prefix <dir>] [--parent <table>] [--translate]");
				process.exit(1);
			}
			if (values.mode !== "fields") {
				console.error("Full refresh is unavailable. Remove the route and generate it again for structural schema changes.");
				process.exit(1);
			}

			const success = await refresh_crud_fields_only(table, prefix, parent, route_name, translate);

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

		case "json-to-sql":
		case "spreadsheet-to-sql": {
			const { values, positionals } = parseArgs({
				args: rest,
				options: {
					table: { type: "string" },
					slug: { type: "string" },
					sheet: { type: "string" },
				},
				allowPositionals: true,
				strict: false,
			});
			const json_path = positionals[0] !== undefined ? String(positionals[0]) : undefined;
			const table = values.table ? String(values.table) : undefined;
			if (!json_path || !table) {
				console.error(`Usage: bun reeman ${subcommand} <path> --table <name> [--slug <slug>] [--sheet <name>]`);
				process.exit(1);
			}
			try {
				const slug = values.slug ? String(values.slug) : undefined;
				const result = subcommand === "spreadsheet-to-sql"
					? await convert_spreadsheet_to_sql(json_path, table, { slug, sheet: values.sheet ? String(values.sheet) : undefined })
					: await convert_json_to_sql(json_path, table, { slug });
				console.log(`${color("✓", GREEN)} Wrote ${result.mysql_path}`);
				console.log(`${color("✓", GREEN)} Wrote ${result.sqlite_path}`);
				console.log(`${result.row_count} row(s) seeded.`);
				await log_command(
					`bun reeman ${subcommand} ${json_path} --table ${table}${values.slug ? ` --slug ${values.slug}` : ""}${values.sheet ? ` --sheet "${values.sheet}"` : ""}`,
					`Converted import to SQL: ${result.mysql_path}`
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
			if (queue_mode) { console.log(`${color("Queue worker available", GREEN)} - translation jobs will be processed by queue worker.`); }

			if (translate) {
				await sync_all_namespaces();
			} else if (scope_ns.length > 0) {
				for (const namespace of scope_ns) { await sync_single_namespace(resolve_sync_namespace(namespace), false); }
			} else {
				const rows = await read_all_translation_rows();
				const namespaces = [...new Set(rows.map((row) => row.namespace))].sort();
				for (const namespace of namespaces) { await sync_single_namespace(namespace, false); }
			}

			const { notify_server_reload } = await import("$lib/server_notify");
			await notify_server_reload();
			console.log(`${color("✓", GREEN)} Translations synced (translate: ${translate})${queue_mode ? " - jobs enqueued, check /queues for progress" : ""}`);
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
			const routes_dir = join(cwd, MAIN_APP);
			const public_dir = join(cwd, "public");
			const result = await find_orphaned_keys([routes_dir, public_dir], cwd);
			if (result.orphans.length === 0) {
				console.log(`${color("✓ No unused translation keys found.", GREEN)}`);
				process.exit(0);
			}
			const rows = await read_all_translation_rows(cwd);
			let deleted = 0;
			for (const orphan of result.orphans) {
				const matching_rows = rows.filter((row) => row.namespace === orphan.namespace && row.key_path === orphan.key_path);
				for (const row of matching_rows) {
					if (await delete_file_translation(row.locale, row.namespace, row.key_path, cwd)) deleted++;
				}
			}
			console.log(`${color("✓", GREEN)} Deleted ${deleted} unused locale value(s).`);
			process.exit(0);
		}

		case "insert-translations": {
			const cwd = process.cwd();
			const routes_dir = join(cwd, MAIN_APP);
			const public_dir = join(cwd, "public");
			const components_dir = join(cwd, "components");
			const result = await find_missing_keys([routes_dir, public_dir, components_dir], cwd);
			if (result.missing.length === 0) {
				console.log(`${color("✓ No missing translation keys found.", GREEN)}`);
				process.exit(0);
			}
			const written = await write_missing_translations(result.missing, cwd);
			console.log(`${color("✓", GREEN)} Added ${written} missing locale value(s).`);
			process.exit(0);
		}

		default:
			console.error(`${color(`Unknown reeman subcommand: "${subcommand}"`, RED)}`);
			console.error(`${color("Run `bun reeman --help` for usage, or `bun reeman` with no arguments for the interactive menu.", YELLOW)}`);
			process.exit(1);
	}
}
