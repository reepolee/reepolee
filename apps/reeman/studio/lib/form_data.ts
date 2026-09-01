import { get_domain_types } from "./domain_types";
import { detect_soft_reference, StudioError } from "./model";
import { parse_column } from "./column_parser";
import type { ColumnReference, Dialect, ModifierKey, StudioColumn, StudioFile, StudioTable, TableForeignKey, TableUniqueKey } from "./types";

const MAX_COLUMNS = 200;
const COLUMN_NAME = /^[a-z][a-z0-9_]*$/;
const REFERENCE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/;

const MODIFIER_ORDER: ModifierKey[] = [
	"nullability",
	"auto_increment",
	"primary_key",
	"default",
	"unique",
	"generated",
	"on_update",
	"references",
	"comment",
];

/**
 * Parse the column editor form into a table.
 *
 * `source_indexes_out`, when provided, is filled with each edited column's index
 * in `source.columns` (null for newly added columns). Callers use it to recover
 * renames, which must be propagated into raw statements the studio cannot edit.
 */
export function parse_table_form(params: URLSearchParams, source: StudioTable, dialect: Dialect, tables: StudioTable[] = [source], source_indexes_out?: (number | null)[]): StudioTable {
	const values = read_column_values(params);
	if (values.sources.length === 0) throw new StudioError("A table must contain at least one column.");
	if (values.sources.length > MAX_COLUMNS) throw new StudioError(`A table may contain at most ${MAX_COLUMNS} columns.`);

	const lengths = Object.values(values).map((items) => items.length);
	if (!lengths.every((length) => length === values.sources.length)) throw new StudioError("Incomplete column form data.");

	const used_sources = new Set<number>();
	const columns = values.sources.map((source_value, index) => {
		const source_index = source_value === "new" ? null : Number(source_value);
		if (source_indexes_out) source_indexes_out.push(source_index);
		let column: StudioColumn;
		let original_reference: ColumnReference | undefined;
		let preserve_external_reference = false;
		if (source_index === null) {
			column = empty_column();
		} else {
			if (!Number.isInteger(source_index) || source_index < 0 || source_index >= source.columns.length || used_sources.has(source_index)) {
				throw new StudioError("Invalid column source.");
			}
			used_sources.add(source_index);
			column = structuredClone(source.columns[source_index]!);
			original_reference = effective_reference(source, column) ?? detect_soft_reference(column.name, tables) ?? undefined;
			preserve_external_reference = !column.references && original_reference !== undefined;
		}
		return apply_column_values(column, values, index, dialect, original_reference, preserve_external_reference);
	});

	const names = columns.map((column) => column.name);
	if (new Set(names).size !== names.length) throw new StudioError("Column names must be unique.");
	if (columns.filter((column) => column.domain_type === "pk_id").length > 1) {
		throw new StudioError("A table may contain only one pk_id domain.");
	}

	const table_foreign_keys = retained_table_foreign_keys(source, columns, values);
	const table_unique_keys = retained_table_unique_keys(source, columns, values);
	return { ...structuredClone(source), columns, table_foreign_keys, table_unique_keys };
}

function read_column_values(params: URLSearchParams) {
	return {
		sources: params.getAll("column_source"),
		names: params.getAll("column_name"),
		domains: params.getAll("column_domain"),
		preserve_types: params.getAll("column_preserve_type"),
		nullabilities: params.getAll("column_nullability"),
		defaults: params.getAll("column_default"),
		auto_increments: params.getAll("column_auto_increment"),
		uniques: params.getAll("column_unique"),
		generated: params.getAll("column_generated"),
		generated_exprs: params.getAll("column_generated_expr"),
		references: params.getAll("column_reference"),
	};
}

function apply_column_values(
	column: StudioColumn,
	values: ReturnType<typeof read_column_values>,
	index: number,
	dialect: Dialect,
	original_reference?: ColumnReference,
	preserve_external_reference = false,
): StudioColumn {
	const original_name = column.name;
	const original_type = column.type_string;
	const name = values.names[index]!.trim();
	if (!COLUMN_NAME.test(name)) throw new StudioError(`Invalid column name: ${name || "(empty)"}`);

	const domain_name = values.domains[index]!.trim();
	const domain = get_domain_types(dialect).find((item) => item.name === domain_name);
	const preserve_value = values.preserve_types[index];
	if (preserve_value !== "0" && preserve_value !== "1") throw new StudioError(`Invalid SQL type mode for ${name}.`);
	const preserve_type = preserve_value === "1";
	if (!domain && !(preserve_type && column.domain_type == null)) throw new StudioError(`Select a predefined domain type for ${name}.`);
	if (preserve_type && domain && column.domain_type !== domain.name) throw new StudioError(`Invalid preserved domain type for ${name}.`);
	const parsed_domain = domain ? parse_column(`studio_domain ${domain.sql_type}`) : null;
	if (domain && !parsed_domain) throw new StudioError(`Invalid configured domain type: ${domain.name}.`);
	const type_string = preserve_type ? original_type : parsed_domain!.type_string;
	const comment = preserve_type ? column.comment : parsed_domain!.comment ?? (column.comment === "MARKDOWN" ? undefined : column.comment);

	const nullability = values.nullabilities[index];
	if (nullability !== "not_null" && nullability !== "null" && nullability !== "unspecified") {
		throw new StudioError(`Invalid nullability for ${name}.`);
	}

	const reference_value = values.references[index]!.trim();
	let reference_match = reference_value ? REFERENCE.exec(reference_value) : null;
	if (reference_value && !reference_match) throw new StudioError(`Invalid reference for ${name}; use table.column.`);
	// The client clears the FK select whenever the domain moves away from
	// foreign_key, but the two fields update independently in the DOM - drop a
	// reference that outlived its domain instead of hard-failing the whole
	// preview/save on what is a client-side sync lag, not a real user error.
	if (reference_match && domain?.name !== "foreign_key") reference_match = null;

	column.name = name;
	column.type_string = type_string;
	column.domain_type = domain?.name ?? null;
	column.nullability = nullability === "unspecified" ? (parsed_domain?.nullability ?? column.nullability) : nullability;
	column.default_value = values.defaults[index]!.trim() || null;
	column.is_primary_key = domain ? domain.name === "pk_id" : column.is_primary_key;
	column.is_auto_increment = values.auto_increments[index] === "1" || parsed_domain?.is_auto_increment === true;
	column.is_unique = values.uniques[index] === "1" || parsed_domain?.is_unique === true;
	column.is_generated = values.generated[index] === "1";
	column.generated_expr = values.generated_exprs[index]!.trim() || undefined;
	column.generated_kind = column.is_generated ? (column.generated_kind ?? "VIRTUAL") : undefined;
	column.generated_as_pad = column.is_generated ? (column.generated_as_pad ?? " ") : undefined;
	const same_reference = original_reference && reference_match && original_reference.table === reference_match[1] && original_reference.column === reference_match[2];
	column.references = reference_match && !(same_reference && preserve_external_reference) ? {
		table: reference_match[1]!,
		column: reference_match[2]!,
		...(same_reference ? { on_update: original_reference.on_update, on_delete: original_reference.on_delete } : {}),
	} : undefined;
	column.comment = comment;
	column.modifier_order = normalized_modifier_order(column);
	if (name !== original_name) column.name_pad = undefined;
	if (type_string !== original_type) column.type_pad = undefined;
	return column;
}

