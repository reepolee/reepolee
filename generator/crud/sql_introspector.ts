/**
 * SQL Introspector - DB introspection functions extracted from sql_ts.ts.
 *
 * Handles view detection, view dependency analysis, and text field discovery
 * from the database for CRUD SQL code generation.
 */

import { log_step } from "./helpers";

// ---------------------------------------------------------------------------
// View existence check
// ---------------------------------------------------------------------------

const _view_cache = new Map();

export async function check_view_exists(fk_table: string): Promise<boolean> {
	const cached = _view_cache.get(fk_table);
	if (cached !== undefined) return cached;

	log_step(`check_view_exists: checking view "v_${fk_table}" for table "${fk_table}" (via cache)`);

	try {
		const { load_ddl_cache, get_cached_table } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const table = get_cached_table(cache, fk_table);
		const exists = table?.has_view ?? false;

		log_step(`check_view_exists: view "v_${fk_table}" ${exists ? "exists" : "does not exist"} (cache)`);
		_view_cache.set(fk_table, exists);
		return exists;
	} catch (error) {
		log_step(`check_view_exists: error checking for "v_${fk_table}": ${error instanceof Error ? error.message : error}`);
		_view_cache.set(fk_table, false);
		return false;
	}
}

export function clear_view_cache(): void { _view_cache.clear(); }

// ---------------------------------------------------------------------------
// View dependency inference
// ---------------------------------------------------------------------------

/**
 * Parse table names from a CREATE VIEW SQL statement by extracting
 * identifiers from FROM and JOIN clauses.
 * Returns only distinct table names (lowercase).
 */
export function parse_view_tables(view_sql: string): string[] {
	const sql = view_sql.replace(/\s+/g, " ").replace(/`/g, "").replace(/"/g, "");

	const tables = new Set();

	const from_match = sql.match(/\bFROM\s+(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/i);
	if (from_match) { tables.add(from_match[1].toLowerCase()); }

	const join_regex = /(?:LEFT|RIGHT|INNER|CROSS|FULL|STRAIGHT_JOIN)?\s*JOIN\s+(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gi;
	let join_match: RegExpExecArray | null;
	while ((join_match = join_regex.exec(sql)) !== null) {
		tables.add(join_match[1].toLowerCase());
	}

	return Array.from(tables);
}

export async function get_view_dependencies(table_name: string): Promise<string[]> {
	try {
		const { load_ddl_cache, get_cached_table } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const table = get_cached_table(cache, table_name);

		if (!table?.has_view || !table.view_definition) { return [table_name]; }

		const parsed = parse_view_tables(table.view_definition);
		log_step(`get_view_dependencies: view "v_${table_name}" depends on [${parsed.join(", ")}]`);
		return parsed;
	} catch (error) {
		log_step(`get_view_dependencies: error for "${table_name}": ${error instanceof Error ? error.message : error}`);
		return [table_name];
	}
}

// ---------------------------------------------------------------------------
// Text field discovery for FK tables
// ---------------------------------------------------------------------------

export async function get_text_field_from_db(fk_table: string): Promise<string> {
	log_step(`get_text_field_from_db called for: ${fk_table}`);
	try {
		const { load_ddl_cache, get_cached_table } = await import("../ddl_cache");
		const cache = await load_ddl_cache();
		const table = get_cached_table(cache, fk_table);

		if (!table || table.columns.length === 0) {
			log_step(`get_text_field_from_db: table "${fk_table}" not found in DDL cache, returning "name"`);
			return "name";
		}

		const column_names = table.columns.map((c) => c.name);
		log_step(`get_text_field_from_db: ${fk_table} has columns: [${column_names.join(", ")}]`);

		// Preferred display fields (ordered by preference)
		const preferred_fields = [
			"name",
			"title",
			"search_text",
			"label",
			"description",
			"email",
			"full_name",
			"display_name",
			"username",
		];

		// First pass: check preferred field names in order of priority
		for (const field of preferred_fields) {
			if (column_names.includes(field)) {
				log_step(`get_text_field_from_db: found preferred field "${field}" for ${fk_table}`);
				return field;
			}
		}

		// Second pass: find the first non-id text/varchar/char column from cached type info
		const text_type_prefixes = ["varchar", "char", "text", "varying"];
		for (const col of table.columns) {
			if (col.name === "id") continue;
			const type_lower = col.type_string.toLowerCase();
			if (text_type_prefixes.some((p) => type_lower.startsWith(p) || type_lower.includes(p))) {
				log_step(`get_text_field_from_db: found text column "${col.name}" (${col.type_string}) for ${fk_table}`);
				return col.name;
			}
		}

		log_step(`get_text_field_from_db: no suitable text column found for ${fk_table}, returning "name"`);
		return "name";
	} catch (error) {
		log_step(`get_text_field_from_db: caught error for ${fk_table}: ${error instanceof Error ? error.message : error}`);
	}

	log_step(`get_text_field_from_db: returning default "name" for ${fk_table}`);
	return "name";
}
