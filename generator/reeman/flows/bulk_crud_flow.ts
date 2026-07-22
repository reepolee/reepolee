#!/usr/bin/env bun
/**
 * Bulk CRUD flow - select multiple tables without CRUD + prefix, batch-generate all.
 */

import { run_bulk_generator } from "../callers/resource_caller";
import { get_available_modules, get_available_tables } from "../db";
import {
	BOLD,
	color,
	confirm,
	CYAN,
	DIM,
	dim,
	GREEN,
	header,
	MAGENTA,
	multi_select,
	RED,
	select_from_list,
	YELLOW,
} from "../ui";
import { discover_existing_crud_tables } from "../utils/route_scan";

/**
 * Run the bulk CRUD interactive flow.
 * Returns true if flow completed, false if cancelled.
 */
export async function run_bulk_crud_flow(): Promise<boolean> {
	header("Bulk CRUD: Select tables without an existing CRUD folder");

	const all_db_tables = await get_available_tables();

	if (all_db_tables.length === 0) {
		console.log(`  ${color("No tables found in database.", RED)}`);
		console.log(`  ${dim("Returning to main menu...")}`);
		return false;
	}

	const existing_crud = discover_existing_crud_tables();
	const existing_names = new Set(existing_crud.map((t) => t.name));

	const available_tables = all_db_tables.filter((t) => !existing_names.has(t));

	if (available_tables.length === 0) {
		console.log(`  ${color("All database tables already have CRUD folders.", YELLOW)}`);
		console.log(`  ${dim("Use 'Refresh CRUD' to regenerate existing ones.")}`);
		console.log(`  ${dim("Returning to main menu...")}`);
		return false;
	}

	console.log(`  ${color(`${available_tables.length}`, GREEN)} of ${all_db_tables.length} tables available`);
	if (existing_crud.length > 0) { console.log(`  ${dim(`${existing_crud.length} already have CRUD (skipped)`)}`); }
	console.log();

	const table_items = available_tables.map((t) => ({ value: t, label: t }));
	const selected_tables = await multi_select("Select tables to generate (arrows + space + enter)", table_items);

	if (selected_tables.length === 0) {
		console.log(`  ${color("No tables selected.", YELLOW)}`);
		return false;
	}

	console.log(`  ${color("✓", GREEN)} Selected ${selected_tables.length} table(s): ${color(BOLD + selected_tables.join(", "), CYAN)}`);

	header("Select prefix (module)");

	const modules = await get_available_modules();

	const prefix_items = [
		{ value: "", label: "(none) - no prefix, place directly in /routes" },
		...modules.map((m) => ({ value: m.code, label: `${m.code} - ${m.name}` })),
	];
	const bulk_prefix = await select_from_list("Select prefix", prefix_items);

	if (bulk_prefix) {
		console.log(`  ${color("✓", GREEN)} Prefix: ${color(BOLD + bulk_prefix, CYAN)}`);
	} else {
		console.log(`  ${dim("  (no prefix)")}`);
	}

	// -------------------------------------------------------------------
	// Pagination method
	// -------------------------------------------------------------------
	header("Pagination method");
	const pagination_items = [
		{
			value: "offset",
			label: "Offset - LIMIT/OFFSET, numbered navigation, best for stable datasets",
		},
		{ value: "cursor", label: "Cursor - keyset-based, best for real-time/high-frequency tables" },
	];
	const bulk_pagination = await select_from_list("Select pagination method", pagination_items);

	if (bulk_pagination) {
		console.log(`  ${color("✓", GREEN)} Pagination: ${color(BOLD + bulk_pagination, CYAN)}`);
	} else {
		console.log(`  ${dim("  (default: offset)")}`);
	}

	// -------------------------------------------------------------------
	// Render strategy
	// -------------------------------------------------------------------
	header("Render strategy");
	const render_items = [
		{
			value: "load",
			label: "Load - synchronous, render full page after DB queries resolve (default)",
		},
		{
			value: "stream",
			label: "Stream - DPU streaming, send shell immediately then stream rows via Declarative Partial Updates",
		},
	];
	const bulk_render = (await select_from_list("Select render strategy", render_items)) as "stream" | "load" | "";

	if (bulk_render) {
		console.log(`  ${color("✓", GREEN)} Render: ${color(BOLD + bulk_render, CYAN)}`);
	} else {
		console.log(`  ${dim("  (default: load)")}`);
	}

	// -------------------------------------------------------------------
	// Sync translations flag
	// -------------------------------------------------------------------
	header("Translations");
	const sync_translate = await confirm("Run AI translation sync after generation? (uses OpenRouter - generates missing translations)", "n");

	if (sync_translate) {
		console.log(`  ${color("✓", GREEN)} Will sync translations after generation`);
	} else {
		console.log(`  ${dim("  (skipped)")}`);
	}

	// -------------------------------------------------------------------
	// Summary & confirmation
	// -------------------------------------------------------------------
	console.log(`\n${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color(`${BOLD}Bulk CRUD Summary`, MAGENTA)}`);
	console.log(`${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color("Tables:", BOLD)}     ${selected_tables.length}`);
	console.log(`  ${color("Names:", BOLD)}      ${selected_tables.join(", ")}`);
	console.log(`  ${color("Prefix:", BOLD)}      ${bulk_prefix || dim("(none)")}`);
	console.log(`  ${color("Pagination:", BOLD)}  ${bulk_pagination || "offset"}`);
	console.log(`  ${color("Render:", BOLD)}      ${bulk_render || "load"}`);
	console.log(`  ${color("Translate:", BOLD)}   ${sync_translate ? color("yes", GREEN) : dim("no")}`);
	console.log(`${color("-".repeat(50), CYAN)}\n`);

	const proceed = await confirm("Generate CRUD for all selected tables?", "y");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return false;
	}

	const pagination_method = (bulk_pagination || "offset") as "cursor" | "offset";
	const render_strategy = (bulk_render || "load") as "stream" | "load";
	// Translation sync (if enabled) is handled per-table inside the pipeline,
	// scoped to each generated table's namespace - see generator/crud/main.ts
	const result = await run_bulk_generator(
		selected_tables,
		bulk_prefix,
		sync_translate,
		pagination_method,
		render_strategy
	);

	console.log(`\n${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color(`${BOLD}Bulk CRUD Complete`, MAGENTA)}`);
	console.log(`  ${color("Success:", BOLD)} ${color(String(result.success), result.success > 0 ? GREEN : DIM)}`);
	if (result.fail > 0) { console.log(`  ${color("Failed:", BOLD)} ${color(String(result.fail), RED)}`); }
	console.log(`${color("-".repeat(50), CYAN)}`);

	return true;
}
