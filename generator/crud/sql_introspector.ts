/**
 * SQL Introspector - DB introspection functions extracted from sql_ts.ts.
 *
 * Handles view dependency analysis and canonical display-source resolution
 * from the database for CRUD SQL code generation.
 */

import { ARCHIVE_TIMESTAMP_FIELD } from "$config/db_structure";

import { resolve_option_display_field } from "../schema/display_contract";
import { log_step } from "./helpers";

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

	const tables = new Set<string>();

	const from_match = sql.match(/\bFROM\s+(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/i);
	if (from_match) { tables.add(from_match[1]!.toLowerCase()); }

	const join_regex = /(?:LEFT|RIGHT|INNER|CROSS|FULL|STRAIGHT_JOIN)?\s*JOIN\s+(?:[a-zA-Z_]\w*\.)?([a-zA-Z_]\w*)/gi;
	let join_match: RegExpExecArray | null;
	while ((join_match = join_regex.exec(sql)) !== null) {
		tables.add(join_match[1]!.toLowerCase());
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
// Display field resolution
// ---------------------------------------------------------------------------

export interface DisplaySource {
	source_name: string;
	option_field: "display" | "option_display";
	search_field: "display" | "option_display" | "search_text";
	/** Whether the resolved source exposes `archived_at`, so FK dropdowns and
	 * autocomplete lookups over it can exclude archived rows. A view only
	 * qualifies if it selects the column through from its base table. */
	has_archive: boolean;
}

export async function resolve_display_source(table_name: string, prefer_view: boolean): Promise<DisplaySource> {
	const { load_ddl_cache, get_cached_table } = await import("../ddl_cache");
	const cache = await load_ddl_cache();
	const table = get_cached_table(cache, table_name);
	if (!table) { throw new Error(`Table "${table_name}" is missing from the DDL cache.`); }

	const use_view = prefer_view && table.has_view;
	const columns = use_view ? table.view_columns : table.columns;
	const object_name = use_view ? table.view_name : table.name;
	if (!columns || !object_name) { throw new Error(`Display contract violation: view "v_${table_name}" is unavailable.`); }

	const column_names = columns.map((column) => column.name);
	const option_field = resolve_option_display_field(column_names);
	const search_field = column_names.includes("search_text") ? "search_text" : option_field;
	const has_archive = column_names.includes(ARCHIVE_TIMESTAMP_FIELD);
	log_step(`resolve_display_source: ${object_name} uses option="${option_field}", search="${search_field}", archive=${has_archive}`);
	return { source_name: object_name, option_field, search_field, has_archive };
}
