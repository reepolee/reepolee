import { db } from "$config/db";
import { db_type } from "$lib/resolve_db_type";
import { timed_query } from "$lib/timed_sql";

// db.unsafe() - legacy manual CRUD. Uses dynamic ORDER BY, scope_clause injection, and
// manually-built batch WHERE clause. Regex-validated sort_field. Migrate to generator template
// when regenerating this route.

// Bun's SQL driver doesn't expose escapeLiteral(). This is the MySQL-safe equivalent:
// doubles single quotes, wraps in single quotes.
function escape_literal(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

export interface TranslationRow {
	id: number;
	lang: string;
	namespace: string;
	key_path: string;
	translation: string;
}

export async function get_key_by_id(id: string): Promise<{ namespace: string; key_path: string; values: Record<string, string>; } | undefined> {
	return await timed_query("translations", "get_key_by_id", async () => {
		// id is in format: namespace::key_path
		const delim_idx = id.indexOf("::");
		if (delim_idx < 0) return undefined;
		const namespace = id.slice(0, delim_idx);
		const key_path = id.slice(delim_idx + 2);

		const rows = (await db`SELECT lang, translation FROM translations WHERE namespace = ${namespace} AND key_path = ${key_path}`) as { lang: string; translation: string; }[];
		if (rows.length === 0) return undefined;

		const values: Record<string, string> = {};
		for (const row of rows) {
			values[row.lang] = row.translation;
		}

		return { namespace, key_path, values };
	});
}

export async function delete_key(namespace: string, key_path: string): Promise<number> {
	return await timed_query("translations", "delete_key", async () => {
		const result = await db`DELETE FROM translations WHERE namespace = ${namespace} AND key_path = ${key_path}`;
		return result.affectedRows ?? result.changes ?? 0;
	});
}

export async function delete_translation(lang: string, namespace: string, key_path: string): Promise<number> {
	return await timed_query("translations", "delete_translation", async () => {
		const result = await db`DELETE FROM translations WHERE lang = ${lang} AND namespace = ${namespace} AND key_path = ${key_path}`;
		return result.affectedRows ?? result.changes ?? 0;
	});
}

// Dialects diverge here and nowhere else in this file: SQLite spells the upsert
// `ON CONFLICT .. DO UPDATE`, MySQL/MariaDB `ON DUPLICATE KEY UPDATE`.
async function upsert_translation_sqlite(lang: string, namespace: string, key_path: string, translation: string): Promise<void> {
	await db`
		INSERT INTO translations (lang, namespace, key_path, translation)
		VALUES (${lang}, ${namespace}, ${key_path}, ${translation})
		ON CONFLICT(lang, namespace, key_path) DO UPDATE SET translation = excluded.translation
	`;
}

async function upsert_translation_mysql(lang: string, namespace: string, key_path: string, translation: string): Promise<void> {
	await db`
		INSERT INTO translations (lang, namespace, key_path, translation)
		VALUES (${lang}, ${namespace}, ${key_path}, ${translation})
		ON DUPLICATE KEY UPDATE translation = VALUES(translation)
	`;
}

export async function upsert_translation(lang: string, namespace: string, key_path: string, translation: string): Promise<void> {
	return await timed_query("translations", "upsert", async () => {
		if (db_type === "sqlite") { return upsert_translation_sqlite(lang, namespace, key_path, translation); }
		return upsert_translation_mysql(lang, namespace, key_path, translation);
	});
}

export async function get_namespaces(): Promise<string[]> {
	return await timed_query("translations", "get_namespaces", async () => {
		const rows = (await db`SELECT DISTINCT namespace FROM translations ORDER BY namespace`) as { namespace: string; }[];
		return rows.map((r) => r.namespace);
	});
}

export async function get_all_languages(): Promise<string[]> {
	return await timed_query("translations", "get_all_languages", async () => {
		const rows = (await db`SELECT DISTINCT lang FROM translations ORDER BY lang`) as { lang: string; }[];
		return rows.map((r) => r.lang);
	});
}

export interface NamespaceGroup {
	namespace: string;
	parent_path: string;
}

/**
 * Get all distinct (namespace, parent_path) pairs across all translations.
 * parent_path is derived from key_path (everything before the last dot).
 */
export async function get_namespace_groups(): Promise<NamespaceGroup[]> {
	return await timed_query("translations", "get_namespace_groups", async () => {
		const rows = (await db`SELECT DISTINCT namespace, key_path FROM translations WHERE key_path NOT LIKE '%_placeholder' ORDER BY namespace, key_path`) as {
			namespace: string;
			key_path: string;
		}[];

		const seen = new Set();
		const groups: NamespaceGroup[] = [];
		for (const r of rows) {
			const last_dot = r.key_path.lastIndexOf(".");
			const pp = last_dot >= 0 ? r.key_path.slice(0, last_dot) : "";
			const key = `${r.namespace}::${pp}`;
			if (!seen.has(key)) {
				seen.add(key);
				groups.push({ namespace: r.namespace, parent_path: pp });
			}
		}
		return groups;
	});
}

export async function get_all_translations(namespace_filter: string = ""): Promise<TranslationRow[]> {
	return await timed_query("translations", "get_all_translations", async () => {
		let rows: TranslationRow[];
		if (namespace_filter) {
			rows = (await db`SELECT * FROM translations WHERE namespace = ${namespace_filter} ORDER BY namespace, key_path, lang`) as TranslationRow[];
		} else {
			rows = (await db`SELECT * FROM translations ORDER BY namespace, key_path, lang`) as TranslationRow[];
		}
		return rows;
	});
}

// ---------------------------------------------------------------------------
// Paginated translation queries - avoids loading all rows into memory
// ---------------------------------------------------------------------------

/**
 * Build the WHERE clause parts for namespace, group, and query filters.
 *
 * @param multi_ns_groups - Multi-select namespace.group pairs from ree-filters checkboxes.
 * Each pair is rendered as a combined OR condition.
 * @param negate_multi - When true, wraps the multi_ns_groups condition in NOT (...).
 */
function build_where_parts(
	namespace_filter: string,
	group_filter: string,
	query: string,
	multi_ns_groups: { namespace: string; parent_path: string; }[] = [],
	negate_multi: boolean = false,
): string[] {
	const parts: string[] = [];

	if (multi_ns_groups.length > 0) {
		// Multi-select replaces single ns_group - each pair becomes an OR condition
		const conditions = multi_ns_groups.map((g) => {
			if (g.parent_path) {
				return `(namespace = ${escape_literal(g.namespace)} AND (key_path LIKE ${escape_literal(`${g.parent_path}.%`)} OR key_path = ${escape_literal(g.parent_path)}))`;
			}
			return `namespace = ${escape_literal(g.namespace)}`;
		});
		const inner = `(${conditions.join(" OR ")})`;
		parts.push(negate_multi ? `NOT ${inner}` : inner);
	}

	if (namespace_filter && multi_ns_groups.length === 0) { parts.push(`namespace = ${escape_literal(namespace_filter)}`); }
	if (group_filter && multi_ns_groups.length === 0) { parts.push(`(key_path LIKE ${escape_literal(`${group_filter}.%`)} OR key_path = ${escape_literal(group_filter)})`); }

	if (query) { parts.push(`(namespace LIKE ${escape_literal(`%${query}%`)} OR key_path LIKE ${escape_literal(`%${query}%`)})`); }
	return parts;
}

/**
 * Count total translation rows matching the filter for pagination.
 */
export async function count_translation_rows(
	namespace_filter: string = "",
	group_filter: string = "",
	query: string = "",
	multi_ns_groups: { namespace: string; parent_path: string; }[] = [],
	negate_multi: boolean = false,
): Promise<number> {
	return await timed_query("translations", "count_rows", async () => {
		const where_parts = build_where_parts(
			namespace_filter,
			group_filter,
			query,
			multi_ns_groups,
			negate_multi
		);
		const where_clause = where_parts.length > 0 ? `WHERE ${where_parts.join(" AND ")}` : "";
		const rows = (await db.unsafe(`SELECT COUNT(*) as cnt FROM (SELECT DISTINCT namespace, key_path FROM translations ${where_clause}) sub`)) as { cnt: number; }[];
		return Number(rows[0]?.cnt ?? 0);
	});
}

/**
 * Get a page of translation rows with LIMIT/OFFSET pagination.
 * Paginates by distinct (namespace, key_path), then expands to all language rows.
 */
export async function get_translations_page(
	namespace_filter: string = "",
	group_filter: string = "",
	query: string = "",
	multi_ns_groups: { namespace: string; parent_path: string; }[] = [],
	negate_multi: boolean = false,
	offset: number,
	limit: number,
): Promise<TranslationRow[]> {
	return await timed_query("translations", "get_page", async () => {
		const where_parts = build_where_parts(
			namespace_filter,
			group_filter,
			query,
			multi_ns_groups,
			negate_multi
		);
		const where_clause = where_parts.length > 0 ? `WHERE ${where_parts.join(" AND ")}` : "";

		// Step 1: get the distinct (namespace, key_path) for the current page
		const distinct_keys = (await db.unsafe(`
			SELECT DISTINCT namespace, key_path FROM translations
			${where_clause}
			ORDER BY namespace, key_path
			LIMIT ${limit} OFFSET ${offset}
		`)) as { namespace: string; key_path: string; }[];

		if (distinct_keys.length === 0) return [];

		// Step 2: fetch all translation rows for those keys
		const conditions = distinct_keys.map((k) => `(namespace = ${escape_literal(k.namespace)} AND key_path = ${escape_literal(k.key_path)})`);

		return (await db.unsafe(`
			SELECT * FROM translations
			WHERE ${conditions.join(" OR ")}
			ORDER BY namespace, key_path, lang
		`)) as TranslationRow[];
	});
}

export async function delete_groups(groups: { namespace: string; parent_path: string; }[]): Promise<number> {
	return await timed_query("translations", "delete_groups", async () => {
		let total = 0;
		for (const g of groups) {
			if (g.parent_path) {
				const result = await db`DELETE FROM translations WHERE namespace = ${g.namespace} AND key_path LIKE ${`${g.parent_path}.%`}`;
				total += result.affectedRows ?? result.changes ?? 0;
			} else {
				const result = await db`DELETE FROM translations WHERE namespace = ${g.namespace} AND key_path NOT LIKE '%.%'`;
				total += result.affectedRows ?? result.changes ?? 0;
			}
		}
		return total;
	});
}

export async function delete_namespace(namespace: string): Promise<number> {
	return await timed_query("translations", "delete_namespace", async () => {
		const result = await db`DELETE FROM translations WHERE namespace = ${namespace}`;
		return result.affectedRows ?? result.changes ?? 0;
	});
}
