/**
 * Driving the syncer from reeman and from the generators.
 *
 * Discovers which tables are localized by reading each route's schema/table.ts
 * `columns` map (the `localized: true` flag is the only generation-time
 * localization decision - see read_localization in crud/schema_reader.ts),
 * then syncs every one of them.
 */

import { join } from "node:path";

import { db } from "$config/db";
import { default_locale, locales } from "$config/supported_locales";
import { db_type } from "$lib/resolve_db_type";

import { load_ddl_cache, ddl_cache_to_schema_objects } from "../ddl_cache";
import type { SchemaObject } from "../schema/types";
import { discover_routes_with_schema, type RouteSchema } from "../reeman/utils/route_scan";
import { sync_locale_tables, type SyncAction, type SyncResult } from "./sync";
import { MAIN_APP } from "$config/paths";

export interface LocalizedTableInfo {
	table_name: string;
	localized_field_names: string[];
}

/**
 * Read `localized: true` flags out of a route's schema/table.ts.
 *
 * Imported rather than parsed so a computed columns map still works, with a
 * cache-busting query string because reeman regenerates these files inside a
 * single process run.
 */
async function read_localized_fields(route: RouteSchema): Promise<string[]> {
	const segments = [MAIN_APP];
	if (route.prefix) segments.push(route.prefix);
	if (route.parent) segments.push(route.parent);
	segments.push(route.route_name || route.table, "schema", "table.ts");
	const module_path = join(process.cwd(), ...segments);

	const file = Bun.file(module_path);
	if (!(await file.exists())) return [];

	try {
		const imported = await import(`${module_path}?locale_sync=${Date.now()}`);
		const columns = imported.columns as Record<string, { localized?: boolean; }> | undefined;
		if (!columns) return [];

		const localized: string[] = [];
		for (const [field_name, column] of Object.entries(columns)) {
			if (column?.localized === true) localized.push(field_name);
		}
		return localized;
	} catch (error) {
		console.warn(`[locale-tables] Could not read ${module_path}: ${error instanceof Error ? error.message : error}`);
		return [];
	}
}

/** Every table declaring at least one `localized: true` column. */
export async function discover_localized_tables(): Promise<LocalizedTableInfo[]> {
	const routes = discover_routes_with_schema();
	const found: LocalizedTableInfo[] = [];

	for (const route of routes) {
		const localized_field_names = await read_localized_fields(route);
		if (localized_field_names.length === 0) continue;
		found.push({ table_name: route.table, localized_field_names });
	}

	return found;
}

export interface RunSyncOptions {
	/** Limit to one base table; omit to sync every localized table. */
	table?: string;
	dry_run?: boolean;
}

export interface RunSyncReport {
	results: SyncResult[];
	localized_tables: LocalizedTableInfo[];
}

/**
 * Sync every localized table (or one named table) against the configured
 * locales. Idempotent - a converged schema produces no actions.
 */
export async function run_locale_table_sync(options: RunSyncOptions = {}): Promise<RunSyncReport> {
	const { table, dry_run = false } = options;

	const localized_tables = await discover_localized_tables();
	const selected = table ? localized_tables.filter((info) => info.table_name === table) : localized_tables;

	if (selected.length === 0) return { results: [], localized_tables };

	const cache = await load_ddl_cache();
	const { all_schemas } = ddl_cache_to_schema_objects(cache);
	const schema_by_name = new Map<string, SchemaObject>();
	for (const schema of all_schemas) schema_by_name.set(schema.name.toLowerCase(), schema);

	const localized_table_names = new Set(localized_tables.map((info) => info.table_name));
	const dialect = db_type;
	const results: SyncResult[] = [];

	for (const info of selected) {
		const base_schema = schema_by_name.get(info.table_name.toLowerCase());
		if (!base_schema) {
			console.warn(`[locale-tables] No schema found for ${info.table_name}, skipping`);
			continue;
		}

		const result = await sync_locale_tables({
			db,
			dialect,
			base_schema,
			localized_field_names: info.localized_field_names,
			locale_codes: locales as readonly string[],
			default_locale_code: default_locale,
			localized_tables: localized_table_names,
			dry_run,
		});
		results.push(result);
	}

	return { results, localized_tables };
}

export function format_sync_actions(actions: readonly SyncAction[]): string[] {
	return actions.map((action) => {
		if (action.kind === "create_table") return `created ${action.table}`;
		if (action.kind === "drop_table") return `dropped ${action.table}`;
		if (action.kind === "add_column") return `added ${action.table}.${action.column}`;
		if (action.kind === "drop_column") return `dropped ${action.table}.${action.column}`;
		return `backfilled ${action.table}${action.column ? `.${action.column}` : ""}`;
	});
}
