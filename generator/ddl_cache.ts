/**
 * DDL Cache - Database Structure Cache.
 *
 * When the reeman or generators CLI starts, this module inspects the entire database,
 * detects all foreign key relationships (native DDL, implicit *_id naming, and
 * view join patterns), and holds the result in memory. Subsequent reads during the
 * same process use the cached data without re-querying the database.
 *
 * Usage:
 * import { load_ddl_cache, get_cached_tables, get_cached_table } from "./ddl_cache";
 * const cache = await load_ddl_cache();
 * const tables = get_cached_tables(cache);
 * const frameworks = get_cached_table(cache, "frameworks");
 *
 * The cache is per-process and lives only in memory. There is deliberately no
 * on-disk cache: schema changes are normally made outside the generators (direct
 * mysql/sqlite3 calls, migration tools), so a cache surviving process exit would
 * hand generation a schema the database no longer has. Every entry point
 * introspects once at startup and shares that snapshot with its downstream readers.
 */

import { require_env } from "$lib/env";
import { db_type } from "$lib/resolve_db_type";
import { SQL } from "bun";

import { escape_regex } from "./crud/helpers";
import { pluralize_english, singularize } from "./naming";
import { collect_ddl_cache_display_violations, collect_schema_display_violations } from "./schema/display_contract";
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

// Tables/views whose names start with this prefix are excluded from the cache.
const INTERNAL_PREFIXES = ["_", "sqlite_"];

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
 * Returns the in-memory snapshot when one exists, otherwise introspects the full
 * database, detects FKs (native + implicit + view), and caches the result for the
 * rest of the process.
 *
 * Pass { force_refresh: true } to discard the snapshot and re-introspect.
 */
export async function load_ddl_cache(options: { force_refresh?: boolean; } = {}): Promise<DdlCacheData> {
	if (_cached_data && !options.force_refresh) { return _cached_data; }

	// Introspect the database
	console.log(`[DDL Cache] Introspecting ${db_type.toUpperCase()} database...`);
	const data = await introspect_database();

	// Verify locale tables BEFORE the snapshot is published (D10). A drifted schema
	// captured here would be inherited by every generation in the session, so the
	// cache is only ever built from a schema known to be consistent.
	await verify_locale_tables(data);

	_cached_data = data;
	console.log(`[DDL Cache] Cached ${data.tables.length} tables with FK relationships.`);
	return data;
}

/**
 * How a drifted schema is reported. reeman and the generators offer a repair
 * (the user is present and `sync-locale-tables` is one command away); a
 * caller can opt into failing instead via `set_locale_drift_mode("fail")` -
 * a drifted locale table silently serves wrong data for one locale.
 */
export type LocaleDriftMode = "warn" | "fail";

let _locale_drift_mode: LocaleDriftMode = "warn";

export function set_locale_drift_mode(mode: LocaleDriftMode): void { _locale_drift_mode = mode; }

/**
 * How a display contract violation is reported. Same split as locale drift:
 * reeman warns (the user is present, and "Run SQL file" is how the DDL gets
 * repaired - throwing here would remove the only tool that can fix it).
 */
export type DisplayContractMode = "warn" | "fail";

let _display_contract_mode: DisplayContractMode = "warn";

export function set_display_contract_mode(mode: DisplayContractMode): void { _display_contract_mode = mode; }

function report_display_violations(violations: string[], stage: string): void {
	if (violations.length === 0) return;

	const detail_lines = violations.map((violation) => `  - ${violation}`).join("\n");
	if (_display_contract_mode === "fail") {
		console.error(`\n\x1b[31m✗ Display contract violations (${stage}):\n${detail_lines}\x1b[0m\n`);
		throw new Error("Display contract violations");
	}
	console.warn(`\n\x1b[33m⚠ Display contract violations (${stage}) - generated CRUD for these objects will be wrong until the DDL is fixed:\n${detail_lines}\n  Fix the schema, then re-run. Reeman continues so "Run SQL file" is available.\x1b[0m\n`);
}

