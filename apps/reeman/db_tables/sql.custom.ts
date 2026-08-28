import { db } from "$config/db";
import { load_ddl_cache } from "$generator/ddl_cache";
import { locale_clone_table_names } from "$generator/naming";
import { default_locale, locales } from "$config/supported_locales";
import { db_type } from "$lib/resolve_db_type";

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
	const users_created_at = await get_users_table_created_at();
	const table_creation_times = await get_table_creation_times();
	const bootstrap_cutoff = users_created_at ? new Date(users_created_at).getTime() : 0;
	const rows = cache.tables
		.filter((t) => !locale_clones.has(t.name) && t.name !== "db_tables" && t.name !== "db_routes")
		.filter((t) => !bootstrap_cutoff || (table_creation_times.get(t.name.toLowerCase()) !== undefined && new Date(table_creation_times.get(t.name.toLowerCase())!).getTime() > bootstrap_cutoff))
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

export async function get_users_table_created_at(): Promise<string | null> {
	// information_schema is MySQL-only; SQLite's sqlite_master stores no creation
	// time. Return null so callers disable the bootstrap-cutoff filter entirely.
	if (db_type !== "mysql") return null;
	const rows = await db.unsafe(`SELECT CREATE_TIME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`) as Array<{ CREATE_TIME?: Date | string | null }>;
	const created_at = rows[0]?.CREATE_TIME;
	return created_at ? new Date(created_at).toISOString() : null;
}

async function get_table_creation_times(): Promise<Map<string, string>> {
	// information_schema is MySQL-only; SQLite has no per-table creation
	// timestamps, so degrade to an empty map (bootstrap-cutoff filter off).
	if (db_type !== "mysql") return new Map();
	const rows = await db.unsafe(`SELECT TABLE_NAME, CREATE_TIME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`) as Array<{ TABLE_NAME?: string; CREATE_TIME?: Date | string | null }>;
	return new Map(rows.filter((row) => row.TABLE_NAME && row.CREATE_TIME).map((row) => [row.TABLE_NAME!.toLowerCase(), new Date(row.CREATE_TIME!).toISOString()]));
}

export async function get_table_row_count(table_name: string): Promise<number> {
	const cache = await load_ddl_cache();
	const known = cache.tables.some((t) => t.name === table_name);
	if (!known) return 0;
	const escaped_name = table_name.replaceAll("`", "``");
	const rows = await db.unsafe(`SELECT COUNT(*) AS cnt FROM \`${escaped_name}\``) as { cnt: number; }[];
	return rows[0]?.cnt ?? 0;
}
