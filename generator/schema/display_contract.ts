import type { DdlCacheData, DdlCachedColumn, DdlCachedTable } from "../ddl_cache_types";
import type { ColumnDef, SchemaObject } from "./types";

const DISPLAY_FIELD = "display";
const OPTION_DISPLAY_FIELD = "option_display";
const STRING_TYPE_PARTS = ["char", "text", "clob"];

export function resolve_option_display_field(column_names: string[]): "display" | "option_display" {
	return column_names.includes(OPTION_DISPLAY_FIELD) ? OPTION_DISPLAY_FIELD : DISPLAY_FIELD;
}

function is_string_type(type_string: string): boolean {
	const normalized_type = type_string.toLowerCase();
	return STRING_TYPE_PARTS.some((type_part) => normalized_type.includes(type_part));
}

function validate_display_column(
	columns: ColumnDef[] | DdlCachedColumn[],
	object_name: string,
	column_name: string,
	required: boolean,
	require_generated: boolean,
): void {
	const column = columns.find((candidate) => candidate.name === column_name);
	if (!column) {
		if (!required) return;
		throw new Error(`Display contract violation: "${object_name}" must expose a "${column_name}" string column.`);
	}
	if (!is_string_type(column.type_string)) {
		throw new Error(`Display contract violation: "${object_name}.${column_name}" must be string-compatible, got "${column.type_string || "unknown"}".`);
	}
	if (require_generated && !column.is_generated) {
		throw new Error(`Display contract violation: "${object_name}.${column_name}" must be a generated column.`);
	}
}

function validate_display_columns(object_name: string, columns: ColumnDef[] | DdlCachedColumn[], require_generated: boolean): void {
	validate_display_column(columns, object_name, DISPLAY_FIELD, true, require_generated);
	validate_display_column(columns, object_name, OPTION_DISPLAY_FIELD, false, require_generated);
}

export function validate_schema_display_contract(schemas: SchemaObject[]): void {
	for (const schema of schemas) {
		validate_display_columns(schema.name, schema.columns, schema.type === "table");
	}
}

function validate_view_fk_displays(table: DdlCachedTable): void {
	if (!table.has_view || !table.view_columns) return;
	const view_column_names = new Set(table.view_columns.map((column) => column.name));
	const foreign_keys = [...table.foreign_keys, ...table.inferred_foreign_keys, ...table.view_foreign_keys];
	const checked_fields = new Set<string>();

	for (const foreign_key of foreign_keys) {
		if (checked_fields.has(foreign_key.column_name)) continue;
		checked_fields.add(foreign_key.column_name);
		if (!foreign_key.column_name.endsWith("_id")) continue;
		if (!view_column_names.has(foreign_key.column_name)) continue;

		const stem = foreign_key.column_name.slice(0, -3);
		const display_field = `${stem}_display`;
		if (!view_column_names.has(display_field)) {
			throw new Error(`Display contract violation: "${table.view_name}" must expose "${display_field}" for FK "${foreign_key.column_name}".`);
		}
	}
}

function validate_cached_table_display_contract(table: DdlCachedTable): void {
	validate_display_columns(table.name, table.columns, true);
	if (table.has_view && table.view_columns) {
		validate_display_columns(table.view_name ?? `v_${table.name}`, table.view_columns, false);
		validate_view_fk_displays(table);
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
