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
// CLI equivalent - reproduce this run later without the interactive menu.
// ---------------------------------------------------------------------------

export interface PipelineCliParams {
	table: string;
	prefix?: string;
	parent_table?: string;
	route_name?: string;
	pagination_method?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	force?: boolean;
	sync_translate?: boolean;
}

// crud.ts covers every flag the interactive flow can collect (unlike
// resource.ts/schema.ts, whose CLI surface is narrower - no --route-name,
// --pagination, or --render-strategy) so it's the one script guaranteed to
// reproduce the exact choices made in the menu.
function crud_args(params: PipelineCliParams): string {
	const args = [params.table];
	if (params.prefix) args.push("--prefix", params.prefix);
	if (params.parent_table) args.push("--parent", params.parent_table);
	if (params.route_name) args.push("--route-name", params.route_name);
	if (params.pagination_method) args.push("--pagination", params.pagination_method);
	if (params.render_strategy) args.push("--render-strategy", params.render_strategy);
	if (params.sync_translate) args.push("--translate");
	if (params.force) args.push("--force");
	return `bun generator/crud.ts ${args.join(" ")}`;
}

/**
 * Build the CLI equivalent of run_full_pipeline() (schema + crud) for one table.
 * Used directly by bulk/nested flows, which run one table at a time.
 */
export function build_full_pipeline_cli_tip(params: PipelineCliParams): string {
	const schema_args = [params.table];
	if (params.prefix) schema_args.push("--prefix", params.prefix);
	if (params.parent_table) schema_args.push("--parent", params.parent_table);
	const schema_cmd = `bun generator/schema.ts ${schema_args.join(" ")}`;
	const crud_cmd = crud_args(params);
	return `${schema_cmd} && ${crud_cmd}`;
}

export function build_cli_tip(params: GeneratorParams): string {
	if (params.command === "schema") {
		const args = [params.table!];
		if (params.prefix) args.push("--prefix", params.prefix);
		if (params.parent_table) args.push("--parent", params.parent_table);
		return `bun generator/schema.ts ${args.join(" ")}`;
	}

	if (params.command === "crud") {
		return crud_args({ ...params, table: params.table! });
	}

	if (params.command === "all") {
		const args: string[] = [];
		if (params.force) args.push("--force");
		if (params.sync_translate) args.push("--translate");
		return `bun generator/resource.ts all${args.length ? ` ${args.join(" ")}` : ""}`;
	}

	// "full" - crud.ts alone doesn't run schema generation, so the equivalent
	// is schema.ts followed by crud.ts (mirrors run_full_pipeline's two steps).
	return build_full_pipeline_cli_tip({ ...params, table: params.table! });
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
