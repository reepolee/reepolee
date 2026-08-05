#!/usr/bin/env bun
/**
 * reeman entry point - interactive menu for the resource generator.
 *
 * Usage:  bun generator/reeman.ts
 *
 * Thin orchestrator that delegates to specialized flow modules.
 */

import { add_locale } from "./add_locale";
import { add_locale_alias } from "./add_locale_alias";
import { add_translations } from "./add_translations";
import { db_cli } from "$config/db_cli";
import { run_add_module } from "./add_module";
import { check_domain_compliance } from "./check_domain_compliance";
import { get_available_tables } from "./db";
import { run_bulk_crud_flow } from "./flows/bulk_crud_flow";
import { run_json_to_sql } from "./json_to_sql";
import { run_crud_flow } from "./flows/main_crud_flow";
import { run_nested_children_flow } from "./flows/nested_children_flow";
import { run_simple_page_flow } from "./flows/simple_page_flow";
import { run_simple_route_flow } from "./flows/simple_route_flow";
import { prune_unused_translations } from "./prune_translations";
import { quick_start } from "./quick_start";
import { refresh_crud } from "./refresh_crud";
import { remove_locale } from "./remove_locale";
import { sync_locale_tables_command } from "./sync_locale_tables";
import { remove_examples_folder, remove_prefix_folder } from "./remove_prefix_route";
import { remove_route } from "./remove_route";
import { run_sql_file } from "./run_sql_file";
import { set_db_type } from "./set_db_type";
import { set_session_driver } from "./set_session_driver";
import { insert_translations } from "./insert_translations";
import { sync_all_namespaces, sync_single_namespace } from "../translate_namespace";
import { notify_server_reload } from "$lib/server_notify";
import { run_upload_image } from "./upload_image";
import { BOLD, color, confirm, CYAN, DIM, GREEN, header, InputCancelled, press_enter, show_grouped_menu, YELLOW } from "./ui";
import type { MenuGroup } from "./ui";

// ---------------------------------------------------------------------------
// Toggle: set to false to exit after each command instead of looping back to menu
// ---------------------------------------------------------------------------

const LOOP_MENU = false;

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

