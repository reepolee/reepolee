#!/usr/bin/env bun
/**
 * Nested children flow - select a parent table, auto-discover FK children, batch-generate nested CRUD.
 */

import { run_bulk_nested_generator, run_full_pipeline } from "../callers/resource_caller";
import { get_available_modules, get_available_tables, get_child_tables } from "../db";
import { build_full_pipeline_cli_tip } from "../generator_runner";
import {
	BOLD,
	color,
	confirm,
	CYAN,
	dim,
	GREEN,
	header,
	MAGENTA,
	multi_select,
	RED,
	select_from_list,
	show_cli_tips,
	YELLOW,
} from "../ui";

/**
 * Run the nested children interactive flow.
 * Returns true if flow completed, false if cancelled.
 */
export async function run_nested_children_flow(): Promise<boolean> {
	header("Select parent table");

	const all_tables = await get_available_tables();

	if (all_tables.length === 0) {
		console.log(`  ${color("No tables found in database.", RED)}`);
		console.log(`  ${dim("Returning to main menu...")}`);
		return false;
	}

	const parent_items = all_tables.map((t) => ({ value: t, label: t }));
	const parent_table = await select_from_list("Select parent table", parent_items);

	if (!parent_table) {
		console.log(`  ${color("No parent selected.", YELLOW)}`);
		return false;
	}

	console.log(`  ${color("✓", GREEN)} Parent: ${color(BOLD + parent_table, CYAN)}`);

	header("Discovering child tables");
	console.log(`  ${dim("Querying DB for FK references to parent...")}`);

	const children = await get_child_tables(parent_table);

	if (children.length === 0) {
		console.log(`  ${color(`No tables have foreign keys referencing "${parent_table}".`, YELLOW)}`);
		return false;
	}

	console.log(`  ${color(`Found ${children.length} child table(s):`, GREEN)}`);
	for (const child of children) {
		console.log(`    ${color(BOLD + child.table, CYAN)} (via FK: ${child.fk_column})`);
	}
	console.log();

	const child_table_names = children.map((c) => c.table);

	header("Route prefix");

	const modules = await get_available_modules();
	const prefix_items = [
		{ value: "", label: "(none) - no prefix, place directly in /routes" },
		...modules.map((m) => ({ value: m.code, label: `${m.code} - ${m.name}` })),
	];
	const nested_prefix = await select_from_list("Select prefix", prefix_items);

	if (nested_prefix) {
		console.log(`  ${color("✓", GREEN)} Prefix: ${color(BOLD + nested_prefix, CYAN)}`);
	} else {
		console.log(`  ${dim("  (no prefix)")}`);
	}

	header("Pagination method");
	const pagination_items = [
		{
			value: "offset",
			label: "Offset - LIMIT/OFFSET, numbered navigation, best for stable datasets",
		},
		{ value: "cursor", label: "Cursor - keyset-based, best for real-time/high-frequency tables" },
	];
	const nested_pagination = await select_from_list("Select pagination method", pagination_items);

	if (nested_pagination) {
		console.log(`  ${color("✓", GREEN)} Pagination: ${color(BOLD + nested_pagination, CYAN)}`);
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
	const nested_render = (await select_from_list("Select render strategy", render_items)) as "stream" | "load" | "";

	if (nested_render) {
		console.log(`  ${color("✓", GREEN)} Render: ${color(BOLD + nested_render, CYAN)}`);
	} else {
		console.log(`  ${dim("  (default: load)")}`);
	}

	const nested_translate = await confirm("Translate missing keys via AI (OpenRouter)?", "n");

	// Generate parent CRUD first (so children can reference it)
	console.log(`\n${color("Step 1: Generating parent CRUD", BOLD)}`);
	console.log(`  ${dim("Running full pipeline for parent...")}\n`);

	const pagination_method = (nested_pagination || "offset") as "cursor" | "offset";
	const render_strategy = (nested_render || "load") as "stream" | "load";
	const parent_ok = await run_full_pipeline(parent_table, { prefix: nested_prefix, pagination_method, render_strategy });

	if (!parent_ok) {
		console.log(`  ${color("✗ Parent CRUD generation failed - nested children cannot proceed.", RED)}`);
		return false;
	}
	console.log(`  ${color("✓ Parent CRUD ready.", GREEN)}\n`);

	// Summary
	console.log(`\n${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color(`${BOLD}Bulk Nested CRUD Summary`, MAGENTA)}`);
	console.log(`${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color("Parent:", BOLD)}     ${parent_table}`);
	console.log(`  ${color("Children:", BOLD)}   ${child_table_names.length}`);
	console.log(`  ${color("Names:", BOLD)}      ${child_table_names.join(", ")}`);
	console.log(`  ${color("Prefix:", BOLD)}      ${nested_prefix || dim("(none)")}`);
	console.log(`  ${color("Pagination:", BOLD)}  ${nested_pagination || "offset"}`);
	console.log(`  ${color("Render:", BOLD)}      ${nested_render || "load"}`);
	console.log(`${color("-".repeat(50), CYAN)}\n`);

	// Multi-select children
	const child_items = children.map((c) => ({
		value: c.table,
		label: `${c.table} (FK: ${c.fk_column})`,
	}));
	const selected_children = await multi_select("Select children to generate nested CRUD for (arrows + space + enter)", child_items);

	if (selected_children.length === 0) {
		console.log(`  ${color("No children selected. Cancelled.", YELLOW)}`);
		return false;
	}

	console.log(`  ${color("✓", GREEN)} Selected ${selected_children.length} child(ren): ${color(BOLD + selected_children.join(", "), CYAN)}`);

	// Translation sync (if enabled) is handled per-table inside the pipeline,
	// scoped to each generated table's namespace - see generator/crud/main.ts
	await run_bulk_nested_generator(
		selected_children,
		parent_table,
		nested_prefix,
		pagination_method,
		render_strategy,
		nested_translate
	);

	const tip_lines = [
		build_full_pipeline_cli_tip({ table: parent_table, prefix: nested_prefix, pagination_method, render_strategy }),
		...selected_children.map((table) => build_full_pipeline_cli_tip({
			table,
			prefix: nested_prefix,
			parent_table,
			pagination_method,
			render_strategy,
			sync_translate: nested_translate,
		})),
	];
	show_cli_tips(tip_lines);

	return true;
}
