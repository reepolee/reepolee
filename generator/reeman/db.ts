#!/usr/bin/env bun
/**
 * DB connection and query helpers - uses db_cli singleton instead of creating temp connections.
 */

import { join } from "node:path";

import { db_cli } from "$config/db_cli";
import { INTERNAL_TABLE_PREFIX } from "$config/db_structure";
import { MAIN_APP } from "$config/paths";
import { default_locale, locales } from "$config/supported_locales";

import { locale_clone_table_names } from "../naming";
import { color, dim, RED } from "./ui";

// ---------------------------------------------------------------------------
// Available tables from DB (best-effort)
// ---------------------------------------------------------------------------

export function get_connection_string(): string | null {
	const val = Bun.env.DEV_CONNECTION_STRING?.trim() || null;
	if (!val) { console.log(`  ${dim("DB: DEV_CONNECTION_STRING not set in environment")}`); }
	return val;
}

// ---------------------------------------------------------------------------
// CLI-equivalent command for running a .sql file against the configured DB.
// PowerShell has no `<` input redirection operator (bash/cmd do) - piping the
// file content through `Get-Content` is the PowerShell-native equivalent.
// Returns both flavors so callers can show the one for the host shell while
// still logging the correct syntax into both .reepolee/reeman.sh and .ps1,
// keeping the session reproducible on whichever platform replays it.
// ---------------------------------------------------------------------------

export interface SqlCliCommand { sh: string; ps1: string; }

