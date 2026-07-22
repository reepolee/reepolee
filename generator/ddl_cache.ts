/**
 * DDL Cache - Database Structure Cache.
 *
 * When the reeman or generators CLI starts, this module inspects the entire database,
 * detects all foreign key relationships (native DDL, implicit *_id naming, and
 * view join patterns), and caches the result to a JSON file. Subsequent reads
 * during the same session use the cached data without re-querying the database.
 *
 * Usage:
 * import { load_ddl_cache, get_cached_tables, get_cached_table } from "./ddl_cache";
 * const cache = await load_ddl_cache();
 * const tables = get_cached_tables(cache);
 * const frameworks = get_cached_table(cache, "frameworks");
 *
 * Cache file location: .reepolee/ddl_cache.json (gitignored).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { require_env } from "$lib/env";
import { db_type } from "$lib/resolve_db_type";
import { SQL } from "bun";

import { escape_regex } from "./crud/helpers";
import { pluralize_english, singularize } from "./naming";
import { MySQLIntrospector } from "./schema/mysql/mysql_introspector";
import { MySQLTypeMapper } from "./schema/mysql/mysql_type_mapper";
import { SQLiteIntrospector } from "./schema/sqlite/sqlite_introspector";
import { SQLiteTypeMapper } from "./schema/sqlite/sqlite_type_mapper";
import type { ColumnDef, ForeignKeyDef, SchemaObject } from "./schema/types";
import type { DdlCacheData, DdlCachedColumn, DdlCachedForeignKey, DdlCachedTable } from "./ddl_cache_types";

export type { DdlCacheData, DdlCachedTable, DdlCachedColumn, DdlCachedForeignKey } from "./ddl_cache_types";
export { all_foreign_keys_for_table } from "./ddl_cache_types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_DIR = join(process.cwd(), ".reepolee");
const CACHE_FILE = join(CACHE_DIR, "ddl_cache.json");

// Tables/views whose names start with this prefix are excluded from the cache.
const INTERNAL_PREFIXES = ["_", "sqlite_"];

// Minimum number of results before we consider the cache valid.
const MIN_EXPECTED_TABLES = 2;

// Time-to-live for the cache file in milliseconds (24 hours).
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Module-level state (persistent across imports within the same process)
// ---------------------------------------------------------------------------

let _cached_data: DdlCacheData | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the DB cache.
 *
 * If a valid cache file exists and is recent enough, read from it.
 * Otherwise, introspect the full database, detect FKs (native + implicit + view),
 * write the cache file, and return.
 *
 * Pass { force_refresh: true } to bypass the cache and re-introspect.
 */
export async function load_ddl_cache(options: { force_refresh?: boolean; } = {}): Promise<DdlCacheData> {
	if (_cached_data && !options.force_refresh) { return _cached_data; }

	// Try reading from cache file first
	if (!options.force_refresh) {
		const from_file = read_cache_file();
		if (from_file) {
			_cached_data = from_file;
			return from_file;
		}
	}

	// Introspect the database
	console.log(`[DDL Cache] Introspecting ${db_type.toUpperCase()} database...`);
	const data = await introspect_database();

	// Write to cache file
	write_cache_file(data);

	_cached_data = data;
	console.log(`[DDL Cache] Cached ${data.tables.length} tables with FK relationships.`);
	return data;
}

// Get all table names from the cache.
export function get_cached_tables(data: DdlCacheData): string[] { return data.tables.map((t) => t.name); }

// Get a specific table by name (case-insensitive).
export function get_cached_table(data: DdlCacheData, name: string): DdlCachedTable | undefined { return data.tables.find((t) => t.name.toLowerCase() === name.toLowerCase()); }

// Get all foreign keys for a table (native + inferred + view), deduplicated by column name.
export function get_cached_foreign_keys(data: DdlCacheData, name: string): DdlCachedForeignKey[] {
	const table = get_cached_table(data, name);
	if (!table) return [];

	const seen_cols = new Set();
	const all: DdlCachedForeignKey[] = [];

	for (const fk of [...table.foreign_keys, ...table.inferred_foreign_keys, ...table.view_foreign_keys]) {
		if (!seen_cols.has(fk.column_name)) {
			seen_cols.add(fk.column_name);
			all.push(fk);
		}
	}

	return all;
}

