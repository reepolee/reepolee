/**
 * Diffing expected locale tables against what is actually in the database.
 *
 * This is the one computation behind two verbs (D10): the syncer applies the
 * result, the consistency check reports it. A check that derived expectations
 * independently would eventually disagree with the syncer, which would put
 * two sources of truth back into the design.
 */

import type { ExpectedTable } from "./expected_schema";

export type DriftKind = "missing_table" | "extra_table" | "missing_column" | "extra_column";

export interface Drift {
	kind: DriftKind;
	table: string;
	/** Set for column-level drift. */
	column?: string;
	base_table: string;
	locale_code?: string;
}

export interface ActualTable {
	name: string;
	column_names: string[];
}

export interface CompareOptions {
	expected: readonly ExpectedTable[];
	/** Existing locale tables for this base table, keyed by physical name. */
	actual: ReadonlyMap<string, ActualTable>;
	base_table: string;
}

/**
 * Drift between expectation and reality, ordered so a reader sees structural
 * problems (whole tables) before detail (columns).
 */
export function compare_locale_tables(options: CompareOptions): Drift[] {
	const { expected, actual, base_table } = options;
	const drift: Drift[] = [];
	const expected_names = new Set(expected.map((table) => table.name));

	for (const expected_table of expected) {
		const actual_table = actual.get(expected_table.name);
		if (!actual_table) {
			drift.push({ kind: "missing_table", table: expected_table.name, base_table, locale_code: expected_table.locale_code });
			continue;
		}

		const actual_columns = new Set(actual_table.column_names);
		for (const column of expected_table.columns) {
			if (actual_columns.has(column.name)) continue;
			drift.push({ kind: "missing_column", table: expected_table.name, column: column.name, base_table, locale_code: expected_table.locale_code });
		}

		const expected_columns = new Set(expected_table.columns.map((column) => column.name));
		for (const column_name of actual_table.column_names) {
			if (expected_columns.has(column_name)) continue;
			drift.push({ kind: "extra_column", table: expected_table.name, column: column_name, base_table, locale_code: expected_table.locale_code });
		}
	}

	// A locale table for a locale no longer configured, or for a table that is
	// no longer localized at all.
	for (const [actual_name] of actual) {
		if (expected_names.has(actual_name)) continue;
		drift.push({ kind: "extra_table", table: actual_name, base_table });
	}

	return drift;
}

export function describe_drift(drift: Drift): string {
	if (drift.kind === "missing_table") return `missing table ${drift.table}`;
	if (drift.kind === "extra_table") return `stale table ${drift.table} (locale no longer configured, or table no longer localized)`;
	if (drift.kind === "missing_column") return `${drift.table} is missing column ${drift.column}`;
	return `${drift.table} has stale column ${drift.column}`;
}

export function format_drift_report(drift: readonly Drift[]): string {
	const lines = drift.map((item) => `  - ${describe_drift(item)}`);
	return lines.join("\n");
}
