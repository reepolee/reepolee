/**
 * Locale-table consistency check (D10).
 *
 * Runs against introspection results before the DDL cache is written. The
 * cache captures whatever it finds as truth and persists it for a 24h TTL, so
 * drift introspected once would be inherited by every generation in the
 * session and survive a restart. Building the cache only from a verified
 * schema prevents that.
 *
 * Shares compare_locale_tables() with the syncer - one computation, two verbs.
 * A check that derived its expectations independently would eventually
 * disagree with the syncer.
 */

import { compare_locale_tables, format_drift_report, type ActualTable, type Drift } from "./compare";
import { expected_locale_tables } from "./expected_schema";
import type { SchemaObject } from "../schema/types";

export interface CheckOptions {
	/** Every table schema introspection just produced, base tables included. */
	all_schemas: readonly SchemaObject[];
	/** table name -> its `localized: true` field names. */
	localized_by_table: ReadonlyMap<string, readonly string[]>;
	locale_codes: readonly string[];
	default_locale_code: string;
}

/**
 * Drift across every localized table.
 *
 * Takes already-introspected schemas rather than querying: the caller
 * (load_ddl_cache) has just read the whole database, so re-reading every
 * locale table here would cost a second full pass - 200 tables x 10 locales
 * on a large schema.
 */
export function check_locale_tables(options: CheckOptions): Drift[] {
	const { all_schemas, localized_by_table, locale_codes, default_locale_code } = options;
	if (localized_by_table.size === 0) return [];

	const schema_by_name = new Map<string, SchemaObject>();
	for (const schema of all_schemas) schema_by_name.set(schema.name.toLowerCase(), schema);

	const localized_tables = new Set(localized_by_table.keys());
	const drift: Drift[] = [];

	for (const [table_name, localized_field_names] of localized_by_table) {
		const base_schema = schema_by_name.get(table_name.toLowerCase());
		if (!base_schema) continue;

		const expected = expected_locale_tables({
			base_schema,
			localized_field_names,
			locale_codes,
			default_locale_code,
			localized_tables,
		});

		const actual = new Map<string, ActualTable>();
		for (const expected_table of expected) {
			const actual_schema = schema_by_name.get(expected_table.name.toLowerCase());
			if (!actual_schema) continue;
			// The introspected column list omits the primary key (see
			// expected_schema's id note), so add it back before diffing or every
			// clone would report a missing id column.
			const column_names = actual_schema.columns.map((column) => column.name);
			if (!column_names.includes("id")) column_names.unshift("id");
			actual.set(expected_table.name, { name: expected_table.name, column_names });
		}

		drift.push(...compare_locale_tables({ expected, actual, base_table: base_schema.name }));
	}

	return drift;
}

export function locale_drift_message(drift: readonly Drift[]): string {
	const report = format_drift_report(drift);
	return [
		"Locale tables are out of sync with their base tables:",
		"",
		report,
		"",
		"Run `bun reeman sync-locale-tables` to converge them.",
	].join("\n");
}
