/**
 * Fanning a write out across a table's locale clones (D6b).
 *
 * Clones are structurally identical to the base table, so one statement shape
 * works against every one of them - the table name is substituted per locale.
 * There is nothing to validate per locale: clones always trail the base table
 * by construction, and a divergence is a generation bug fixed by regenerating,
 * not something to defend against on every write.
 *
 * Every fan-out runs inside one transaction on the single existing connection.
 * A write touches N tables, so a failure partway through would otherwise leave
 * one locale holding a row the others do not - the exact inconsistency the
 * clone model exists to prevent.
 *
 * Table names come from the configured locale list, never from user input, so
 * the db.unsafe() calls here are safe by construction. Table names cannot be
 * parameterized in SQL, which is why unsafe() is used at all.
 */

import { db } from "$config/db";
import { cache } from "$lib/cache";
import { all_locale_tables, clone_locales, locale_table } from "$lib/locale_tables";

function quote(identifier: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
	return `"${identifier}"`;
}

export interface FanOutOptions {
	table_name: string;
	/** Columns that vary per locale (`localized: true`). */
	localized_columns: readonly string[];
	/** Every writable column, in insert order. */
	write_columns: readonly string[];
}

/**
 * Clone a freshly created base row into every locale table.
 *
 * The base row's id is reused verbatim so all locales of one record share an
 * id (D3) - the clone's id column is a plain PK, never auto-increment, so the
 * value written here is the value stored.
 */
export async function fan_out_create(options: FanOutOptions, id: number | string, values: Record<string, unknown>): Promise<void> {
	const locales_to_write = clone_locales();
	if (locales_to_write.length === 0) return;

	const columns = ["id", ...options.write_columns.filter((column) => column !== "id")];
	const column_list = columns.map((column) => quote(column)).join(", ");
	const placeholders = columns.map(() => "?").join(", ");
	const row = columns.map((column) => (column === "id" ? id : values[column] ?? null));

	await db.begin(async (tx) => {
		for (const locale_code of locales_to_write) {
			const table = locale_table(options.table_name, locale_code);
			await tx.unsafe(`INSERT INTO ${quote(table)} (${column_list}) VALUES (${placeholders})`, row);
		}
	});
}

/**
 * Apply an update across every physical table.
 *
 * The locale being edited receives every column. Other locales receive only
 * the NON-localized columns, so a Slovenian edit cannot overwrite the German
 * translation while still keeping shared data (FKs, dates, flags) identical
 * everywhere.
 */
export async function fan_out_update(options: FanOutOptions, id: number | string, values: Record<string, unknown>, locale_code: string): Promise<void> {
	const localized = new Set(options.localized_columns);
	const edited_table = locale_table(options.table_name, locale_code);

	const updatable = options.write_columns.filter((column) => column !== "id");
	const shared_columns = updatable.filter((column) => !localized.has(column));

	await db.begin(async (tx) => {
		for (const table of all_locale_tables(options.table_name)) {
			// The edited locale's table takes every column; every other table takes
			// only the shared ones, so editing Slovenian cannot overwrite the German
			// translation while shared data still stays identical everywhere.
			const columns = table === edited_table ? updatable : shared_columns;
			if (columns.length === 0) continue;

			const assignments = columns.map((column) => `${quote(column)} = ?`).join(", ");
			const params = columns.map((column) => values[column] ?? null);
			await tx.unsafe(`UPDATE ${quote(table)} SET ${assignments} WHERE ${quote("id")} = ?`, [...params, id]);
		}
	});
}

/**
 * Save the per-locale values submitted by the editor.
 *
 * Each non-default locale's row takes its own values, and every field written
 * here has its provenance cleared: a value the user typed is no longer a copy,
 * so the stale-copy notice must stop firing for it.
 */
export async function save_locale_values(table_name: string, id: number | string, by_locale: Record<string, Record<string, string>>): Promise<void> {
	const entries = Object.entries(by_locale);
	if (entries.length === 0) return;

	await db.begin(async (tx) => {
		for (const [locale_code, field_values] of entries) {
			const field_names = Object.keys(field_values);
			if (field_names.length === 0) continue;

			const table = locale_table(table_name, locale_code);
			const assignments: string[] = [];
			const params: unknown[] = [];

			for (const field_name of field_names) {
				assignments.push(`${quote(field_name)} = ?`, `${quote(`${field_name}_src`)} = NULL`, `${quote(`${field_name}_hash`)} = NULL`);
				params.push(field_values[field_name]);
			}

			await tx.unsafe(`UPDATE ${quote(table)} SET ${assignments.join(", ")} WHERE ${quote("id")} = ?`, [...params, id]);
		}
	});
}

/**
 * Delete a record from every physical table, clones before the base.
 *
 * Clone-first matters when FK constraints are enforced: a clone's FK points at
 * the locale-matched parent, so deleting the base row first would be rejected.
 */
export async function fan_out_delete(table_name: string, id: number | string): Promise<number> {
	const tables = all_locale_tables(table_name);
	const clones = tables.slice(1);
	let affected = 0;

	await db.begin(async (tx) => {
		for (const table of clones) {
			await tx.unsafe(`DELETE FROM ${quote(table)} WHERE ${quote("id")} = ?`, [id]);
		}

		const result = (await tx.unsafe(`DELETE FROM ${quote(table_name)} WHERE ${quote("id")} = ?`, [id])) as any;
		affected = result?.affectedRows ?? result?.count ?? result?.changes ?? 0;
	});

	return affected;
}

/**
 * Invalidate every locale's cache entries for a table (D6a).
 *
 * A write touches the shared columns of every clone, so every locale's cached
 * results are stale - not just the edited locale's. invalidate() is one
 * SMEMBERS plus one DEL, so the N calls are cheap and run concurrently.
 */
export async function invalidate_all_locales(table_name: string): Promise<void> {
	const tables = all_locale_tables(table_name);
	const invalidations = tables.map((table) => cache.invalidate(table));
	await Promise.all(invalidations);
}
