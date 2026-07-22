#!/usr/bin/env bun
/**
 * Refresh CRUD - regenerate CRUD files for an existing route (one that already has a schema folder).
 *
 * Uses direct function calls to generate_crud() instead of spawning subprocesses.
 */

import { join } from "node:path";

import { generate_crud } from "../crud/main";
import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, show_cli_tip, YELLOW } from "./ui";
import { discover_routes_with_schema } from "./utils/route_scan";

// ---------------------------------------------------------------------------
// CRUD refresh logic - direct function calls
// ---------------------------------------------------------------------------

async function refresh_crud_for_table(table: string, prefix: string, parent?: string, route_name?: string): Promise<boolean> {
	const do_translate = await confirm("Translate missing keys via AI (OpenRouter)?", "n");

	console.log(`\n${color("Running CRUD generation...", BOLD)}\n`);

	const success = await generate_crud(table, {
		force: true,
		translate: do_translate,
		prefix,
		parent_table: parent,
		route_name,
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

async function refresh_crud_fields_only(table: string, prefix: string, parent?: string, route_name?: string): Promise<boolean> {
	const do_translate = await confirm("Translate missing keys via AI (OpenRouter)?", "n");

	console.log(`\n${color("Running field refresh...", BOLD)}\n`);

	const success = await generate_crud(table, {
		refresh_fields: true,
		translate: do_translate,
		prefix,
		parent_table: parent,
		route_name,
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

	// Update pagination_strategy in schema file
	const schema_dir_parts = [process.cwd(), "routes"];
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
	} catch (err) {
		console.log(`  ${dim("  (could not read schema file - leaving as-is)")}`);
	}

	const mode_items = [
		{ value: "fields", label: "Refresh fields only (preserves CSS/layout customizations)" },
		{ value: "full", label: "Full refresh (overwrites all generated files)" },
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

		const success = await refresh_crud_fields_only(selected.table, selected.prefix, selected.parent, selected.route_name);

		if (!success) {
			console.log(`\n  ${color("Fields refresh failed. Exiting.", RED)}`);
			return;
		}

		console.log(`\n${color("-".repeat(50), CYAN)}`);
		console.log(`  ${color(`${BOLD}Done`, GREEN)} Fields refreshed for ${color(BOLD + selected.url, CYAN)}`);
		console.log(`${color("-".repeat(50), CYAN)}`);
		const fields_args = [selected.table];
		if (selected.prefix) fields_args.push("--prefix", selected.prefix);
		if (selected.parent) fields_args.push("--parent", selected.parent);
		fields_args.push("--refresh-fields");
		show_cli_tip(`bun generator/crud.ts ${fields_args.join(" ")}`);
	} else {
		const proceed = await confirm(`Regenerate CRUD for "${selected.url}"? Files will be overwritten.`, "y");

		if (!proceed) {
			console.log(`  ${color("Cancelled.", YELLOW)}`);
			return;
		}

		const success = await refresh_crud_for_table(selected.table, selected.prefix, selected.parent, selected.route_name);

		if (!success) {
			console.log(`\n  ${color("CRUD refresh failed. Exiting.", RED)}`);
			return;
		}

		console.log(`\n${color("-".repeat(50), CYAN)}`);
		console.log(`  ${color(`${BOLD}Done`, GREEN)} CRUD refreshed for ${color(BOLD + selected.url, CYAN)}`);
		console.log(`${color("-".repeat(50), CYAN)}`);
		const full_args = [selected.table];
		if (selected.prefix) full_args.push("--prefix", selected.prefix);
		if (selected.parent) full_args.push("--parent", selected.parent);
		full_args.push("--force");
		show_cli_tip(`bun generator/crud.ts ${full_args.join(" ")}`);

		const child_routes = routes.filter((r) => r.parent === selected.table && r.prefix === selected.prefix);
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
				for (const child of child_routes) {
					console.log(`\n  ${color("Re-injecting child:", BOLD)} ${color(BOLD + child.table, CYAN)}`);
					await refresh_crud_for_table(child.table, child.prefix, child.parent, child.route_name);
				}
			}
		}
	}
}
