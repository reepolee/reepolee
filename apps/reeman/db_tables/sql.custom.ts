import { db } from "$config/db";
import { load_ddl_cache } from "$generator/ddl_cache";
import { locale_clone_table_names } from "$generator/naming";
import { default_locale, locales } from "$config/supported_locales";

export interface DbTableSnapshot {
	id: number;
	name: string;
	column_count: number;
	fk_count: number;
	has_crud: number;
	display: string;
}

/** Discover the current database tables without persisting a metadata snapshot. */
export async function refresh_db_tables(): Promise<DbTableSnapshot[]> {
	const [{ discover_existing_crud_tables }, cache] = await Promise.all([
		import("$generator/reeman/utils/route_scan"),
		load_ddl_cache({ force_refresh: true }),
	]);

	const crud_by_table = new Set(discover_existing_crud_tables().map((t) => t.name));
	const locale_clones = locale_clone_table_names(cache.tables.map((t) => t.name), locales, default_locale);
	const rows = cache.tables
		.filter((t) => !locale_clones.has(t.name) && t.name !== "db_tables" && t.name !== "db_routes")
		.map((t) => {
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

	return rows.map((row, index) => ({ ...row, id: index + 1, display: row.name }));
}

export async function get_table_row_count(table_name: string): Promise<number> {
	const cache = await load_ddl_cache();
	const known = cache.tables.some((t) => t.name === table_name);
	if (!known) return 0;
	const escaped_name = table_name.replaceAll("`", "``");
	const rows = await db.unsafe(`SELECT COUNT(*) AS cnt FROM \`${escaped_name}\``) as { cnt: number; }[];
	return rows[0]?.cnt ?? 0;
}
