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

export function summary_label(params: GeneratorParams): string {
	const cmd_map: Record<string, string> = {
		schema: "Schema only",
		crud: "Full pipeline (schema + CRUD)",
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
	if (params.template_tags) console.log(`  ${color("Template tags:", BOLD)} ${params.template_tags}`);
	if (params.grid_columns?.length) console.log(`  ${color("Index columns:", BOLD)} ${params.grid_columns.join(", ")}`);
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
	template_tags?: "flat" | "tags";
	grid_columns?: string[];
	force?: boolean;
	sync_translate?: boolean;
}

// bun reeman crud runs the full pipeline (schema + CRUD) - see run_generator()
// above and cli.ts's "crud" case. The reeman subcommand covers every flag the
// interactive flow can collect, so it's the single line that reproduces the
// exact choices made in the menu (no more separate schema.ts + crud.ts steps).
function crud_args(params: PipelineCliParams): string {
	const args = [params.table];
	if (params.prefix) args.push("--prefix", params.prefix);
	if (params.parent_table) args.push("--parent", params.parent_table);
	if (params.route_name) args.push("--route-name", params.route_name);
	if (params.pagination_method) args.push("--pagination", params.pagination_method);
	if (params.render_strategy) args.push("--render-strategy", params.render_strategy);
	if (params.template_tags) args.push("--template-tags", params.template_tags);
	if (params.grid_columns?.length) args.push("--grid-columns", params.grid_columns.join(","));
	if (params.sync_translate) args.push("--translate");
	if (params.force) args.push("--force");
	return `bun reeman crud ${args.join(" ")}`;
}

/**
 * Build the CLI equivalent of run_full_pipeline() (schema + crud) for one table.
 * Used directly by bulk/nested flows, which run one table at a time.
 */
export function build_full_pipeline_cli_tip(params: PipelineCliParams): string[] { return [crud_args(params)]; }

export function build_cli_tip(params: GeneratorParams): string[] {
	if (params.command === "schema") {
		const args = [params.table!];
		if (params.prefix) args.push("--prefix", params.prefix);
		if (params.parent_table) args.push("--parent", params.parent_table);
		if (params.grid_columns?.length) args.push("--grid-columns", params.grid_columns.join(","));
		return [`bun reeman schema ${args.join(" ")}`];
	}

	if (params.command === "crud") {
		return [crud_args({ ...params, table: params.table! })];
	}

	// "all" - runs the full pipeline for every table in the database.
	const args: string[] = ["all"];
	if (params.force) args.push("--force");
	if (params.sync_translate) args.push("--translate");
	return [`bun reeman crud ${args.join(" ")}`];
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
			grid_columns: params.grid_columns,
		});
	}

	if (params.command === "crud") {
		return await run_full_pipeline(params.table!, {
			prefix: params.prefix,
			parent_table: params.parent_table,
			force: params.force,
			translate: params.sync_translate,
			pagination_method: params.pagination_method,
			render_strategy: params.render_strategy,
			template_tags: params.template_tags,
			route_name: params.route_name,
			grid_columns: params.grid_columns,
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
				template_tags: params.template_tags,
			});
			if (!ok) success = false;
		}
		return success;
	}

	return false;
}
