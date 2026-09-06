import { db_type } from "$lib/resolve_db_type";

export type DbType = "mysql" | "sqlite";

function dialect<T>(map: Map<DbType, T>): T {
	const value = map.get(db_type);
	if (value === undefined) throw new Error(`SQL dialect not supported: ${db_type}`);
	return value;
}

export const fulltext_clause = new Map<DbType, string>([["mysql", "MATCH(search_text) AGAINST(? IN BOOLEAN MODE)"], ["sqlite", "search_text LIKE ?"]]);

export const fulltext_param = new Map<DbType, (term: string) => string>([["mysql", (term) => term], ["sqlite", (term) => `%${term}%`]]);

export function get_fulltext_clause(): string { return dialect(fulltext_clause); }

export function get_fulltext_param(term: string): string { return dialect(fulltext_param)(term); }

export function quote_identifier(identifier: string, type: DbType = db_type): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
	return type === "mysql" ? `\`${identifier}\`` : `"${identifier}"`;
}
