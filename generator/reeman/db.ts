#!/usr/bin/env bun
/**
 * DB connection and query helpers - uses db_cli singleton instead of creating temp connections.
 */

import { db_cli } from "$config/db_cli";
import { INTERNAL_TABLE_PREFIX } from "$config/db_structure";

import { color, dim, RED } from "./ui";

// ---------------------------------------------------------------------------
// Available tables from DB (best-effort)
// ---------------------------------------------------------------------------

export function get_connection_string(): string | null {
	const val = Bun.env.CONNECTION_STRING?.trim() || null;
	if (!val) { console.log(`  ${dim("DB: CONNECTION_STRING not set in environment")}`); }
	return val;
}

export async function get_available_tables(): Promise<string[]> {
	try {
		const { load_ddl_cache, get_cached_tables } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const tables = get_cached_tables(cache);
		return tables.filter((t) => !t.startsWith(INTERNAL_TABLE_PREFIX));
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
