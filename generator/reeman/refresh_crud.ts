#!/usr/bin/env bun
/** Refresh generated field sections for an existing CRUD route. */

import { generate_crud } from "../crud/main";
import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, show_cli_tip, YELLOW } from "./ui";
import { discover_routes_with_schema } from "./utils/route_scan";

export async function refresh_crud_fields_only(
	table: string,
	prefix: string,
	parent?: string,
	route_name?: string,
	translate: boolean = false,
): Promise<boolean> {
	console.log(`\n${color("Running field refresh...", BOLD)}\n`);
	const success = await generate_crud(table, {
		refresh_fields: true,
		translate,
		prefix,
		parent_table: parent,
		route_name,
	});
	console.log();
	if (success) {
		console.log(`${color("✓ Fields refresh complete", GREEN)}`);
		return true;
	}
	console.log(`${color("✗ Fields refresh failed", RED)}`);
	return false;
}

export async function refresh_crud(): Promise<void> {
	header("Scanning configured CRUD routes");
	const routes = discover_routes_with_schema();
	if (routes.length === 0) {
		console.log(`  ${color("No configured CRUD routes found.", YELLOW)}`);
		console.log(`  ${dim("Generate a CRUD route first.")}`);
		return;
	}

	console.log(`  ${color(`Found ${routes.length} configured route(s)`, GREEN)}\n`);
	const items = routes.map((route) => {
		const parts = [route.prefix ? `prefix: ${route.prefix}` : "no prefix"];
		if (route.parent) parts.push(`child of ${route.parent}`);
		const location = route.route_name ? `${route.route_name} -> table: ${route.table}` : `table: ${route.table}`;
		const suffix = `  (${parts.join(", ")})`;
		return { value: route.url, label: `${route.url}${suffix}  - ${location}` };
	});
	const selected_url = await select_from_list("Select route to refresh", items);
	const selected = routes.find((route) => route.url === selected_url);
	if (!selected) {
		console.log(`  ${color("Invalid choice.", RED)}`);
		return;
	}

	console.log(`\n  ${color("✓", GREEN)} Selected: ${color(BOLD + selected.url, CYAN)}`);
	const proceed = await confirm(`Refresh fields for "${selected.url}"? Only .ree field sections will be updated.`, "y");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}
	const do_translate = await confirm("Translate missing keys via AI (OpenRouter)?", "n");
	const success = await refresh_crud_fields_only(selected.table, selected.prefix, selected.parent, selected.route_name, do_translate);
	if (!success) {
		console.log(`\n  ${color("Fields refresh failed. Exiting.", RED)}`);
		return;
	}

	const cli_args = [selected.table, "--mode", "fields"];
	if (selected.prefix) cli_args.push("--prefix", selected.prefix);
	if (selected.parent) cli_args.push("--parent", selected.parent);
	if (do_translate) cli_args.push("--translate");
	await show_cli_tip(`bun reeman refresh-crud ${cli_args.join(" ")}`, `Refreshed fields: ${selected.table}`);
}
