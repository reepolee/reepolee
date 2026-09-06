import { pluralize_english } from "$generator/naming";

import { get_studio_tables } from "./model";
import type { Dialect, StudioColumn, StudioFile, StudioTable } from "./types";

export interface SchemaAdaptationSummary {
	tables_adapted: string[];
	references_updated: string[];
	views_adapted: string[];
}

/** An `*_id` column with no table to point at - a naming problem only the operator can resolve. */
export interface DanglingIdColumn {
	table: string;
	column: string;
	/** Table the generator would infer from the column name, which does not exist. */
	expected_table: string;
	/** True when the column type is integer, which hints at a counter rather than a code. */
	is_integer: boolean;
}

const INTEGER_TYPE = /^(INT|INTEGER|BIGINT|SMALLINT|MEDIUMINT|TINYINT)\b/i;
const DISPLAY_SOURCE_PRIORITY = ["name", "title", "label"];

/**
 * Find `*_id` columns whose target table does not exist.
 *
 * The generator treats any `*_id` column as a foreign key and infers the target
 * by pluralizing the stem (`round_id` -> `rounds`). When that table is absent the
 * column is not a foreign key at all - it is a plain number or code that was named
 * `_id` by mistake, usually in a schema imported from another project. The
 * generator only discovers this late, during CRUD generation, as
 * `Table "rounds" is missing from the DDL cache.`
 *
 * This is reported, never auto-corrected: renaming a column changes the schema's
 * meaning and any application code reading it, so the operator decides.
 */
export function find_dangling_id_columns(model: StudioFile): DanglingIdColumn[] {
	const tables = get_studio_tables(model);
	const table_names = new Set(tables.map((table) => table.name.toLowerCase()));
	const dangling: DanglingIdColumn[] = [];

	for (const table of tables) {
		for (const column of table.columns) {
			const column_lower = column.name.toLowerCase();
			if (!column_lower.endsWith("_id")) continue;
			if (column_lower === "id") continue;

			// An explicit REFERENCES clause names its target, so nothing is inferred.
			if (column.references) continue;

			const stem = column_lower.slice(0, -3);
			if (resolves_to_table(stem, table_names)) continue;

			dangling.push({
				table: table.name,
				column: column.name,
				expected_table: pluralize_english(stem),
				is_integer: INTEGER_TYPE.test(column.type_string),
			});
		}
	}

	return dangling;
}

/**
 * Whether an `*_id` stem resolves to a real table, mirroring the generator's
 * inference: an exact name match, the pluralized stem, or a numbered stem
 * (`team_1_id` -> `teams`) as produced by multi-FK tables like `schedule`.
 */
function resolves_to_table(stem: string, table_names: Set<string>): boolean {
	if (table_names.has(stem)) return true;
	if (table_names.has(pluralize_english(stem))) return true;

	// `team_1_id` / `table_2_id` - strip the positional suffix and retry.
	const numbered = /^(.*)_\d+$/.exec(stem);
	if (numbered) {
		const base = numbered[1]!;
		if (table_names.has(base)) return true;
		if (table_names.has(pluralize_english(base))) return true;
	}
	return false;
}

/**
 * Adapt every table in the file to the standard Reepolee DDL shape:
 * integer `id` primary key (a non-integer PK is renamed to `code` and kept
 * as a unique natural key), plus `display`, `created_at`, and `updated_at`
 * columns. `display` is a convenience, not a requirement - the generator
 * works without it. Runs over the whole file in two passes so that
 * incoming FK columns/references can be repointed at a renamed PK before
 * any table is mutated.
 */
export function adapt_schema_to_standard(model: StudioFile): SchemaAdaptationSummary {
	const tables = get_studio_tables(model);
	const pk_renames = new Map<string, string>(); // table_name -> old PK column name (now "code")

	for (const table of tables) {
		const pk_column = table.columns.find((column) => column.is_primary_key);
		if (pk_column && pk_column.name !== "id" && !INTEGER_TYPE.test(pk_column.type_string)) {
			pk_renames.set(table.name, pk_column.name);
		}
	}

	const tables_adapted: string[] = [];
	for (const table of tables) {
		const changed = adapt_table_columns(table, model.dialect, pk_renames.has(table.name));
		if (changed) tables_adapted.push(table.name);
	}

	const references_updated: string[] = [];
	for (const table of tables) {
		for (const column of table.columns) {
			if (!column.references) continue;
			const old_pk_name = pk_renames.get(column.references.table);
			if (old_pk_name && column.references.column === old_pk_name) {
				column.references = { ...column.references, column: "id" };
				references_updated.push(`${table.name}.${column.name} -> ${column.references.table}.id`);
			}
		}
		for (const foreign_key of table.table_foreign_keys) {
			const old_pk_name = pk_renames.get(foreign_key.ref_table);
			if (old_pk_name && foreign_key.ref_column === old_pk_name) {
				foreign_key.ref_column = "id";
				references_updated.push(`${table.name}.${foreign_key.column} -> ${foreign_key.ref_table}.id`);
			}
		}
	}

	for (const statement of model.statements) {
		if (statement.table && tables_adapted.includes(statement.table.name)) statement.dirty = true;
	}

	// Views are never rewritten: display/_display columns are optional, and the
	// generator uses them only when they exist. A view without them works off
	// its natural string columns, so adaptation has nothing to add.
	return { tables_adapted, references_updated, views_adapted: [] };
}