export function build_sql_cli_command(conn_str: string, relative_path: string): SqlCliCommand {
	const normalized = conn_str.toLowerCase();

	if (normalized.startsWith("mysql://")) {
		return { sh: `mysql -u root -p < ${relative_path}`, ps1: `Get-Content ${relative_path} | mysql -u root -p` };
	}

	const sqlite_db_file = conn_str.replace(/^sqlite:\/\//i, "").replace(/^sqlite:/i, "");
	return { sh: `sqlite3 ${sqlite_db_file} < ${relative_path}`, ps1: `Get-Content ${relative_path} | sqlite3 ${sqlite_db_file}` };
}

export async function get_available_tables(): Promise<string[]> {
	try {
		const { load_ddl_cache, get_cached_tables } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const tables = get_cached_tables(cache);
		const locale_clones = locale_clone_table_names(tables, locales, default_locale);
		return tables.filter((t) => !t.startsWith(INTERNAL_TABLE_PREFIX) && !locale_clones.has(t));
	} catch (err) {
		console.log(`  ${color(`Cache error: ${err}`, RED)}`);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Available modules (prefixes) from DB
// ---------------------------------------------------------------------------

export async function get_available_modules(): Promise<{ id: number; code: string; name: string; }[]> {
	try {
		const conn_str = get_connection_string();
		if (!conn_str) return [];

		const rows: any[] = await (db_cli`SELECT id, code, name FROM modules WHERE code != 'default' ORDER BY id` as any);

		return rows.map((r) => ({
			id: Number(r.id ?? 0),
			code: String(r.code ?? ""),
			name: String(r.name ?? r.code ?? ""),
		}));
	} catch (err) {
		console.log(`  ${color(`DB error: ${err}`, RED)}`);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Get child tables (FK references to a parent table)
// ---------------------------------------------------------------------------

export async function get_child_tables(parent_table: string): Promise<{ table: string; fk_column: string; }[]> {
	try {
		const { load_ddl_cache, get_cached_table } = await import("../ddl_cache");
		const cache = await load_ddl_cache();

		const children: { table: string; fk_column: string; }[] = [];
		const parent_lower = parent_table.toLowerCase();

		for (const cached_table of cache.tables) {
			// Check native foreign keys
			for (const fk of cached_table.foreign_keys) {
				if (fk.referenced_table.toLowerCase() === parent_lower) {
					children.push({ table: cached_table.name, fk_column: fk.column_name });
				}
			}
			// Also check inferred FKs
			for (const fk of cached_table.inferred_foreign_keys) {
				if (fk.referenced_table.toLowerCase() === parent_lower) {
					// Avoid duplicates (same column already found via native FK)
					if (!children.some((c) => c.table === cached_table.name && c.fk_column === fk.column_name)) {
						children.push({ table: cached_table.name, fk_column: fk.column_name });
					}
				}
			}
		}

		return children;
	} catch (err) {
		console.log(`  ${color(`Cache error finding children for "${parent_table}": ${err}`, RED)}`);
		return [];
	}
}

// ---------------------------------------------------------------------------
// Index-grid column choices - the columns the interactive flow offers for the
// "which columns to display" prompt. Resolved through the same schema objects
// and type mapper the generator uses, so the prompt lists exactly the columns
// write_table_file() will later decide about.
// ---------------------------------------------------------------------------

export async function get_grid_column_choices(table_name: string): Promise<{ name: string; default_selected: boolean; width: string; class_name: string; filter: boolean; helper: string; readonly: boolean; localized: boolean; }[]> {
	try {
		const { db_type } = await import("$lib/resolve_db_type");
		const { load_ddl_cache, ddl_cache_to_schema_objects } = await import("../ddl_cache");
		const { build_table_column_map } = await import("../schema/field_generator");
		const { list_grid_column_choices } = await import("../schema/write_table");

		const cache = await load_ddl_cache();
		const { all_schemas, all_indexes } = ddl_cache_to_schema_objects(cache);
		const schema_obj = all_schemas.find((o) => o.name === table_name);
		if (!schema_obj) {
			console.log(`  ${color(`Table "${table_name}" not found in schema objects`, RED)}`);
			return [];
		}

		const type_mapper_map = new Map([
			["mysql", async () => new (await import("../schema/mysql/mysql_type_mapper")).MySQLTypeMapper()],
			["sqlite", async () => new (await import("../schema/sqlite/sqlite_type_mapper")).SQLiteTypeMapper()],
		]);
		const type_mapper_factory = type_mapper_map.get(db_type);
		if (!type_mapper_factory) {
			console.log(`  ${color(`Unsupported db_type: ${db_type}`, RED)}`);
			return [];
		}
		const type_mapper = await type_mapper_factory();

		const table_column_map = build_table_column_map(all_schemas);
		const choices = list_grid_column_choices(schema_obj, type_mapper, table_column_map, all_indexes);

		// Pre-check the checkbox from the existing config.ts columns map (a saved
		// readonly flag), not just column-comment attributes. Best-effort: no
		// generated route yet means no saved state, so attribute defaults stand.
		const existing_readonly = await existing_readonly_columns(table_name);
		for (const choice of choices) {
			const saved = existing_readonly.get(choice.name);
			if (saved !== undefined) choice.readonly = saved;
		}
		return choices;
	} catch (err) {
		console.log(`  ${color(`Error listing index columns for "${table_name}": ${err}`, RED)}`);
		return [];
	}
}

/** Which of the table's columns carry `readonly: true` in its config.ts columns map. */
async function existing_readonly_columns(table_name: string): Promise<Map<string, boolean>> {
	const readonly = new Map<string, boolean>();
	try {
		const { discover_routes_with_schema } = await import("./utils/route_scan");
		const { load_table_module_fresh } = await import("../schema/table_module_loader");
		const route = discover_routes_with_schema().find((r) => r.table === table_name);
		if (!route) return readonly;
		const dir_name = route.route_name ?? route.table;
		const parts = [MAIN_APP, ...(route.prefix ? [route.prefix] : []), dir_name, "config.ts"];
		const module = await load_table_module_fresh<{ columns?: Record<string, { readonly?: unknown; }> }>(join(...parts));
		for (const [name, column] of Object.entries(module.columns ?? {})) {
			readonly.set(name, column?.readonly === true);
		}
	} catch {
		// No schema module yet - defaults stand.
	}
	return readonly;
}

// ---------------------------------------------------------------------------
// Get columns for a table
// ---------------------------------------------------------------------------

export async function get_table_columns(table_name: string): Promise<string[]> {
	try {
		const { load_ddl_cache, get_cached_table } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const table = get_cached_table(cache, table_name);

		if (!table) {
			console.log(`  ${color(`Table "${table_name}" not found in DDL cache`, RED)}`);
			return [];
		}

		return table.columns.map((c) => c.name);
	} catch (err) {
		console.log(`  ${color(`Cache error fetching columns for "${table_name}": ${err}`, RED)}`);
		return [];
	}
}
