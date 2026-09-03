import { db } from "$config/db";
import { API_BLOCKLIST } from "$config/api_blocklist";
import { IGNORE_TABLES } from "$config/db_structure";
import { load_ddl_cache } from "$generator/ddl_cache";
import { locale_clone_table_names } from "$generator/naming";
import { default_locale, locales } from "$config/supported_locales";

export interface DbTableSnapshot {
	id: number;
	name: string;
	column_count: number;
	fk_count: number;
	has_crud: number;
	template_hash_status: "clean" | "modified" | "untracked" | null;
	display: string;
}

export type TableSample = {
	columns: string[];
	records: Record<string, string>[];
};

const PREVIEW_RECORD_LIMIT = 5;

function quoted_identifier(name: string): string {
	return `\`${name.replaceAll("`", "``")}\``;
}

export function format_sample_value(value: unknown): string {
	if (value === null || value === undefined) return "-";
	if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;

	let text = String(value);
	if (typeof value === "object") {
		const serialized = JSON.stringify(value);
		if (serialized !== undefined) text = serialized;
	}
	if (text.length <= 120) return text;
	return `${text.slice(0, 117)}...`;
}

/** Return safe, readable values from the first five records for CRUD modelling. */
export async function get_table_sample_records(table_name: string, eligible_columns: string[]): Promise<TableSample> {
	const cache = await load_ddl_cache();
	const table = cache.tables.find((candidate) => candidate.name === table_name);
	if (!table) return { columns: [], records: [] };

	const known_columns = new Set(table.columns.map((column) => column.name));
	const sample_columns = [...new Set(eligible_columns)].filter((column) => known_columns.has(column) && !API_BLOCKLIST.includes(column));
	if (sample_columns.length === 0) return { columns: [], records: [] };

	try {
		const select_columns = sample_columns.map(quoted_identifier).join(", ");
		const table_name_sql = quoted_identifier(table_name);
		const primary_key_sql = table.primary_key ? ` ORDER BY ${quoted_identifier(table.primary_key.name)} ASC` : "";
		const query = `SELECT ${select_columns} FROM ${table_name_sql}${primary_key_sql} LIMIT ${PREVIEW_RECORD_LIMIT}`;
		const rows = await db.unsafe(query) as Record<string, unknown>[];
		const records = rows.map((row) => Object.fromEntries(sample_columns.map((column) => [column, format_sample_value(row[column])])));
		return { columns: sample_columns, records };
	} catch (error) {
		console.error(`Unable to load preview records for "${table_name}":`, error);
		return { columns: sample_columns, records: [] };
	}
}

/** Discover the current database tables without persisting a metadata snapshot. */
export async function refresh_db_tables(include_system_tables = false): Promise<DbTableSnapshot[]> {
	const [{ discover_existing_crud_tables }, cache] = await Promise.all([
		import("$generator/reeman/utils/route_scan"),
		load_ddl_cache({ force_refresh: true }),
	]);

	const crud_tables = discover_existing_crud_tables();
	const crud_by_table = new Map(crud_tables.map((table) => [table.name, table]));
	const locale_clones = locale_clone_table_names(cache.tables.map((t) => t.name), locales, default_locale);
	const ignored_tables = new Set<string>(IGNORE_TABLES);
	const rows = cache.tables
		.filter((t) => !locale_clones.has(t.name) && (include_system_tables || !ignored_tables.has(t.name)))
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
				template_hash_status: crud_by_table.get(t.name)?.template_hash_status ?? null,
			};
		});

	return rows.map((row, index) => ({ ...row, id: index + 1, display: row.name }));
}

export async function get_table_row_count(table_name: string): Promise<number> {
	const cache = await load_ddl_cache();
	const known = cache.tables.some((t) => t.name === table_name);
	if (!known) return 0;
	const rows = await db.unsafe(`SELECT COUNT(*) AS cnt FROM ${quoted_identifier(table_name)}`) as { cnt: number; }[];
	return rows[0]?.cnt ?? 0;
}
