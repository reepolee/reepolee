#!/usr/bin/env bun
/**
 * Simple Table Page flow - interactive parameter collection for simple routes.
 */

import { get_available_modules, get_available_tables, get_table_columns } from "../db";
import { generate_simple_route } from "../simple_route";
import type { OrderByItem, WhereItem } from "../types";
import {
	ask,
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
	YELLOW,
} from "../ui";
import { run_reettier } from "../utils/reeformat";

const WHERE_OPERATORS = ["=", "!=", "<", "<=", ">", ">=", "LIKE"];

export interface SimpleRouteParams {
	prefix: string;
	folder_name: string;
	table_name: string;
	selected_fields: string[];
	order_by: OrderByItem[];
	where: WhereItem[];
}

/**
 * Collect parameters for a simple table route interactively.
 * Returns the collected params or null if cancelled.
 */
export async function collect_simple_route_params(): Promise<SimpleRouteParams | null> {
	// Prefix selection
	header("Route prefix");

	const modules = await get_available_modules();
	const prefix_items = [
		{ value: "", label: "(none) - no prefix, place directly in /routes" },
		...modules.map((m) => ({ value: m.code, label: `${m.code} - ${m.name}` })),
	];
	const prefix = await select_from_list("Select prefix", prefix_items);

	if (prefix) {
		console.log(`  ${color("✓", GREEN)} Prefix: ${color(BOLD + prefix, CYAN)}`);
	} else {
		console.log(`  ${dim("  (no prefix)")}`);
	}

	// Table selection
	header("Select table");

	const tables = await get_available_tables();
	if (tables.length === 0) {
		console.log(`  ${color("No tables found in database.", RED)}`);
		return null;
	}

	const table_items = tables.map((t) => ({ value: t, label: t }));
	const simple_table_name = await select_from_list("Select table", table_items);

	if (!simple_table_name) {
		console.log(`  ${color("No table specified. Returning to menu.", YELLOW)}`);
		return null;
	}

	console.log(`  ${color("✓", GREEN)} Table: ${color(BOLD + simple_table_name, CYAN)}`);

	// Field selection
	header("Select fields to display");

	const columns = await get_table_columns(simple_table_name);

	if (columns.length === 0) {
		console.log(`  ${color(`No columns found for table "${simple_table_name}".`, RED)}`);
		return null;
	}

	const field_items = columns.map((c) => ({ value: c, label: c }));
	const simple_selected_fields = await multi_select("Select fields to display (arrows + space + enter)", field_items);

	if (simple_selected_fields.length === 0) {
		console.log(`  ${color("No fields selected. Returning to menu.", YELLOW)}`);
		return null;
	}

	console.log(`  ${color("✓", GREEN)} Fields: ${color(BOLD + simple_selected_fields.join(", "), CYAN)}`);

	// Ordering
	const simple_order_by: OrderByItem[] = [];
	const want_order = await confirm("Add ORDER BY clause?", "n");

	if (want_order) {
		const collected = await collect_order_by_fields(simple_selected_fields);
		simple_order_by.push(...collected);

		if (collected.length > 0) {
			const order_desc = collected.map((o) => `${o.field} ${o.direction}`).join(", ");
			console.log(`  ${color("✓", GREEN)} Order: ${color(BOLD + order_desc, CYAN)}`);
		} else {
			console.log(`  ${dim("  (no ordering)")}`);
		}
	} else {
		console.log(`  ${dim("  (no ordering)")}`);
	}

	// WHERE
	const simple_where: WhereItem[] = [];
	const want_where = await confirm("Add WHERE conditions?", "n");

	if (want_where) {
		const collected = await collect_where_fields(simple_selected_fields);
		simple_where.push(...collected);

		if (collected.length > 0) {
			const where_desc = collected.map((w) => `${w.field} ${w.operator} '${w.value}'`).join(" AND ");
			console.log(`  ${color("✓", GREEN)} WHERE: ${color(BOLD + where_desc, CYAN)}`);
		} else {
			console.log(`  ${dim("  (no conditions)")}`);
		}
	} else {
		console.log(`  ${dim("  (no conditions)")}`);
	}

	// Folder name
	header("Route folder name");

	const raw_name = await ask("Folder name (e.g. 'my_page')");
	if (!raw_name) {
		console.log(`  ${color("No folder name specified. Returning to menu.", YELLOW)}`);
		return null;
	}

	if (!/^[a-z0-9][a-z0-9_-]*$/.test(raw_name)) {
		console.log(`  ${color("Invalid folder name. Returning to menu.", RED)}`);
		return null;
	}

	const folder_name = raw_name;
	console.log(`  ${color("✓", GREEN)} Folder: ${color(BOLD + folder_name, CYAN)}`);

	return {
		prefix,
		folder_name,
		table_name: simple_table_name,
		selected_fields: simple_selected_fields,
		order_by: simple_order_by,
		where: simple_where,
	};
}

// ---------------------------------------------------------------------------
// Run the full simple route flow: collect -> summary -> confirm -> execute
// ---------------------------------------------------------------------------

