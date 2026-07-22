#!/usr/bin/env bun
/**
 * Resource generator execution - delegates to callers instead of spawning processes.
 */

import { generate_schema } from "../schema";
import { run_full_pipeline } from "./callers/resource_caller";
import type { GeneratorParams } from "./types";
import { BOLD, color, CYAN, GREEN, MAGENTA } from "./ui";

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summary_label(params: GeneratorParams): string {
	const cmd_map: Record<string, string> = {
		full: "Full pipeline (schema + CRUD)",
		schema: "Schema only",
		crud: "CRUD only",
		all: "All tables (full pipeline)",
	};
	return cmd_map[params.command] ?? params.command;
}

export function show_summary(params: GeneratorParams): void {
	console.log(`\n${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color(`${BOLD}Summary`, MAGENTA)}`);
	console.log(`${color("-".repeat(50), CYAN)}`);
	console.log(`  ${color("Command:", BOLD)}     ${summary_label(params)}`);
	if (params.table) console.log(`  ${color("Table:", BOLD)}       ${params.table}`);
	if (params.parent_table) console.log(`  ${color("Parent:", BOLD)}      ${params.parent_table}`);
	if (params.prefix) console.log(`  ${color("Prefix:", BOLD)}      ${params.prefix}`);
	if (params.route_name) console.log(`  ${color("Route:", BOLD)}      ${params.route_name}`);
	console.log(`  ${color("Force:", BOLD)}       ${params.force ? color("yes", GREEN) : "no"}`);
	console.log(`  ${color("Translate:", BOLD)}   ${params.sync_translate ? color("yes", GREEN) : "no"}`);
	if (params.pagination_method) console.log(`  ${color("Pagination:", BOLD)}  ${params.pagination_method}`);
	if (params.render_strategy) console.log(`  ${color("Render:", BOLD)}      ${params.render_strategy}`);
	console.log(`${color("-".repeat(50), CYAN)}`);
}

// ---------------------------------------------------------------------------
// Execute the generator
// ---------------------------------------------------------------------------

export async function run_generator(params: GeneratorParams): Promise<boolean> {
	if (params.command === "schema") {
		return await generate_schema(params.table!, {
			prefix: params.prefix,
			parent_table: params.parent_table,
			pagination_strategy: params.pagination_method,
			route_name: params.route_name,
		});
	}

	if (params.command === "full" || params.command === "crud") {
		return await run_full_pipeline(params.table!, {
			prefix: params.prefix,
			parent_table: params.parent_table,
			force: params.force,
			translate: params.sync_translate,
			pagination_method: params.pagination_method,
			render_strategy: params.render_strategy,
			route_name: params.route_name,
		});
	}

	if (params.command === "all") {
		const { get_available_tables } = await import("./db");
		const tables = await get_available_tables();
		let success = true;
		for (const table of tables) {
			const ok = await run_full_pipeline(table, {
				prefix: params.prefix,
				force: params.force,
				translate: params.sync_translate,
				pagination_method: params.pagination_method,
				render_strategy: params.render_strategy,
			});
			if (!ok) success = false;
		}
		return success;
	}

	return false;
}