/**
 * Invalidate the cache so the next call to load_ddl_cache() re-introspects.
 * Useful after schema changes during a reeman session.
 *
 * Clears BOTH layers. Dropping only the in-memory copy is not enough: load_ddl_cache()
 * falls through to read_cache_file(), and the on-disk JSON stays valid for its 24h TTL,
 * so the stale schema is read straight back in and new tables stay invisible.
 */
export function invalidate_cache(): void {
	_cached_data = null;
	delete_cache_file();
}

// ---------------------------------------------------------------------------
// Cache file I/O
// ---------------------------------------------------------------------------

function read_cache_file(): DdlCacheData | null {
	try {
		if (!existsSync(CACHE_FILE)) return null;

		const stat = readFileSync(CACHE_FILE, "utf-8");
		const data: DdlCacheData = JSON.parse(stat);

		// Basic validation
		if (!data.generated_at || !data.db_type || !Array.isArray(data.tables)) { return null; }

		// Check TTL
		const age = Date.now() - new Date(data.generated_at).getTime();
		if (age > CACHE_TTL_MS) {
			console.log("[DDL Cache] Cache file expired, re-introspecting...");
			return null;
		}

		// Sanity-check: at least MIN_EXPECTED_TABLES tables
		if (data.tables.length < MIN_EXPECTED_TABLES) { return null; }

		console.log(`[DDL Cache] Loaded ${data.tables.length} tables from cache file.`);
		return data;
	} catch {
		return null;
	}
}

function write_cache_file(data: DdlCacheData): void {
	try {
		if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
	} catch (err) {
		console.error("[DDL Cache] Failed to write cache file:", err instanceof Error ? err.message : err);
	}
}

/**
 * Remove the on-disk cache file so the next load re-introspects the database.
 * A missing file is not an error - read_cache_file() treats it as a cache miss.
 */
function delete_cache_file(): void {
	try {
		if (existsSync(CACHE_FILE)) {
			rmSync(CACHE_FILE);
			console.log("[DDL Cache] Cache file removed - next load will re-introspect.");
		}
	} catch (err) {
		console.error("[DDL Cache] Failed to remove cache file:", err instanceof Error ? err.message : err);
	}
}

// ---------------------------------------------------------------------------
// Full database introspection
// ---------------------------------------------------------------------------

