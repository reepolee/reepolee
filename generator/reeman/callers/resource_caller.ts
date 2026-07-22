#!/usr/bin/env bun
/**
 * Resource generator callers - directly call generator functions instead of spawning.
 */

import { notify_server_reload } from "$lib/server_notify";

import { generate_crud } from "../../crud/main";
import { generate_schema } from "../../schema";

export interface ResourceCallOptions {
	prefix?: string;
	parent_table?: string;
	force?: boolean;
	translate?: boolean;
	route_name?: string;
	pagination_method?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
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
	});

	if (!schema_success) {
		console.error("✗ Schema generation failed");
		return false;
	}

	console.log("Step 2: Generating CRUD...\n");
	const crud_success = await generate_crud(table, {
		force: options.force,
		translate: options.translate ?? false,
		prefix: options.prefix,
		parent_table: options.parent_table,
		route_name: options.route_name,
		render_strategy: options.render_strategy,
	});

	if (!crud_success) {
		console.error("✗ CRUD generation failed");
		return false;
	}

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
): Promise<{ success: number; fail: number; }> {
	let success_count = 0;
	let fail_count = 0;

	for (let i = 0; i < tables.length; i++) {
		const table = tables[i];
		console.log(`\n[${i + 1}/${tables.length}] Processing: ${table}`);

		const ok = await run_full_pipeline(table, { prefix, translate, pagination_method, render_strategy });
		if (ok) {
			success_count++;
		} else {
			fail_count++;
		}
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
): Promise<{ success: number; fail: number; }> {
	let success_count = 0;
	let fail_count = 0;

	for (let i = 0; i < tables.length; i++) {
		const table = tables[i];
		console.log(`\n[${i + 1}/${tables.length}] Processing: ${table}`);

		const ok = await run_full_pipeline(table, { prefix, parent_table, pagination_method, render_strategy, translate });
		if (ok) {
			success_count++;
		} else {
			fail_count++;
		}
	}

	return { success: success_count, fail: fail_count };
}
