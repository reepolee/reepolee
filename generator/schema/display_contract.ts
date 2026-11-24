import type { DdlCacheData, DdlCachedColumn, DdlCachedTable } from "../ddl_cache_types";
import type { ColumnDef, SchemaObject } from "./types";

const DISPLAY_FIELD = "display";
const OPTION_DISPLAY_FIELD = "option_display";
const STRING_TYPE_PARTS = ["char", "text", "clob"];

/** A column as seen by display resolution: its name plus the raw SQL type. */
export interface DisplayColumnCandidate {
	name: string;
	type_string?: string | null;
}

/**
 * Resolve the column used for option lists and dropdown text:
 * `option_display` when present, else `display` when present, else the first
 * non-binary string column in declaration order. The string-column fallback
 * keeps generated selects pointing at a real column even when a table or view
 * exposes neither canonical display column.
 */
export function resolve_option_display_field(columns: DisplayColumnCandidate[]): string {
	if (columns.some((column) => column.name === OPTION_DISPLAY_FIELD)) return OPTION_DISPLAY_FIELD;
	if (columns.some((column) => column.name === DISPLAY_FIELD)) return DISPLAY_FIELD;
	const string_column = columns.find((column) => is_non_binary_string_type(column.type_string));
	return string_column?.name ?? columns[0]?.name ?? DISPLAY_FIELD;
}

/** Whether a SQL type is a non-binary string family (char/varchar/text/clob, not binary/blob). */
export function is_non_binary_string_type(type_string: string | null | undefined): boolean {
	const normalized_type = (type_string ?? "").toLowerCase();
	return STRING_TYPE_PARTS.some((type_part) => normalized_type.includes(type_part))
		&& !normalized_type.includes("binary")
		&& !normalized_type.includes("blob");
}

function is_string_type(type_string: string): boolean {
	const normalized_type = type_string.toLowerCase();
	return STRING_TYPE_PARTS.some((type_part) => normalized_type.includes(type_part));
}

/**
 * Validate one display column. Display columns are optional - a table or view
 * without them is valid and falls back to natural string columns. When present
 * they must be string-compatible; on tables they must also be generated so
 * they stay readable but are excluded from create/update payloads.
 */
function validate_display_column(
	columns: ColumnDef[] | DdlCachedColumn[],
	object_name: string,
	column_name: string,
	require_generated: boolean,
): void {
	const column = columns.find((candidate) => candidate.name === column_name);
	if (!column) return;
	if (!is_string_type(column.type_string)) {
		throw new Error(`Display contract violation: "${object_name}.${column_name}" must be string-compatible, got "${column.type_string || "unknown"}".`);
	}
	if (require_generated && !column.is_generated) {
		throw new Error(`Display contract violation: "${object_name}.${column_name}" must be a generated column.`);
	}
}

function validate_display_columns(object_name: string, columns: ColumnDef[] | DdlCachedColumn[], require_generated: boolean): void {
	validate_display_column(columns, object_name, DISPLAY_FIELD, require_generated);
	validate_display_column(columns, object_name, OPTION_DISPLAY_FIELD, require_generated);
	// View denormalizations (<stem>_display) are optional too - generated
	// sort/search/grid code uses them only when present. When one does exist it
	// must be string-compatible so it can serve as readable text.
	if (!require_generated) {
		for (const column of columns) {
			if (column.name.toLowerCase().endsWith("_display") && !is_string_type(column.type_string)) {
				throw new Error(`Display contract violation: "${object_name}.${column.name}" must be string-compatible, got "${column.type_string || "unknown"}".`);
			}
		}
	}
}

export function validate_schema_display_contract(schemas: SchemaObject[]): void {
	for (const schema of schemas) {
		validate_display_columns(schema.name, schema.columns, schema.type === "table");
	}
}

function validate_cached_table_display_contract(table: DdlCachedTable): void {
	validate_display_columns(table.name, table.columns, true);
	if (table.has_view && table.view_columns) {
		validate_display_columns(table.view_name ?? `v_${table.name}`, table.view_columns, false);
	}
}

export function validate_ddl_cache_display_contract(cache: DdlCacheData): void {
	for (const table of cache.tables) {
		validate_cached_table_display_contract(table);
	}
}

/**
 * Collect every display contract violation instead of throwing on the first one.
 *
 * The throwing validators above are the contract's definition and stay that way for
 * callers that must refuse a bad schema (the studio's sandbox check, the server).
 * reeman needs the opposite: a schema that violates the contract is precisely when
 * the user needs reeman running, because "Run SQL file" is how the DDL gets fixed.
 * Throwing during startup introspection locks the user out of the repair tool.
 */
export function collect_schema_display_violations(schemas: SchemaObject[]): string[] {
	const violations: string[] = [];
	for (const schema of schemas) {
		try {
			validate_display_columns(schema.name, schema.columns, schema.type === "table");
		} catch (error) {
			violations.push(error instanceof Error ? error.message : String(error));
		}
	}
	return violations;
}

export function collect_ddl_cache_display_violations(cache: DdlCacheData): string[] {
	const violations: string[] = [];
	for (const table of cache.tables) {
		try {
			validate_cached_table_display_contract(table);
		} catch (error) {
			violations.push(error instanceof Error ? error.message : String(error));
		}
	}
	return violations;
}