async function introspect_database(): Promise<DdlCacheData> {
	const url = require_env("CONNECTION_STRING");
	const db = new SQL(url);

	try {
		const introspector = db_type === "mysql" ? new MySQLIntrospector(db) : new SQLiteIntrospector(db);

		const all_schemas = await introspector.get_database_schema();
		const all_indexes = await introspector.get_all_indexes();

		// Build a table->columns map for implicit FK detection
		const table_column_map = new Map();
		for (const schema of all_schemas) {
			if (schema.type === "table") { table_column_map.set(schema.name, schema.columns.map((c) => c.name.toLowerCase())); }
		}

		// Collect view definitions for view-based FK detection
		// Get view names from schemas (already introspected correctly by get_database_schema())
		const view_names = all_schemas.filter((s) => s.type === "view").map((s) => s.name.toLowerCase());
		console.log(`[DDL Cache] Found ${all_schemas.length} schemas (${all_schemas.filter((s) => s.type === "table").length} tables, ${view_names.length} views)`);

		const view_definitions = await get_view_definitions(db, view_names);

		// Build the cache entry for each table
		const tables: DdlCachedTable[] = [];

		for (const schema of all_schemas) {
			if (schema.type !== "table") continue;

			// Skip internal tables
			if (INTERNAL_PREFIXES.some((p) => schema.name.toLowerCase().startsWith(p))) continue;

			// Is there a view for this table?
			const view_name = schema.has_view ? `v_${schema.name}` : null;
			const view_sql = view_name ? view_definitions.get(view_name.toLowerCase()) ?? null : null;

			// Detect native FKs
			const native_fks = schema.foreign_keys.map((fk) => ({
				column_name: fk.column_name,
				referenced_table: fk.referenced_table_name,
				referenced_column: fk.referenced_column_name,
				source: "native" as const,
				confidence: "exact" as const,
			}));

			// Detect implicit FKs from *_id naming convention
			const inferred_fks = detect_implicit_foreign_keys(schema, table_column_map);

			// Detect FKs from view JOIN conditions
			const view_fks = view_sql ? detect_view_foreign_keys(schema.name, view_sql, all_schemas) : [];

			// Map view columns
			const view_columns: DdlCachedColumn[] | null = schema.view_columns ? schema.view_columns.map((col) => ({
				name: col.name,
				type_string: col.type_string,
				comment: col.comment,
				is_nullable: col.is_nullable,
				is_primary_key: col.is_primary_key,
				is_auto_increment: col.is_auto_increment,
				is_generated: col.is_generated ?? false,
			})) : null;

			// Indexed columns for this table
			const table_indexes = all_indexes.get(schema.name.toLowerCase());
			const indexed_columns = table_indexes ? Array.from(table_indexes).map((c) => c.toLowerCase()) : [];

			tables.push({
				name: schema.name,
				comment: schema.comment ?? "",
				columns: schema.columns.map(map_column),
				indexed_columns,
				foreign_keys: native_fks,
				inferred_foreign_keys: inferred_fks,
				view_foreign_keys: view_fks,
				has_view: schema.has_view,
				view_name,
				view_columns,
				view_definition: view_sql,
			});
		}

		return { generated_at: new Date().toISOString(), db_type, tables };
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------------------
// Conversion helpers - transform cache data back to SchemaObject + index map
// for use by the schema generator and CRUD refresh pipeline.
// ---------------------------------------------------------------------------

/**
 * Convert DdlCacheData back to the SchemaObject[] and index map expected
 * by the schema generator and CRUD pipeline.
 */
export function ddl_cache_to_schema_objects(cache: DdlCacheData): { all_schemas: SchemaObject[]; all_indexes: Map<string, Set<string>>; } {
	const all_schemas: SchemaObject[] = [];
	const all_indexes = new Map();

	for (const table of cache.tables) {
		all_indexes.set(table.name.toLowerCase(), new Set(table.indexed_columns));

		// Combine native + inferred + view FKs so downstream consumers
		// (generate_fields_object, field_generator) see all detected relationships.
		// Inferred and view FKs come AFTER native FKs so the same column name
		// in the dedup logic below keeps the native/exact one.
		const all_fks = [...table.foreign_keys, ...table.inferred_foreign_keys, ...table.view_foreign_keys];
		const seen_fk_cols = new Set();
		const foreign_keys: ForeignKeyDef[] = [];
		for (const fk of all_fks) {
			if (seen_fk_cols.has(fk.column_name.toLowerCase())) continue;
			seen_fk_cols.add(fk.column_name.toLowerCase());
			foreign_keys.push({
				constraint_name: `fk_${table.name}_${fk.column_name}`,
				column_name: fk.column_name,
				referenced_table_name: fk.referenced_table,
				referenced_column_name: fk.referenced_column,
			});
		}

		const columns: ColumnDef[] = table.columns.map((col) => ({
			name: col.name,
			type_string: col.type_string,
			comment: col.comment,
			is_nullable: col.is_nullable,
			is_primary_key: col.is_primary_key,
			is_auto_increment: col.is_auto_increment,
			is_generated: col.is_generated,
		}));

		const view_columns: ColumnDef[] | undefined = table.view_columns?.map((col) => ({
			name: col.name,
			type_string: col.type_string,
			comment: col.comment,
			is_nullable: col.is_nullable,
			is_primary_key: col.is_primary_key,
			is_auto_increment: col.is_auto_increment,
			is_generated: col.is_generated,
		}));

		all_schemas.push({
			type: "table",
			name: table.name,
			comment: table.comment || undefined,
			columns,
			view_columns: view_columns && view_columns.length > 0 ? view_columns : undefined,
			foreign_keys,
			has_view: table.has_view,
		});
	}

	return { all_schemas, all_indexes };
}

// ---------------------------------------------------------------------------
// Column mapping helper
// ---------------------------------------------------------------------------

function map_column(col: ColumnDef): DdlCachedColumn {
	return {
		name: col.name,
		type_string: col.type_string,
		comment: col.comment,
		is_nullable: col.is_nullable,
		is_primary_key: col.is_primary_key,
		is_auto_increment: col.is_auto_increment,
		is_generated: col.is_generated ?? false,
	};
}

// ---------------------------------------------------------------------------
// View definition retrieval
// ---------------------------------------------------------------------------

/**
 * Fetch view SQL definitions from the database.
 * Returns a map of lowercased view name -> CREATE VIEW SQL.
 *
 * For MySQL, uses SHOW CREATE VIEW which is more reliable than
 * querying information_schema.VIEWS (some MariaDB versions return
 * empty VIEW_DEFINITION for certain views).
 *
 * @param view_names - Lowercased view names to fetch (from all_schemas)
 */
async function get_view_definitions(db: SQL, view_names: string[]): Promise<Map<string, string>> {
	const view_map = new Map();

	try {
		if (db_type === "mysql") {
			// SHOW CREATE VIEW is the most reliable way to get view SQL in MySQL/MariaDB
			for (const vname of view_names) {
				try {
					const rows = (await db.unsafe(`SHOW CREATE VIEW \`${vname}\``)) as any[];
					if (rows.length > 0) {
						// SHOW CREATE VIEW returns columns: View, Create View, character_set_client, collation_connection
						// Try multiple column name variants (Bun's MySQL driver may normalize casing)
						const row = rows[0];
						const create_def = (row["Create View"] ?? row["create view"] ?? row["Create_View"] ?? row.create_view ?? "") as string;
						if (create_def) { view_map.set(vname, create_def); }
					}
				} catch {
					// Individual view might not exist or might not be accessible
					console.log(`[DDL Cache] Could not fetch definition for view "${vname}"`);
				}
			}

			// Fallback: information_schema.VIEWS with uppercase column access (matching MySQLIntrospector pattern)
			if (view_map.size === 0 && view_names.length > 0) {
				try {
					const info_rows = (await db.unsafe(`
						SELECT TABLE_NAME, VIEW_DEFINITION
						FROM information_schema.VIEWS
						WHERE TABLE_SCHEMA = DATABASE()
					`)) as any[];
					for (const info_row of info_rows) {
						const v_name: string = (info_row.TABLE_NAME ?? "").toLowerCase();
						const v_def: string = (info_row.VIEW_DEFINITION ?? "") as string;
						if (v_name && v_def && view_names.includes(v_name)) { view_map.set(v_name, v_def); }
					}
				} catch (err) {
					console.log(`[DDL Cache] information_schema.VIEWS fallback also failed: ${err instanceof Error ? err.message : err}`);
				}
			}
		} else {
			const rows = (await db.unsafe(`
				SELECT name, sql FROM sqlite_master WHERE type = 'view'
			`)) as any[];

			for (const row of rows) {
				const name: string = (row.name ?? "").toLowerCase();
				const sql_def: string = row.sql ?? "";
				if (name && sql_def) view_map.set(name, sql_def);
			}
		}
	} catch (err) {
		console.error("[DDL Cache] Failed to fetch view definitions:", err instanceof Error ? err.message : err);
	}

	return view_map;
}

// ---------------------------------------------------------------------------
// Implicit FK detection (from *_id naming convention)
// ---------------------------------------------------------------------------

export function detect_implicit_foreign_keys(schema: SchemaObject, table_column_map: Map<string, string[]>): DdlCachedForeignKey[] {
	const fks: DdlCachedForeignKey[] = [];
	const native_fk_cols = new Set(schema.foreign_keys.map((fk) => fk.column_name.toLowerCase()));

	for (const col of schema.columns) {
		const col_lower = col.name.toLowerCase();

		// Skip columns that already have a native FK
		if (native_fk_cols.has(col_lower)) continue;

		// Must end with _id
		if (!col_lower.endsWith("_id")) continue;

		// Check each known table for a naming match
		let found = false;

		for (const [table_name, table_cols] of table_column_map) {
			const singular = singularize(table_name);
			const prefix = `${singular}_`;

			if (col_lower.startsWith(prefix)) {
				const candidate_column = col_lower.slice(prefix.length);

				// The remainder after the prefix must be a known column in the target table
				if (table_cols.includes(candidate_column)) {
					fks.push({
						column_name: col.name,
						referenced_table: table_name,
						referenced_column: candidate_column,
						source: "inferred_naming",
						confidence: "high",
					});
					found = true;
					break;
				}
			}

			// Also try: {stem}_id -> {plural_stem}s.id
			// e.g. author_id -> authors.id
			if (!found) {
				const stem = col_lower.replace(/_id$/, "");
				if (table_name.toLowerCase() === pluralize_english(stem)) {
					fks.push({
						column_name: col.name,
						referenced_table: table_name,
						referenced_column: "id",
						source: "inferred_naming",
						confidence: "high",
					});
					found = true;
					break;
				}
			}
		}

		// Fallback: if we still haven't found a match, use the heuristic
		// {stem} -> {stem}s.id (basic English pluralization)
		if (!found) {
			const stem = col_lower.replace(/_id$/, "");
			const guessed_table = pluralize_english(stem);

			// Only add with "medium" confidence if the guessed table actually exists
			if (table_column_map.has(guessed_table) && table_column_map.get(guessed_table)!.includes("id")) {
				fks.push({
					column_name: col.name,
					referenced_table: guessed_table,
					referenced_column: "id",
					source: "inferred_naming",
					confidence: "medium",
				});
			}
		}
	}

	return fks;
}

// ---------------------------------------------------------------------------
// View FK detection (parse view SQL JOIN conditions)
// ---------------------------------------------------------------------------

export function detect_view_foreign_keys(table_name: string, view_sql: string, all_schemas: SchemaObject[]): DdlCachedForeignKey[] {
	const fks: DdlCachedForeignKey[] = [];
	const seen_columns = new Set();

	// Normalize the SQL
	const sql = view_sql.replace(/\s+/g, " ").replace(/`/g, "").replace(/"/g, "");

	// Build alias -> table name map from FROM and JOIN clauses
	const alias_map = build_alias_map(sql);

	// The main table is typically the one in FROM
	const main_alias = get_main_table_alias(sql);

	// Parse JOIN conditions for FK patterns.
	// Handles: ON alias.col = alias.col and ON (alias.col = alias.col)
	// Pattern: ON <alias>.<col> = <alias>.<_id_col> or ON <alias>.<_id_col> = <alias>.<col>
	const on_regex = /ON\s*\(?\s*(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)\s*\)?/gi;
	let match: RegExpExecArray | null;

	while ((match = on_regex.exec(sql)) !== null) {
		const [, left_alias, left_col, right_alias, right_col] = match;

		// Determine which side is the FK column (the one ending in _id)
		const left_is_fk = left_col.endsWith("_id");
		const right_is_fk = right_col.endsWith("_id");

		if (left_is_fk && right_col === "id") {
			// Pattern: ON other.fk_col = alias.id  -> fk_col references alias.id
			// fk_alias is the left (has the *_id column), ref_alias is the right (has id)
			emit_view_fk(
				left_alias,
				left_col,
				right_alias,
				right_col,
				alias_map,
				table_name,
				fks,
				seen_columns
			);
		} else if (right_is_fk && left_col === "id") {
			// Pattern: ON alias.id = other.fk_col  -> fk_col references alias.id
			// fk_alias is the right (has the *_id column), ref_alias is the left (has id)
			emit_view_fk(
				right_alias,
				right_col,
				left_alias,
				left_col,
				alias_map,
				table_name,
				fks,
				seen_columns
			);
		} else if (left_is_fk && right_is_fk) {
			// Both end in _id - ambiguous, skip
			continue;
		}
	}

	// Also look for direct *_id column references in SELECT
	// e.g. SELECT f.author_id FROM frameworks f
	if (main_alias) {
		const select_regex = new RegExp(`${escape_regex(main_alias)}\\.([a-zA-Z_]\\w*_id)`, "gi");
		let select_match: RegExpExecArray | null;
		while ((select_match = select_regex.exec(sql)) !== null) {
			const col = select_match[1];
			const col_lower = col.toLowerCase();
			if (seen_columns.has(col_lower)) continue;

			// Try to infer the referenced table from the column name
			const stem = col_lower.replace(/_id$/, "");
			const guessed_table = pluralize_english(stem);
			const schema = all_schemas.find((s) => s.name.toLowerCase() === guessed_table);

			if (schema) {
				fks.push({
					column_name: col,
					referenced_table: schema.name,
					referenced_column: "id",
					source: "view_join",
					view_name: view_name_from_sql(sql),
					confidence: "medium",
				});
				seen_columns.add(col_lower);
			}
		}
	}

	return fks;
}

function emit_view_fk(fk_alias: string, fk_col: string, ref_alias: string, ref_col: string, alias_map: Map<string, string>, current_table: string, fks: DdlCachedForeignKey[], seen_columns: Set<string>): void {
	const fk_table = alias_map.get(fk_alias.toLowerCase());
	const ref_table = alias_map.get(ref_alias.toLowerCase());

	const col_lower = fk_col.toLowerCase();
	if (seen_columns.has(col_lower)) return;

	// The FK column must belong to the current table's alias
	if (!fk_table || fk_table !== current_table.toLowerCase()) return;
	if (!ref_table) return;

	fks.push({
		column_name: fk_col,
		referenced_table: ref_table,
		referenced_column: ref_col,
		source: "view_join",
		view_name: "",
		confidence: "exact",
	});
	seen_columns.add(col_lower);
}

const SQL_KEYWORDS = new Set([
	"on",
	"where",
	"order",
	"group",
	"having",
	"limit",
	"using",
	"natural",
	"offset",
	"returning",
	"for",
	"option",
	"union",
	"intersect",
	"except",
	"window",
	"qualify",
	"into",
	"values",
	"set",
	"select",
	"distinct",
	"all",
	"left",
	"right",
	"inner",
	"cross",
	"full",
	"outer",
	"join",
	"straight",
	"apply",
	"outer",
	"semi",
	"anti",
]);

export function build_alias_map(sql: string): Map<string, string> {
	const map = new Map();

	// Match FROM/JOIN clauses with explicit aliases
	// Handles parenthesized syntax from SHOW CREATE VIEW:
	// FROM (((table alias LEFT JOIN ...))) - MariaDB wraps JOIN trees in parens
	// Pattern: FROM/JOIN [optional parens] table_name [AS] alias
	const from_join_regex = /(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN|STRAIGHT_JOIN)\s*\(*\s*([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/gi;
	let match: RegExpExecArray | null;

	while ((match = from_join_regex.exec(sql)) !== null) {
		const table = match[1].toLowerCase();
		// If there's an explicit alias candidate, check it's not a SQL keyword
		if (match[2] && !SQL_KEYWORDS.has(match[2].toLowerCase())) {
			map.set(match[2].toLowerCase(), table);
		} else {
			map.set(table, table);
		}
	}

	return map;
}

export function get_main_table_alias(sql: string): string | null {
	// Handles parenthesized FROM: FROM (((table alias ...
	const from_match = sql.match(/\bFROM\s*\(*\s*([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/i);
	if (!from_match) return null;
	// If there's an explicit alias candidate, check it's not a SQL keyword
	// (e.g. "FROM frameworks LEFT JOIN ..." - "LEFT" is a keyword, not an alias)
	if (from_match[2] && !SQL_KEYWORDS.has(from_match[2].toLowerCase())) { return from_match[2].toLowerCase(); }
	return from_match[1].toLowerCase();
}

export function view_name_from_sql(sql: string): string {
	const match = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-zA-Z_]\w*)/i);
	return match ? match[1] : "unknown";
}
