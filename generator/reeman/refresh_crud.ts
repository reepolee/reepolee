#!/usr/bin/env bun
/**
 * Refresh CRUD - regenerate CRUD files for an existing route (one that already has a schema folder).
 *
 * Uses direct function calls to generate_crud() instead of spawning subprocesses.
 */

import { join } from "node:path";

import { generate_crud } from "../crud/main";
import { load_ddl_cache } from "../ddl_cache";
import { generate_schema } from "../schema";
import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, show_cli_tip, YELLOW } from "./ui";
import { discover_routes_with_schema } from "./utils/route_scan";
import { MAIN_APP } from "$config/paths";
import type { GridColumnDefinition } from "$generator/schema/types";

export interface RefreshCrudOptions {
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	grid_columns?: string[];
	grid_column_definitions?: GridColumnDefinition[];
}

// ---------------------------------------------------------------------------
// CRUD refresh logic - direct function calls
// ---------------------------------------------------------------------------

/**
 * Re-read the live DB schema before a full refresh.
 *
 * A full refresh is run precisely because the DB changed, so both caching layers
 * have to be defeated: the DDL cache file is re-introspected (it is otherwise
 * served from disk for its whole TTL), and table.generated.ts is rewritten from
 * the fresh cache. Without this, generate_crud imports a stale table.ts and
 * faithfully regenerates CRUD against columns the DB no longer has.
 *
 * table.ts itself is not rewritten wholesale. write_table_file() merges new
 * columns and applies only settings explicitly supplied by the caller.
 */
async function regenerate_schema_from_db(table: string, prefix: string, parent?: string, route_name?: string, options: RefreshCrudOptions = {}): Promise<boolean> {
	console.log(`\n${color("Re-reading DB schema...", BOLD)}\n`);

	await load_ddl_cache({ force_refresh: true });

	const schema_ok = await generate_schema(table, {
		prefix,
		parent_table: parent,
		route_name,
		pagination_strategy: options.pagination_strategy,
		render_strategy: options.render_strategy,
		grid_columns: options.grid_columns,
		grid_column_definitions: options.grid_column_definitions,
	});

	if (!schema_ok) { console.log(`  ${color("✗ Schema regeneration failed", RED)}`); }
	return schema_ok;
}

export async function refresh_crud_for_table(table: string, prefix: string, parent?: string, route_name?: string, translate: boolean = false, template_tags?: "flat" | "tags", options: RefreshCrudOptions = {}): Promise<boolean> {
	const schema_ok = await regenerate_schema_from_db(table, prefix, parent, route_name, options);
	if (!schema_ok) return false;

	console.log(`\n${color("Running CRUD generation...", BOLD)}\n`);

	const success = await generate_crud(table, {
		force: true,
		translate,
		prefix,
		parent_table: parent,
		route_name,
		template_tags,
		pagination_strategy: options.pagination_strategy,
		render_strategy: options.render_strategy,
	});

	console.log();
	if (success) {
		console.log(`${color("✓ CRUD refresh complete", GREEN)}`);
		return true;
	} else {
		console.log(`${color("✗ CRUD refresh failed", RED)}`);
		return false;
	}
}

export async function refresh_crud_fields_only(table: string, prefix: string, parent?: string, route_name?: string, translate: boolean = false, template_tags?: "flat" | "tags", options: RefreshCrudOptions = {}): Promise<boolean> {
	console.log(`\n${color("Running field refresh...", BOLD)}\n`);
	await update_refresh_settings({ table, prefix, parent, route_name }, { ...options, template_tags });

	const success = await generate_crud(table, {
		refresh_fields: true,
		translate,
		prefix,
		parent_table: parent,
		route_name,
		template_tags,
		pagination_strategy: options.pagination_strategy,
		render_strategy: options.render_strategy,
	});

	console.log();
	if (success) {
		console.log(`${color("✓ Fields refresh complete", GREEN)}`);
		return true;
	} else {
		console.log(`${color("✗ Fields refresh failed", RED)}`);
		return false;
	}
}

async function update_refresh_settings(selected: { table: string; prefix: string; parent?: string; route_name?: string; }, options: RefreshCrudOptions & { template_tags?: "flat" | "tags"; }): Promise<void> {
	const route_directory = selected.route_name || selected.table;
	const schema_dir_parts = [process.cwd(), MAIN_APP];
	if (selected.prefix) schema_dir_parts.push(selected.prefix);
	if (selected.parent) schema_dir_parts.push(selected.parent);
	schema_dir_parts.push(route_directory, "schema", "table.ts");
	const schema_ts_path = join(...schema_dir_parts);
	const { update_table_file_settings } = await import("$generator/schema/write_table");
	await update_table_file_settings(schema_ts_path, options);
}

