/**
 * What a locale table is supposed to look like.
 *
 * A locale table is a structural clone of its base table (D4): same columns,
 * same types, base-table FK targets, plus two provenance sidecars per
 * localized field (D7).
 *
 * This module computes the EXPECTATION only. Applying it is the syncer's job
 * (sync.ts) and reporting the difference is the consistency check's job
 * (compare.ts) - both derive from here so they can never disagree about what
 * a locale table should be.
 */

import { locale_table_name } from "../naming";
import type { ColumnDef, ForeignKeyDef, SchemaObject } from "../schema/types";

/** A column the locale table must have, in the dialect's own type language. */
export interface ExpectedColumn {
	name: string;
	type_string: string;
	is_nullable: boolean;
	is_primary_key: boolean;
	/** Provenance sidecars are added by us, not cloned from the base table. */
	is_sidecar: boolean;
	/**
	 * Cloned generated columns keep their generated-ness: the expression is
	 * copied verbatim, so the clone computes the same value from its own row.
	 */
	is_generated: boolean;
	/**
	 * Cloned verbatim from the base table. A NOT NULL column whose value comes
	 * from a default (created_at) is never supplied by the write fan-out, so
	 * dropping the default would make every clone insert fail.
	 */
	default_value?: string | null;
}

export interface ExpectedForeignKey {
	column_name: string;
	referenced_table: string;
	referenced_column: string;
}

export interface ExpectedTable {
	/** Physical name, e.g. "frameworks_sl_si". */
	name: string;
	locale_code: string;
	base_table: string;
	columns: ExpectedColumn[];
	foreign_keys: ExpectedForeignKey[];
}

/**
 * The id column must never auto-increment on a clone: the base table assigns
 * the id and every clone takes it verbatim (D3). An AUTOINCREMENT clone would
 * mint its own ids and break the cross-locale join on the first insert that
 * did not fan out perfectly.
 */
function clone_column(column: ColumnDef): ExpectedColumn {
	return {
		name: column.name,
		type_string: column.type_string,
		is_nullable: column.is_nullable,
		is_primary_key: column.is_primary_key,
		is_sidecar: false,
		is_generated: column.is_generated ?? false,
	};
}

function sidecar_column(name: string): ExpectedColumn {
	return {
		name,
		// Always nullable: NULL provenance is the correct default and reads as
		// "authored directly in this locale", not "copied from somewhere".
		type_string: "TEXT",
		is_nullable: true,
		is_primary_key: false,
		is_sidecar: true,
		is_generated: false,
	};
}

/**
/**
 * Locale clones intentionally have no foreign-key constraints. A localized
 * row is a translation sidecar, not an independently constrained base record;
 * constraining it can reject a locale save when the referenced value is only
 * valid in the base table or when the locale is being edited before related
 * localized data exists.
 */

export interface ExpectedSchemaOptions {
	base_schema: SchemaObject;
	/** Fields carrying `localized: true` in the route's config.ts. */
	localized_field_names: readonly string[];
	locale_codes: readonly string[];
	default_locale_code: string;
	/** Retained for callers that discover all localized tables together. */
	localized_tables: ReadonlySet<string>;
}

/**
 * Every locale table `base_schema` should have, one per non-default locale.
 * Returns an empty array when the table has no localized fields at all - a
 * non-localized table has no clones, which is what keeps a single-locale app
 * generating exactly what it generates today (D3).
 */
export function expected_locale_tables(options: ExpectedSchemaOptions): ExpectedTable[] {
	const { base_schema, localized_field_names, locale_codes, default_locale_code } = options;

	if (localized_field_names.length === 0) return [];

	const tables: ExpectedTable[] = [];

	for (const locale_code of locale_codes) {
		if (locale_code === default_locale_code) continue;

		const columns: ExpectedColumn[] = base_schema.columns.map((column) => clone_column(column));

		// Introspection deliberately drops the primary key from `columns` -
		// generated CRUD never writes it. A clone still needs a real id column,
		// because the fan-out supplies the base table's id verbatim (D3), so it
		// is added back here rather than inherited.
		const has_id = columns.some((column) => column.name === "id");
		if (!has_id) {
			columns.unshift({
				name: "id",
				type_string: "INTEGER",
				is_nullable: false,
				is_primary_key: true,
				is_sidecar: false,
				is_generated: false,
			});
		}

		// Do not clone base-table foreign keys into locale sidecars. The base table
		// remains the sole owner of relational constraints.
		const foreign_keys: ExpectedForeignKey[] = [];

		tables.push({
			name: locale_table_name(base_schema.name, locale_code, default_locale_code),
			locale_code,
			base_table: base_schema.name,
			columns,
			foreign_keys,
		});
	}

	return tables;
}

/** Column names only, for the cheap diff the consistency check runs. */
export function expected_column_names(table: ExpectedTable): string[] {
	return table.columns.map((column) => column.name);
}
