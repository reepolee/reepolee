/**
 * Runtime guard: every configured locale has the clone tables it needs (D10).
 *
 * Deliberately independent of generator/locale_tables/check.ts. That one diffs
 * full introspection results and belongs to the generator; this one runs on
 * every server start and only asks the cheap question - does each expected
 * clone table exist, and does it carry the sidecars its base table's localized
 * fields require. A drifted locale table serves wrong data for one locale
 * silently, so the server fails loud rather than starting.
 */

import { db } from "$config/db";
import { default_locale, locales } from "$config/supported_locales";
import { db_type } from "$lib/resolve_db_type";

/** table -> the localized field names declared in its schema/table.ts. */
export type LocalizedTableMap = ReadonlyMap<string, readonly string[]>;

function locale_segment(locale_code: string): string {
	const lowercased = locale_code.toLowerCase();
	return lowercased.replaceAll("-", "_");
}

function clone_table_name(table_name: string, locale_code: string): string {
	return `${table_name}_${locale_segment(locale_code)}`;
}

async function existing_columns(table_name: string): Promise<string[] | null> {
	if (db_type === "sqlite") {
		const rows = (await db.unsafe(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table_name])) as any[];
		if (rows.length === 0) return null;
		const columns = (await db.unsafe(`PRAGMA table_xinfo(${table_name})`)) as any[];
		return columns.map((column) => String(column.name));
	}

	const rows = (await db.unsafe(
		`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
		[table_name],
	)) as any[];
	if (rows.length === 0) return null;
	return rows.map((row) => String(row.COLUMN_NAME ?? row.column_name));
}

export async function collect_locale_table_problems(localized_by_table: LocalizedTableMap): Promise<string[]> {
	const problems: string[] = [];
	const clone_locales = (locales as readonly string[]).filter((locale) => locale !== default_locale);
	if (clone_locales.length === 0 || localized_by_table.size === 0) return problems;

	for (const [table_name, localized_fields] of localized_by_table) {
		for (const locale_code of clone_locales) {
			const clone = clone_table_name(table_name, locale_code);
			const columns = await existing_columns(clone);

			if (columns === null) {
				problems.push(`missing table ${clone}`);
				continue;
			}

			const present = new Set(columns);
			for (const field_name of localized_fields) {
				if (!present.has(field_name)) problems.push(`${clone} is missing column ${field_name}`);
				if (!present.has(`${field_name}_src`)) problems.push(`${clone} is missing column ${field_name}_src`);
				if (!present.has(`${field_name}_hash`)) problems.push(`${clone} is missing column ${field_name}_hash`);
			}
		}
	}

	return problems;
}

/**
 * Fail loud when locale tables are missing or incomplete - same posture as
 * verify_db_schema() for a missing `modules` table.
 */
export async function verify_locale_tables(localized_by_table: LocalizedTableMap): Promise<void> {
	const problems = await collect_locale_table_problems(localized_by_table);
	if (problems.length === 0) return;

	console.error("\n----------------------------------------");
	console.error("  ✗ LOCALE TABLES OUT OF SYNC");
	console.error("");
	for (const problem of problems) console.error(`  ${problem}`);
	console.error("");
	console.error("  Run: bun reeman sync-locale-tables");
	console.error("----------------------------------------\n");
	throw new Error("Locale tables are out of sync");
}
