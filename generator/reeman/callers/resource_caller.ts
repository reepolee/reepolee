#!/usr/bin/env bun
/**
 * Resource generator callers - directly call generator functions instead of spawning.
 */

import { notify_server_reload } from "$lib/server_notify";

import { generate_crud } from "../../crud/main";
import { generate_schema } from "../../schema";
import type { GridColumnDefinition } from "../../schema/types";

export interface ResourceCallOptions {
	prefix?: string;
	parent_table?: string;
	force?: boolean;
	/** Allow an overwrite prompt to block on stdin (CLI only). Web/MCP callers pass false. */
	interactive?: boolean;
	translate?: boolean;
	route_name?: string;
	pagination_method?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	template_tags?: "flat" | "tags";
	/** Index-grid columns chosen interactively - see SchemaOptions.grid_columns. */
	grid_columns?: string[];
	grid_column_definitions?: GridColumnDefinition[];
}

/**
 * Run the full resource pipeline: schema generation + CRUD generation for a single table.
 */
export async function run_full_pipeline(table: string, options: ResourceCallOptions = {}): Promise<boolean> {
	console.log(`Starting generation pipeline for table: ${table}\n`);

	console.log("Step 1: Generating schema...");
	const schema_success = await generate_schema(table, {
		prefix: options.prefix,
		parent_table: options.parent_table,
		pagination_strategy: options.pagination_method,
		route_name: options.route_name,
		grid_columns: options.grid_columns,
		grid_column_definitions: options.grid_column_definitions,
	});

	if (!schema_success) {
		console.error("✗ Schema generation failed");
		return false;
	}

	console.log("Step 2: Generating CRUD...\n");
	const crud_success = await generate_crud(table, {
		force: options.force,
		interactive: options.interactive,
		translate: options.translate ?? false,
		prefix: options.prefix,
		parent_table: options.parent_table,
		route_name: options.route_name,
		render_strategy: options.render_strategy,
		template_tags: options.template_tags,
	});

	if (!crud_success) {
		console.error("✗ CRUD generation failed");
		return false;
	}

	await notify_server_reload(false, Bun.env.MAIN_APP_URL);
	await notify_server_reload();
	console.log(`✓ Pipeline complete: ${table} fully generated`);
	return true;
}

/**
 * Run CRUD generation for a batch of tables (schema + CRUD for each).
 */
export async function run_bulk_generator(
	tables: string[],
	prefix: string,
	translate: boolean = false,
	pagination_method: "cursor" | "offset" = "offset",
	render_strategy: "stream" | "load" = "load",
	template_tags?: "flat" | "tags",
	interactive?: boolean,
): Promise<{ success: number; fail: number; }> {
	let success_count = 0;
	let fail_count = 0;

	// Generate all tables first, deferring translation until the end.
	// AI translation can be slow - doing it per-table blocks the next
	// table from starting.
	for (let i = 0; i < tables.length; i++) {
		const table = tables[i]!;
		console.log(`\n[${i + 1}/${tables.length}] Processing: ${table}`);

		const ok = await run_full_pipeline(table, { prefix, translate: false, pagination_method, render_strategy, template_tags, interactive });
		if (ok) {
			success_count++;
		} else {
			fail_count++;
		}
	}

	if (translate) {
		console.log(`\nTranslating all namespaces...`);
		const { sync_all_namespaces } = await import("../../translate_namespace");
		await sync_all_namespaces();
		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		await notify_server_reload();
	}

	return { success: success_count, fail: fail_count };
}

/**
 * Run nested CRUD generation for a batch of child tables under a parent.
 */
export async function run_bulk_nested_generator(
	tables: string[],
	parent_table: string,
	prefix: string,
	pagination_method: "cursor" | "offset" = "offset",
	render_strategy: "stream" | "load" = "load",
	translate: boolean = false,
	template_tags?: "flat" | "tags",
	interactive?: boolean,
): Promise<{ success: number; fail: number; }> {
	let success_count = 0;
	let fail_count = 0;

	// Generate all tables first, deferring translation until the end.
	for (let i = 0; i < tables.length; i++) {
		const table = tables[i]!;
		console.log(`\n[${i + 1}/${tables.length}] Processing: ${table}`);

		const ok = await run_full_pipeline(table, { prefix, parent_table, pagination_method, render_strategy, translate: false, template_tags, interactive });
		if (ok) {
			success_count++;
		} else {
			fail_count++;
		}
	}

	if (translate) {
		console.log(`\nTranslating all namespaces...`);
		const { sync_all_namespaces } = await import("../../translate_namespace");
		await sync_all_namespaces();
		await notify_server_reload(false, Bun.env.MAIN_APP_URL);
		await notify_server_reload();
	}

	return { success: success_count, fail: fail_count };
}