export async function main() {
	// Load the DB structure cache at startup - introspects the full database
	// once and reuses the result across all reeman interactions.
	const { load_ddl_cache } = await import("../ddl_cache");
	// Always force a fresh introspection on startup: schema changes are normally
	// made outside reeman, and code changes to the cache builder (e.g. FK
	// detection, view SQL fetching) must take effect immediately.
	const ddl_cache = await load_ddl_cache({ force_refresh: true });
	console.log(`  ${DIM}DDL cache loaded: ${ddl_cache.tables.length} tables with FK detection${color("✓", GREEN)}`);

	while (true) {
		console.clear();
		console.log();
		const BANNER_W = 37;
		const h_line = "-".repeat(BANNER_W - 2);
		const text = "Reeman Resource Manager";
		const pad = BANNER_W - 2 - text.length;
		const pad_l = Math.floor(pad / 2);
		const pad_r = pad - pad_l;
		console.log(`${color(`${BOLD}\u250C${h_line}\u2510`, CYAN)}`);
		console.log(`${color(`${BOLD}\u2502`, CYAN)}${color(" ".repeat(pad_l) + BOLD + text + " ".repeat(pad_r), GREEN)}${color(`${BOLD}\u2502`, CYAN)}`);
		console.log(`${color(`${BOLD}\u2514${h_line}\u2518`, CYAN)}`);

		// -------------------------------------------------------------------
		// Check if DB is already initialized (has users table)
		// -------------------------------------------------------------------
		const tables = await get_available_tables();
		const initialized = tables.includes("users");

		// -------------------------------------------------------------------
		// Step 1 – Choose command via grouped menu
		// -------------------------------------------------------------------
		header("What would you like to generate or change?");

		const menu_groups: MenuGroup[] = [
			{
				label: "CRUD Generators",
				description: "Full pipeline, schema, CRUD, bulk, nested",
				options: [
					{
						cmd: "crud",
						label: "Single table",
						description: "Full pipeline: schema introspection + CRUD generation",
					},
					{
						cmd: "schema",
						label: "Schema only",
						description: "Introspect DB and write schema files only",
					},
					{
						cmd: "bulk_crud",
						label: "Bulk CRUD",
						description: "Select multiple tables without CRUD + prefix, batch-generate all",
					},
					{
						cmd: "all",
						label: "All tables",
						description: "Full pipeline for every table in the database",
					},
					{
						cmd: "nested_children",
						label: "Nested children (auto-detect)",
						description: "Select a parent table, auto-discover FK children, batch-generate nested CRUD",
					},
				],
			},
			{
				label: "Simple Pages",
				description: "DB-backed or static pages",
				options: [
					{
						cmd: "simple_route",
						label: "Simple Table Page",
						description: "Create a simple route with DB query from template",
					},
					{
						cmd: "simple_page",
						label: "Simple Page",
						description: "Create a simple page that reads from a local data.json file (no DB needed)",
					},
				],
			},
			{
				label: "Database & Config",
				description: "Connection, SQL files, sessions",
				options: [
					{
						cmd: "set_db_type",
						label: "Set database type",
						description: "Switch between MySQL and SQLite, update .env CONNECTION_STRING",
					},
					{
						cmd: "run_sql_file",
						label: "Run SQL file",
						description: "Select and execute a .sql file (seed, init, etc.) against the database",
					},
					{
						cmd: "json_to_sql",
						label: "JSON to SQL table",
						description: "Convert a JSON file into a new table (paired MySQL/SQLite .sql files, seeded from the data)",
					},
					{
						cmd: "upload_image",
						label: "Upload image (disk/URL)",
						description: "Process a local file or remote URL and write the resulting URL into a table column",
					},
					{
						cmd: "set_session_driver",
						label: "Set session driver",
						description: "Switch session store between Redis and DB-auto",
					},
					{
						cmd: "quick_start",
						label: initialized ? "Reset the database" : `${color("★", YELLOW)} Quick Start`,
						description: initialized ? "Re-run full setup" : "Orchestrated setup: DB type → SQL file → session driver → admin user",
					},
				],
			},
			{
				label: "Tools & Maintenance",
				description: "Routes, refresh, translations, prune",
				options: [
					{
						cmd: "add_module",
						label: "Add module",
						description: "Register an installed module folder in the database and route registry",
					},
					{
						cmd: "remove_route",
						label: "Remove route",
						description: "Delete a registered route (folder, imports, nav) - skips system routes",
					},
					{
						cmd: "remove_prefix_folder",
						label: "Remove module/prefix folder",
						description: "Delete an entire prefixed route folder and all its sub-routes",
					},
					{
						cmd: "remove_examples",
						label: "Remove examples folder",
						description: "Delete the shipped demo routes (routes/examples/) from this project",
					},
					{
						cmd: "refresh_crud",
						label: "Refresh CRUD",
						description: "Regenerate CRUD for an existing route (overwrites files, keeps schema)",
					},
					{
						cmd: "check_domain_compliance",
						label: "Check domain compliance",
						description: "Introspect DB and flag columns not matching canonical domain types",
					},
					{
						cmd: "add_locale",
						label: "Add locale",
						description: "Add a new language to the system (translation files, config, etc.)",
					},
					{
						cmd: "add_locale_alias",
						label: "Add locale alias",
						description: "Serve one configured locale's UI strings from another locale",
					},
					{
						cmd: "add_translations",
						label: "Add translation",
						description: "Insert one explicit translation record into the database",
					},
					{
						cmd: "remove_locale",
						label: "Remove locale",
						description: "Remove a language and all its translations from the system",
					},
					{
						cmd: "sync_locale_tables",
						label: "Sync locale tables",
						description: "Create/alter/drop per-locale clone tables to match the base tables",
					},
					{
						cmd: "sync_translations",
						label: "Sync translations",
						description: "Sync translation structure across all languages, optionally using the configured AI provider",
					},
					{
						cmd: "prune_translations",
						label: "Prune unused translations",
						description: "Write DELETE statements for DB keys no longer referenced in .ree templates",
					},
					{
						cmd: "insert_translations",
						label: "Insert missing translations",
						description: "Write INSERT statements for keys referenced in .ree templates but missing from the database",
					},
				],
			},
		];

		let command = "";

		try {
			// When not initialized, offer Quick Start prominently
			if (!initialized) {
				const do_quick = await confirm(`${color("★", YELLOW)} Quick Start: set up database, session driver, and admin user?`, "y");
				if (do_quick) { command = "quick_start"; }
			}

			if (!command) { command = await show_grouped_menu("Select a category", menu_groups); }

			if (!command) {
				console.log(`  ${color("Exited.", YELLOW)}`);
				if (!LOOP_MENU) process.exit(0);
				return;
			}

			const cmd_labels: Record<string, string> = {
				simple_route: "Simple Table Page",
				simple_page: "Simple Page",
				full: "Full pipeline (schema + CRUD)",
				schema: "Schema only",
				crud: "CRUD only",
				nested_children: "Nested children (auto-detect)",
				bulk_crud: "Bulk CRUD",
				all: "All tables (full pipeline)",
				remove_route: "Remove route",
				add_module: "Add module",
				remove_prefix_folder: "Remove module/prefix folder",
				remove_examples: "Remove examples folder",
				quick_start: "Quick Start",
				add_locale: "Add locale",
				add_translations: "Add translation",
				remove_locale: "Remove locale",
				sync_locale_tables: "Sync locale tables",
				sync_translations: "Sync translations",
				prune_translations: "Prune unused translations",
				insert_translations: "Insert missing translations",
				json_to_sql: "JSON to SQL table",
			};
			console.log(`  ${color("✓", GREEN)} Selected: ${color(BOLD + (cmd_labels[command] ?? command), CYAN)}`);

			// -------------------------------------------------------------------
			// Route to standalone commands first
			// -------------------------------------------------------------------
			if (command === "remove_route") {
				await remove_route();
				await press_enter();
				continue;
			}

			if (command === "add_module") {
				await run_add_module();
				await press_enter();
				continue;
			}

			if (command === "remove_prefix_folder") {
				await remove_prefix_folder();
				await press_enter();
				continue;
			}

			if (command === "remove_examples") {
				await remove_examples_folder();
				await press_enter();
				continue;
			}

			if (command === "set_db_type") {
				await set_db_type();
				await press_enter();
				continue;
			}

			if (command === "run_sql_file") {
				await run_sql_file();
				await press_enter();
				continue;
			}

			if (command === "json_to_sql") {
				await run_json_to_sql();
				await press_enter();
				continue;
			}

			if (command === "upload_image") {
				await run_upload_image();
				await press_enter();
				continue;
			}

			if (command === "quick_start") {
				await quick_start();
				await press_enter();
				continue;
			}

			if (command === "set_session_driver") {
				await set_session_driver();
				await press_enter();
				continue;
			}

			if (command === "refresh_crud") {
				await refresh_crud();
				await press_enter();
				continue;
			}

			if (command === "check_domain_compliance") {
				await check_domain_compliance();
				await press_enter();
				continue;
			}

			if (command === "add_locale") {
				await add_locale();
				await press_enter();
				continue;
			}

			if (command === "add_locale_alias") {
				await add_locale_alias();
				await press_enter();
				continue;
			}

			if (command === "add_translations") {
				await add_translations();
				await press_enter();
				continue;
			}

			if (command === "remove_locale") {
				await remove_locale();
				await press_enter();
				continue;
			}

			if (command === "sync_locale_tables") {
				await sync_locale_tables_command();
				await press_enter();
				continue;
			}

			if (command === "sync_translations") {
				const translate = await confirm("Translate missing values using the configured AI provider?", "n");
				if (translate) {
					await sync_all_namespaces();
				} else {
					const rows = (await db_cli`SELECT DISTINCT namespace FROM translations ORDER BY namespace`) as { namespace: string; }[];
					for (const row of rows) { await sync_single_namespace(row.namespace, false); }
				}
				await notify_server_reload();
				console.log(`  ${color("✓", GREEN)} Translations synced (translate: ${translate})`);
				await press_enter();
				continue;
			}

			if (command === "prune_translations") {
				await prune_unused_translations();
				continue;
			}

			if (command === "insert_translations") {
				await insert_translations();
				continue;
			}

			// -------------------------------------------------------------------
			// Delegate to flow modules for complex interactive flows
			// -------------------------------------------------------------------

			if (command === "nested_children") {
				await run_nested_children_flow();
				await press_enter();
				continue;
			}

			if (command === "bulk_crud") {
				await run_bulk_crud_flow();
				await press_enter();
				continue;
			}

			if (command === "simple_route") {
				await run_simple_route_flow();
				await press_enter();
				continue;
			}

			if (command === "simple_page") {
				await run_simple_page_flow();
				await press_enter();
				continue;
			}

			// -------------------------------------------------------------------
			// CRUD commands (schema, crud, all) - delegated to main_crud_flow
			// -------------------------------------------------------------------
			if (["schema", "crud", "all"].includes(command)) {
				await run_crud_flow(command);
				await press_enter();
				continue;
			}

			await press_enter();
		} catch (error) {
			if (error instanceof InputCancelled) {
				console.log(`  ${color("Cancelled.", YELLOW)}`);
				await press_enter();
				continue;
			}
			throw error;
		}
	}
}
