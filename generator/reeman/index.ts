#!/usr/bin/env bun
/**
 * reeman entry point - interactive menu for the resource generator.
 *
 * Usage:  bun generator/reeman.ts
 *
 * Thin orchestrator that delegates to specialized flow modules.
 */

import { add_language } from "./add_language";
import { check_domain_compliance } from "./check_domain_compliance";
import { get_available_tables } from "./db";
import { run_bulk_crud_flow } from "./flows/bulk_crud_flow";
import { run_crud_flow } from "./flows/main_crud_flow";
import { run_nested_children_flow } from "./flows/nested_children_flow";
import { run_simple_page_flow } from "./flows/simple_page_flow";
import { run_simple_route_flow } from "./flows/simple_route_flow";
import { prune_unused_translations } from "./prune_translations";
import { quick_start } from "./quick_start";
import { refresh_crud } from "./refresh_crud";
import { remove_language } from "./remove_language";
import { remove_prefix_folder } from "./remove_prefix_route";
import { remove_route } from "./remove_route";
import { run_sql_file } from "./run_sql_file";
import { set_db_type } from "./set_db_type";
import { set_session_driver } from "./set_session_driver";
import { sync_missing_translations } from "./sync_missing_translations";
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
	// Always force a fresh introspection on startup so code changes
	// to the cache builder (e.g. FK detection, view SQL fetching) take
	// effect immediately without manual "Re-scan database schema".
	const ddl_cache = await load_ddl_cache({ force_refresh: true });
	console.log(`  ${DIM}DDL cache loaded: ${ddl_cache.tables.length} tables with FK detection${color("✓", GREEN)}`);

	while (true) {
		console.clear();
		console.log();
		const BANNER_W = 37;
		const h_line = "-".repeat(BANNER_W - 2);
		const text = "reepolee Resource Manager";
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
						cmd: "full",
						label: "Single table",
						description: "Full pipeline: schema introspection + CRUD generation",
					},
					{
						cmd: "schema",
						label: "Schema only",
						description: "Introspect DB and write schema files only",
					},
					{
						cmd: "crud",
						label: "CRUD only",
						description: "Generate CRUD from existing schema files",
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
						cmd: "add_language",
						label: "Add language",
						description: "Add a new language to the system (translation files, config, etc.)",
					},
					{
						cmd: "remove_language",
						label: "Remove language",
						description: "Remove a language and all its translations from the system",
					},
					{
						cmd: "prune_translations",
						label: "Prune unused translations",
						description: "Delete DB translation keys that no longer exist in any JSON source file",
					},
					{
						cmd: "sync_missing_translations",
						label: "Sync missing translations",
						description: "Add DB keys referenced in .ree templates but missing from the database",
					},
					{
						cmd: "rescan_ddl_cache",
						label: "Re-scan database schema",
						description: "Invalidate cache and re-introspect the full database (detect new tables, columns, FKs)",
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
				remove_prefix_folder: "Remove module/prefix folder",
				quick_start: "Quick Start",
				add_language: "Add language",
				remove_language: "Remove language",
				prune_translations: "Prune unused translations",
				sync_missing_translations: "Sync missing translations",
				rescan_ddl_cache: "Re-scan database schema",
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

			if (command === "remove_prefix_folder") {
				await remove_prefix_folder();
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

			if (command === "add_language") {
				await add_language();
				await press_enter();
				continue;
			}

			if (command === "remove_language") {
				await remove_language();
				await press_enter();
				continue;
			}

			if (command === "prune_translations") {
				await prune_unused_translations();
				continue;
			}

			if (command === "sync_missing_translations") {
				await sync_missing_translations();
				continue;
			}

			if (command === "rescan_ddl_cache") {
				const { invalidate_cache, load_ddl_cache } = await import("../ddl_cache");
				console.log(`  ${DIM}Invalidating DDL cache...`);
				invalidate_cache();
				const fresh = await load_ddl_cache({ force_refresh: true });
				console.log(`  ${color("✓", GREEN)} DDL cache re-scanned: ${fresh.tables.length} tables detected`);
				await press_enter();
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
			// CRUD commands (full, schema, crud, all) - delegated to main_crud_flow
			// -------------------------------------------------------------------
			if (["full", "schema", "crud", "all"].includes(command)) {
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