async function verify_locale_tables(data: DdlCacheData): Promise<void> {
	try {
		const [{ check_locale_tables, locale_drift_message }, { discover_localized_tables }, config] = await Promise.all([
			import("./locale_tables/check"),
			import("./locale_tables/run"),
			import("$config/supported_locales"),
		]);

		const localized_tables = await discover_localized_tables();
		if (localized_tables.length === 0) return;

		const localized_by_table = new Map<string, readonly string[]>();
		for (const info of localized_tables) localized_by_table.set(info.table_name, info.localized_field_names);

		const { all_schemas } = ddl_cache_to_schema_objects(data);
		const drift = check_locale_tables({
			all_schemas,
			localized_by_table,
			locale_codes: config.locales,
			default_locale_code: config.default_locale,
		});
		if (drift.length === 0) return;

		const message = locale_drift_message(drift);
		if (_locale_drift_mode === "fail") {
			console.error(`\n\x1b[31m✗ ${message}\x1b[0m\n`);
			throw new Error("Locale tables are out of sync");
		}
		console.warn(`\n\x1b[33m⚠ ${message}\x1b[0m\n`);
	} catch (error) {
		if (error instanceof Error && error.message === "Locale tables are out of sync") throw error;
		// A check that cannot run must not block introspection - it is a guard,
		// not a dependency.
		console.warn(`[DDL Cache] Locale table check skipped: ${error instanceof Error ? error.message : error}`);
	}
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
 */
export function invalidate_cache(): void {
	_cached_data = null;
}

// ---------------------------------------------------------------------------
// Full database introspection
// ---------------------------------------------------------------------------

async function introspect_database(): Promise<DdlCacheData> {
	const url = require_env("DEV_CONNECTION_STRING");
	const db = new SQL(url);

	try {
		const introspector = db_type === "mysql" ? new MySQLIntrospector(db) : new SQLiteIntrospector(db);

		const all_schemas = await introspector.get_database_schema();
		const all_indexes = await introspector.get_all_indexes();
		const broken_views = introspector.broken_views;
		const schema_violations = collect_schema_display_violations(all_schemas);
		report_display_violations(schema_violations, "tables and views");

		// A broken view means the DDL is inconsistent - surface it (the reeman
		// UI banner reads this field) instead of only logging the skip.
		if (broken_views.length > 0) {
			console.warn(`[DDL Cache] ${broken_views.length} broken view(s) skipped: ${broken_views.join(", ")} - repair the DDL (reeman /database) so the views work again.`);
		}

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
				unique_columns: schema.unique_columns,
				primary_key: schema.primary_key,
			});
		}

		const cache = { generated_at: new Date().toISOString(), db_type, tables, broken_views };
		const cache_violations = collect_ddl_cache_display_violations(cache);
		report_display_violations(cache_violations, "FK display fields");
		return cache;
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
			unique_columns: table.unique_columns,
			has_view: table.has_view,
			primary_key: table.primary_key,
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
		// {stem} -> {stem}s.id (basic English pluralization).
		// Role-prefixed columns (first_table_id, second_team_id) pluralize to a
		// table that does not exist, so the stem is walked from longest to
		// shortest - dropping one leading segment at a time - and the first
		// candidate that is a real table wins. Confidence drops to "medium"
		// only for the exact stem; a prefix-stripped match is weaker still but
		// verified to exist, which is what keeps CRUD generation from
		// requesting a phantom table from the cache.
		if (!found) {
			const stem = col_lower.replace(/_id$/, "");
			const segments = stem.split("_");

			for (let start = 0; start < segments.length; start++) {
				const candidate_stem = segments.slice(start).join("_");
				const guessed_table = pluralize_english(candidate_stem);
				const target_columns = table_column_map.get(guessed_table);

				// Only add if the guessed table actually exists and has an id
				if (target_columns?.includes("id")) {
					fks.push({
						column_name: col.name,
						referenced_table: guessed_table,
						referenced_column: "id",
						source: "inferred_naming",
						confidence: start === 0 ? "medium" : "low",
					});
					break;
				}
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
	const seen_columns = new Set<string>();

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
		const [, left_alias, left_col, right_alias, right_col] = match as unknown as [string, string, string, string, string];

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
			const col = select_match[1]!;
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
	const map = new Map<string, string>();

	// Match FROM/JOIN clauses with explicit aliases
	// Handles parenthesized syntax from SHOW CREATE VIEW:
	// FROM (((table alias LEFT JOIN ...))) - MariaDB wraps JOIN trees in parens
	// Pattern: FROM/JOIN [optional parens] table_name [AS] alias
	const from_join_regex = /(?:FROM|JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|INNER\s+JOIN|CROSS\s+JOIN|FULL\s+JOIN|STRAIGHT_JOIN)\s*\(*\s*([a-zA-Z_]\w*)(?:\s+(?:AS\s+)?([a-zA-Z_]\w*))?/gi;
	let match: RegExpExecArray | null;

	while ((match = from_join_regex.exec(sql)) !== null) {
		const table = match[1]!.toLowerCase();
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
	return from_match[1]!.toLowerCase();
}

export function view_name_from_sql(sql: string): string {
	const match = sql.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-zA-Z_]\w*)/i);
	return match ? match[1]! : "unknown";
}
