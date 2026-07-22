import { db_type } from "$lib/resolve_db_type";

type DbType = "mysql" | "sqlite";

function dialect<T>(map: Map<DbType, T>): T {
	const value = map.get(db_type);
	if (value === undefined) throw new Error(`SQL dialect not supported: ${db_type}`);
	return value;
}

export const fulltext_clause = new Map([["mysql", "MATCH(search_text) AGAINST(? IN BOOLEAN MODE)"], ["sqlite", "search_text LIKE ?"]]);

export const fulltext_param = new Map([["mysql", (term) => term], ["sqlite", (term) => `%${term}%`]]);

export function get_fulltext_clause(): string { return dialect(fulltext_clause); }

export function get_fulltext_param(term: string): string { return dialect(fulltext_param)(term); }