export async function run_simple_route_flow(): Promise<boolean> {
	const params = await collect_simple_route_params();
	if (!params) return false;

	header("Ready to go");

	console.log(`\n${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color(`${BOLD}Summary`, MAGENTA)}`);
	console.log(`${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color("Command:", BOLD)}     Simple Table Page`);
	console.log(`  ${color("Folder:", BOLD)}      ${params.folder_name}`);
	console.log(`  ${color("Table:", BOLD)}       ${params.table_name}`);
	console.log(`  ${color("Fields:", BOLD)}      ${params.selected_fields.join(", ")}`);
	if (params.order_by.length > 0) {
		const order_desc = params.order_by.map((o) => `${o.field} ${o.direction}`).join(", ");
		console.log(`  ${color("Order:", BOLD)}      ${order_desc}`);
	} else {
		console.log(`  ${color("Order:", BOLD)}      ${dim("none")}`);
	}
	if (params.where.length > 0) {
		const where_desc = params.where.map((w) => `${w.field} ${w.operator} '${w.value}'`).join(" AND ");
		console.log(`  ${color("Where:", BOLD)}      ${where_desc}`);
	} else {
		console.log(`  ${color("Where:", BOLD)}      ${dim("none")}`);
	}
	if (params.prefix) console.log(`  ${color("Prefix:", BOLD)}      ${params.prefix}`);
	console.log(`${color("-".repeat(50), CYAN)}`);

	const proceed = await confirm("Create the Simple Table Page now?", "y");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return false;
	}

	await generate_simple_route(
		params.prefix,
		params.folder_name,
		params.table_name,
		params.selected_fields,
		params.order_by,
		params.where
	);

	const simple_route_rel = `routes${params.prefix ? `/${params.prefix}` : ""}/${params.folder_name}`;
	run_reettier(simple_route_rel);

	return true;
}

// ---------------------------------------------------------------------------
// ORDER BY field collection
// ---------------------------------------------------------------------------

export async function collect_order_by_fields(available_fields: string[]): Promise<OrderByItem[]> {
	const result: OrderByItem[] = [];

	while (true) {
		console.log();
		for (let i = 0; i < available_fields.length; i++) {
			const num = color(BOLD + String(i + 1), GREEN);
			console.log(`    ${num}  ${available_fields[i]}`);
		}
		console.log();

		const choice = await ask("Select field to order by (number), or leave blank to finish", "");

		if (!choice) break;

		const idx = parseInt(choice, 10) - 1;
		if (Number.isNaN(idx) || idx < 0 || idx >= available_fields.length) {
			console.log(`  ${color("Invalid selection.", RED)}`);
			continue;
		}

		const field = available_fields[idx];

		if (result.some((o) => o.field === field)) {
			console.log(`  ${color(`"${field}" already added. Pick another.`, YELLOW)}`);
			continue;
		}

		const dir = await ask(`Direction for "${field}" (asc/desc)`, "asc");

		const direction = dir.trim().toLowerCase() === "desc" ? "DESC" : "ASC";
		result.push({ field, direction });
		console.log(`  ${color("✓", GREEN)} Will order by ${color(`${BOLD}${field} ${direction}`, CYAN)}`);
	}

	return result;
}

// ---------------------------------------------------------------------------
// WHERE condition collection
// ---------------------------------------------------------------------------

export async function collect_where_fields(available_fields: string[]): Promise<WhereItem[]> {
	const result: WhereItem[] = [];

	while (true) {
		console.log();
		for (let i = 0; i < available_fields.length; i++) {
			const num = color(BOLD + String(i + 1), GREEN);
			console.log(`    ${num}  ${available_fields[i]}`);
		}
		console.log();

		const field_choice = await ask("Select field (number), or leave blank to finish", "");

		if (!field_choice) break;

		const idx = parseInt(field_choice, 10) - 1;
		if (Number.isNaN(idx) || idx < 0 || idx >= available_fields.length) {
			console.log(`  ${color("Invalid selection.", RED)}`);
			continue;
		}

		const field = available_fields[idx];

		console.log();
		for (let i = 0; i < WHERE_OPERATORS.length; i++) {
			const num = color(BOLD + String(i + 1), GREEN);
			console.log(`    ${num}  ${WHERE_OPERATORS[i]}`);
		}
		console.log();

		const op_choice = await ask("Select operator number", "1");
		const op_idx = parseInt(op_choice, 10) - 1;
		const operator = op_idx >= 0 && op_idx < WHERE_OPERATORS.length ? WHERE_OPERATORS[op_idx] : "=";

		const value = await ask(`Value for "${field} ${operator}"`);

		if (!value) {
			console.log(`  ${color("No value entered. Skipping this condition.", YELLOW)}`);
			continue;
		}

		result.push({ field, operator, value });
		console.log(`  ${color("✓", GREEN)} WHERE ${color(`${BOLD}${field} ${operator} '${value}'`, CYAN)}`);
	}

	return result;
}
