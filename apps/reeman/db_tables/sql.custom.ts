import { db } from "$config/db";
import { load_ddl_cache } from "$generator/ddl_cache";
import { locale_clone_table_names } from "$generator/naming";
import { default_locale, locales } from "$config/supported_locales";

// Add custom queries here. This file is never overwritten by the generator.

/**
 * Repopulate db_tables from the live DDL cache - rows are a snapshot, never
 * hand-edited, so a wholesale delete + reinsert before each index read keeps
 * the grid current with the DB's actual schema.
 */
export async function refresh_db_tables(): Promise<void> {
	const [{ discover_existing_crud_tables }, cache] = await Promise.all([
		import("$generator/reeman/utils/route_scan"),
		load_ddl_cache({ force_refresh: true }),
	]);

	const crud_by_table = new Set(discover_existing_crud_tables().map((t) => t.name));
	const all_names = cache.tables.map((t) => t.name);
	const locale_clones = locale_clone_table_names(all_names, locales, default_locale);

	const rows = cache.tables
		.filter((t) => !locale_clones.has(t.name) && t.name !== "db_tables")
		.map((t) => {
			// A column has at most one real FK target - native, naming-inferred and
			// view-join detection often flag the same column, so dedupe by name
			// instead of summing the three lists (which triples real FK counts).
			const fk_columns = new Set([
				...t.foreign_keys.map((fk) => fk.column_name),
				...t.inferred_foreign_keys.map((fk) => fk.column_name),
				...t.view_foreign_keys.map((fk) => fk.column_name),
			]);
			return {
				name: t.name,
				column_count: t.columns.length,
				fk_count: fk_columns.size,
				has_crud: crud_by_table.has(t.name) ? 1 : 0,
			};
		});

	await db`DELETE FROM db_tables`;
	for (const row of rows) {
		await db`INSERT INTO db_tables (name, column_count, fk_count, has_crud) VALUES (${row.name}, ${row.column_count}, ${row.fk_count}, ${row.has_crud})`;
	}
}

/**
 * Actual row count for a table, used on the table detail page to help decide
 * offset vs cursor pagination and load vs stream render strategy. table_name
 * must be validated against the DDL cache before calling - it is interpolated
 * as an identifier, not a bound parameter.
 */
export async function get_table_row_count(table_name: string): Promise<number> {
	const cache = await load_ddl_cache();
	const known = cache.tables.some((t) => t.name === table_name);
	if (!known) return 0;

	const rows = (await db.unsafe(`SELECT COUNT(*) AS cnt FROM "${table_name}"`)) as { cnt: number; }[];
	return rows[0]?.cnt ?? 0;
}
