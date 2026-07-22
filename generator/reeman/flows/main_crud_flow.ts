#!/usr/bin/env bun
/**
 * CRUD flow - interactive parameter collection for full/schema/crud/all commands.
 * Extracted from index.ts to keep the orchestrator thin.
 */

import { get_available_modules, get_available_tables } from "../db";
import { run_generator, show_summary } from "../generator_runner";
import type { GeneratorParams } from "../types";
import { ask, BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, YELLOW } from "../ui";

/**
 * Collect CRUD params and run the generator interactively.
 * Returns true if execution completed, false if cancelled.
 */
export async function run_crud_flow(command: string): Promise<boolean> {
	let table = "";
	let prefix = "";
	let route_name = "";

	// -------------------------------------------------------------------
	// Table selection (for full/schema/crud - not all)
	// -------------------------------------------------------------------
	if (["full", "schema", "crud"].includes(command)) {
		header("Which table?");

		const tables = await get_available_tables();
		if (tables.length === 0) {
			console.log(`  ${dim("Found 0 tables in database. Please type the name.")}\n`);
			table = await ask("Table name");
			if (!table) {
				console.log(`  ${color("No table specified.", RED)}`);
				return false;
			}
		} else {
			const table_items = tables.map((t) => ({ value: t, label: t }));
			table = await select_from_list("Select table", table_items);
			if (!table) {
				console.log(`  ${color("No table specified. Returning to menu.", YELLOW)}`);
				return false;
			}
		}

		console.log(`  ${color("✓", GREEN)} Table: ${color(BOLD + table, CYAN)}`);
	}

	// -------------------------------------------------------------------
	// Prefix selection (for all CRUD commands)
	// -------------------------------------------------------------------
	if (["full", "schema", "crud", "all"].includes(command)) {
		header("Route prefix");

		const modules = await get_available_modules();
		const prefix_items = [
			{ value: "", label: "(none) - no prefix, place directly in /routes" },
			...modules.map((m) => ({ value: m.code, label: `${m.code} - ${m.name}` })),
		];
		prefix = await select_from_list("Select prefix", prefix_items);

		if (prefix) {
			console.log(`  ${color("✓", GREEN)} Prefix: ${color(BOLD + prefix, CYAN)}`);
		} else {
			console.log(`  ${dim("  (no prefix)")}`);
		}
	}

	// -------------------------------------------------------------------
	// Route name (optional feature name that replaces table name in URL)
	// -------------------------------------------------------------------
	if (["full", "schema", "crud"].includes(command)) {
		header("Route name (optional)");
		console.log(`  ${dim("If specified, replaces the table name in the URL path.")}`);
		console.log(`  ${dim("Useful when you want a different URL (e.g. 'my-users') for the same DB table.")}`);
		console.log(`  ${dim("Leave empty to use the table name as the route name.")}`);
		route_name = await ask("Route name (Enter for default)");
		if (route_name) {
			console.log(`  ${color("✓", GREEN)} Route name: ${color(BOLD + route_name, CYAN)}`);
		} else {
			console.log(`  ${dim("  (using table name)")}`);
		}
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
	const pagination_method = (await select_from_list("Select pagination method", pagination_items)) as "cursor" | "offset";

	console.log(`  ${color("✓", GREEN)} Pagination: ${color(BOLD + pagination_method, CYAN)}`);

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
	const render_strategy = (await select_from_list("Select render strategy", render_items)) as "stream" | "load";

	console.log(`  ${color("✓", GREEN)} Render: ${color(BOLD + render_strategy, CYAN)}`);

	// -------------------------------------------------------------------
	// Force flag
	// -------------------------------------------------------------------
	header("Overwrite existing files?");
	const force = await confirm("Overwrite existing generated files without prompting?", "n");

	if (force) {
		console.log(`  ${color("✓", GREEN)} Force: ${color("yes", YELLOW)} \u2014 existing files will be overwritten`);
	} else {
		console.log(`  ${dim("  (will prompt before overwriting)")}`);
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
	const params: GeneratorParams = {
		command,
		table,
		prefix,
		route_name: route_name || undefined,
		force,
		sync_translate,
		pagination_method,
		render_strategy,
	};

	header("Ready to go");
	show_summary(params);

	const proceed = await confirm("Run the generator now?", "y");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return false;
	}

	// -------------------------------------------------------------------
	// Execute (translation sync, if enabled, is handled inside the pipeline
	// scoped to the generated table's namespace - see generator/crud/main.ts)
	// -------------------------------------------------------------------
	await run_generator(params);

	return true;
}