export function validate_table_references(table: StudioTable, model: StudioFile): void {
	for (const column of table.columns) {
		if (!column.references) continue;
		const target = column.references.table === table.name
			? table
			: model.statements.find((item) => item.table?.name === column.references!.table)?.table;
		if (!target?.columns.some((candidate) => candidate.name === column.references!.column)) {
			throw new StudioError(`Reference target not found for ${column.name}: ${column.references.table}.${column.references.column}`);
		}
	}
	for (const foreign_key of table.table_foreign_keys) {
		if (!table.columns.some((column) => column.name === foreign_key.column)) {
			throw new StudioError(`Foreign-key column not found: ${foreign_key.column}`);
		}
		const target = foreign_key.ref_table === table.name
			? table
			: model.statements.find((item) => item.table?.name === foreign_key.ref_table)?.table;
		if (!target?.columns.some((column) => column.name === foreign_key.ref_column)) {
			throw new StudioError(`Reference target not found for ${foreign_key.column}: ${foreign_key.ref_table}.${foreign_key.ref_column}`);
		}
	}
}

export function column_reference_value(table: StudioTable, column: StudioColumn, tables: StudioTable[] = [table]): string {
	const soft = column.domain_type && column.domain_type !== "foreign_key" ? null : detect_soft_reference(column.name, tables);
	const reference = effective_reference(table, column) ?? soft;
	return reference ? `${reference.table}.${reference.column}` : "";
}

function effective_reference(table: StudioTable, column: StudioColumn): ColumnReference | undefined {
	if (column.references) return column.references;
	const foreign_key = table.table_foreign_keys.find((item) => item.column === column.name);
	if (!foreign_key) return undefined;
	return table_reference(foreign_key);
}

function table_reference(foreign_key: TableForeignKey): ColumnReference {
	return {
		table: foreign_key.ref_table,
		column: foreign_key.ref_column,
		on_update: foreign_key.on_update,
		on_delete: foreign_key.on_delete,
	};
}

function retained_table_foreign_keys(
	source: StudioTable,
	columns: StudioColumn[],
	values: ReturnType<typeof read_column_values>,
): TableForeignKey[] {
	return source.table_foreign_keys.flatMap((foreign_key) => {
		const source_index = source.columns.findIndex((column) => column.name === foreign_key.column);
		const output_index = values.sources.findIndex((value) => value === String(source_index));
		if (output_index === -1) return [];
		const expected = `${foreign_key.ref_table}.${foreign_key.ref_column}`;
		if (values.references[output_index]!.trim() !== expected) return [];
		return [{ ...foreign_key, column: columns[output_index]!.name }];
	});
}

function retained_table_unique_keys(
	source: StudioTable,
	columns: StudioColumn[],
	values: ReturnType<typeof read_column_values>,
): TableUniqueKey[] {
	return source.table_unique_keys.flatMap((unique_key) => {
		const renamed_columns: string[] = [];
		for (const column_name of unique_key.columns) {
			const source_index = source.columns.findIndex((column) => column.name === column_name);
			const output_index = values.sources.findIndex((value) => value === String(source_index));
			if (output_index === -1) return [];
			renamed_columns.push(columns[output_index]!.name);
		}
		return [{ ...unique_key, columns: renamed_columns }];
	});
}

function normalized_modifier_order(column: StudioColumn): ModifierKey[] {
	const order = [...column.modifier_order];
	for (const key of MODIFIER_ORDER) if (!order.includes(key)) order.push(key);
	return order;
}

function empty_column(): StudioColumn {
	return {
		name: "new_column",
		type_string: "TEXT",
		domain_type: null,
		nullability: "unspecified",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		modifier_order: [...MODIFIER_ORDER],
	};
}