/**
 * Update the pagination_strategy literal in a route's schema/table.ts file.
 * Used by both the interactive flow and the non-interactive CLI subcommand.
 */
export async function update_pagination_strategy(selected: { table: string; prefix: string; parent?: string; }, pagination_method: "cursor" | "offset"): Promise<void> {
	const schema_dir_parts = [process.cwd(), MAIN_APP];
	if (selected.parent) {
		if (selected.prefix) schema_dir_parts.push(selected.prefix);
		schema_dir_parts.push(selected.parent, selected.table);
	} else if (selected.prefix) {
		schema_dir_parts.push(selected.prefix, selected.table);
	} else {
		schema_dir_parts.push(selected.table);
	}
	schema_dir_parts.push("schema", "table.ts");
	const schema_ts_path = join(...schema_dir_parts);

	try {
		let schema_content = await Bun.file(schema_ts_path).text();
		const old_pattern = `const pagination_strategy: "cursor" | "offset" = "`;
		const old_start = schema_content.indexOf(old_pattern);
		if (old_start >= 0) {
			const line_end = schema_content.indexOf("\n", old_start);
			const new_line = `const pagination_strategy: "cursor" | "offset" = "${pagination_method}";`;
			schema_content = schema_content.slice(0, old_start) + new_line + schema_content.slice(line_end);
			await Bun.write(schema_ts_path, schema_content);
			console.log(`  ${color("✓", GREEN)} Updated schema: ${color(BOLD + pagination_method, CYAN)}`);
		} else {
			console.log(`  ${dim("  (pagination_strategy not found in schema - leaving as-is)")}`);
		}
	} catch {
		console.log(`  ${dim("  (could not read schema file - leaving as-is)")}`);
	}
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function refresh_crud(): Promise<void> {
	header("Scanning routes with schema folders");

	const routes = discover_routes_with_schema();

	if (routes.length === 0) {
		console.log(`  ${color("No routes with schema folders found.", YELLOW)}`);
		console.log(`  ${dim("Generate schemas first via 'Schema only' or 'Single table' options.")}`);
		return;
	}

	console.log(`  ${color(`Found ${routes.length} route(s) with existing schemas`, GREEN)}\n`);

	const items = routes.map((r) => {
		const parts = [r.prefix ? `prefix: ${r.prefix}` : "no prefix"];
		if (r.parent) parts.push(`child of ${r.parent}`);
		const loc = r.route_name ? `${r.route_name} → table: ${r.table}` : `table: ${r.table}`;
		const suffix = `  (${parts.join(", ")})`;
		return { value: r.url, label: `${r.url}${suffix}  - ${loc}` };
	});

	const selected_url = await select_from_list("Select route to refresh", items);
	const selected = routes.find((r) => r.url === selected_url);

	if (!selected) {
		console.log(`  ${color("Invalid choice.", RED)}`);
		return;
	}

	console.log(`\n  ${color("✓", GREEN)} Selected: ${color(BOLD + selected.url, CYAN)}`);
	if (selected.route_name) {
		console.log(`    ${color("Route:", BOLD)}  ${selected.route_name}`);
		console.log(`    ${color("Table:", BOLD)}  ${selected.table}`);
	} else {
		console.log(`    ${color("Table:", BOLD)}  ${selected.table}`);
	}
	if (selected.parent) { console.log(`    ${color("Parent:", BOLD)}  ${selected.parent}`); }
	console.log(`    ${color("Prefix:", BOLD)}  ${selected.prefix || dim("(none)")}`);

	header("Pagination method");
	const pagination_items = [
		{
			value: "offset",
			label: "Offset - LIMIT/OFFSET, numbered navigation, best for stable datasets",
		},
		{ value: "cursor", label: "Cursor - keyset-based, best for real-time/high-frequency tables" },
	];
	const refresh_pagination = await select_from_list("Select pagination method", pagination_items);
	const pagination_method = (refresh_pagination || "offset") as "cursor" | "offset";
	console.log(`  ${color("✓", GREEN)} Pagination: ${color(BOLD + pagination_method, CYAN)}`);

	await update_pagination_strategy(selected, pagination_method);

	header("Form field rendering");
	const template_tags_items = [
		{ value: "", label: "(leave as-is) - keep the entity's current setting" },
		{
			value: "flat",
			label: "Flat - raw <input>/<select> markup per field, generated inline",
		},
		{
			value: "tags",
			label: "Tags - single ReeTag component per field (e.g. <input-text>), simpler once layout is stable",
		},
	];
	const refresh_template_tags_raw = await select_from_list("Select form field rendering mode", template_tags_items);
	const template_tags = (refresh_template_tags_raw || undefined) as "flat" | "tags" | undefined;
	console.log(`  ${color("✓", GREEN)} Template tags: ${color(BOLD + (template_tags ?? "unchanged"), CYAN)}`);

	const mode_items = [
		{ value: "fields", label: "Refresh fields only (preserves CSS/layout customizations)" },
		{ value: "full", label: "Full refresh (re-reads DB schema; overwrites generated files; merges new DB columns into table.ts)" },
	];

	const mode = await select_from_list("Refresh mode", mode_items);

	if (mode !== "fields" && mode !== "full") {
		console.log(`  ${color("Invalid choice.", RED)}`);
		return;
	}

	if (mode === "fields") {
		const proceed = await confirm(`Refresh fields for "${selected.url}"? Only .ree field sections will be updated.`, "y");

		if (!proceed) {
			console.log(`  ${color("Cancelled.", YELLOW)}`);
			return;
		}

		const do_translate = await confirm("Translate missing keys via AI (OpenRouter)?", "n");
		const success = await refresh_crud_fields_only(selected.table, selected.prefix, selected.parent, selected.route_name, do_translate, template_tags);

		if (!success) {
			console.log(`\n  ${color("Fields refresh failed. Exiting.", RED)}`);
			return;
		}

		console.log(`\n${color("-".repeat(50), CYAN)}`);
		console.log(`  ${color(`${BOLD}Done`, GREEN)} Fields refreshed for ${color(BOLD + selected.url, CYAN)}`);
		console.log(`${color("-".repeat(50), CYAN)}`);
		const cli_args = [selected.table, "--mode", "fields", "--pagination", pagination_method];
		if (template_tags) cli_args.push("--template-tags", template_tags);
		if (selected.prefix) cli_args.push("--prefix", selected.prefix);
		if (selected.parent) cli_args.push("--parent", selected.parent);
		if (do_translate) cli_args.push("--translate");
		await show_cli_tip(`bun reeman refresh-crud ${cli_args.join(" ")}`, `Refreshed fields: ${selected.table}`);
	} else {
		const proceed = await confirm(`Regenerate CRUD for "${selected.url}"? Files will be overwritten.`, "y");

		if (!proceed) {
			console.log(`  ${color("Cancelled.", YELLOW)}`);
			return;
		}

		const do_translate = await confirm("Translate missing keys via AI (OpenRouter)?", "n");
		const success = await refresh_crud_for_table(selected.table, selected.prefix, selected.parent, selected.route_name, do_translate, template_tags);

		if (!success) {
			console.log(`\n  ${color("CRUD refresh failed. Exiting.", RED)}`);
			return;
		}

		console.log(`\n${color("-".repeat(50), CYAN)}`);
		console.log(`  ${color(`${BOLD}Done`, GREEN)} CRUD refreshed for ${color(BOLD + selected.url, CYAN)}`);
		console.log(`${color("-".repeat(50), CYAN)}`);
		const cli_args = [selected.table, "--mode", "full", "--pagination", pagination_method];
		if (template_tags) cli_args.push("--template-tags", template_tags);
		if (selected.prefix) cli_args.push("--prefix", selected.prefix);
		if (selected.parent) cli_args.push("--parent", selected.parent);
		if (do_translate) cli_args.push("--translate");

		const child_routes = routes.filter((r) => r.parent === selected.table && r.prefix === selected.prefix);
		let reinject = false;
		if (child_routes.length > 0) {
			console.log(`\n  ${color(`This parent has ${child_routes.length} child route(s):`, YELLOW)}`);
			for (const child of child_routes) {
				console.log(`    ${color(BOLD + child.url, CYAN)}`);
			}
			const re_inject = await confirm(
				"Re-apply child integration to parent files? This re-generates child CRUD to restore the inline child section, child_records fetch, and child query functions.",
				"y"
			);
			if (re_inject) {
				reinject = true;
				for (const child of child_routes) {
					console.log(`\n  ${color("Re-injecting child:", BOLD)} ${color(BOLD + child.table, CYAN)}`);
					await refresh_crud_for_table(child.table, child.prefix, child.parent, child.route_name, do_translate);
				}
			}
		}
		if (reinject) cli_args.push("--reinject-children");
		await show_cli_tip(`bun reeman refresh-crud ${cli_args.join(" ")}`, `Refreshed CRUD: ${selected.table}`);
	}
}