/** Adapt one table's columns in place. Returns true if anything changed. */
function adapt_table_columns(table: StudioTable, dialect: Dialect, rename_pk_to_code: boolean): boolean {
	let changed = false;

	if (rename_pk_to_code) {
		const pk_column = table.columns.find((column) => column.is_primary_key)!;
		pk_column.name = "code";
		pk_column.is_primary_key = false;
		pk_column.is_unique = true;
		pk_column.name_pad = undefined;
		pk_column.modifier_order = pk_column.modifier_order.filter((key) => key !== "primary_key");
		if (!pk_column.modifier_order.includes("unique")) pk_column.modifier_order.push("unique");
		table.columns.unshift(make_id_column(dialect));
		changed = true;
	} else if (!table.columns.some((column) => column.name === "id")) {
		table.columns.unshift(make_id_column(dialect));
		changed = true;
	}

	if (!table.columns.some((column) => column.name === "display")) {
		const source = find_display_source(table);
		table.columns.push(make_display_column(dialect, source));
		changed = true;
	}

	if (!table.columns.some((column) => column.name === "created_at")) {
		table.columns.push(make_timestamp_column("created_at", dialect));
		changed = true;
	}

	if (!table.columns.some((column) => column.name === "updated_at")) {
		table.columns.push(make_timestamp_column("updated_at", dialect));
		changed = true;
	}

	return changed;
}

/** First column matching the display-source priority (name, title, label), else the first non-id/code string column. */
function find_display_source(table: StudioTable): string {
	for (const candidate of DISPLAY_SOURCE_PRIORITY) {
		if (table.columns.some((column) => column.name === candidate)) return candidate;
	}
	const string_column = table.columns.find((column) => !["id", "code"].includes(column.name) && /CHAR|TEXT/i.test(column.type_string));
	return string_column?.name ?? "id";
}

function make_id_column(dialect: Dialect): StudioColumn {
	if (dialect === "mysql") {
		return {
			name: "id",
			type_string: "INT UNSIGNED",
			domain_type: "pk_id",
			nullability: "not_null",
			default_value: null,
			is_primary_key: true,
			is_auto_increment: true,
			is_unique: false,
			is_generated: false,
			on_update_current_timestamp: false,
			modifier_order: ["nullability", "auto_increment", "primary_key"],
		};
	}
	return {
		name: "id",
		type_string: "INTEGER",
		domain_type: "pk_id",
		nullability: "unspecified",
		default_value: null,
		is_primary_key: true,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: false,
		modifier_order: ["primary_key"],
	};
}

function make_display_column(dialect: Dialect, source: string): StudioColumn {
	const type_string = dialect === "mysql" ? "VARCHAR(255)" : "TEXT";
	return {
		name: "display",
		type_string,
		domain_type: "varchar",
		nullability: "unspecified",
		default_value: null,
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: true,
		generated_expr: source,
		generated_kind: "VIRTUAL",
		generated_as_pad: " ",
		on_update_current_timestamp: false,
		modifier_order: ["generated"],
	};
}

function make_timestamp_column(name: "created_at" | "updated_at", dialect: Dialect): StudioColumn {
	const on_update = name === "updated_at" && dialect === "mysql";
	const modifier_order = dialect === "mysql"
		? (on_update ? ["nullability", "default", "on_update"] as const : ["nullability", "default"] as const)
		: ["default"] as const;
	return {
		name,
		type_string: "TIMESTAMP",
		domain_type: "timestamp",
		nullability: dialect === "mysql" ? "not_null" : "unspecified",
		default_value: "CURRENT_TIMESTAMP",
		is_primary_key: false,
		is_auto_increment: false,
		is_unique: false,
		is_generated: false,
		on_update_current_timestamp: on_update,
		modifier_order: [...modifier_order],
	};
}
