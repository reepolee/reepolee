import { timed_query } from "$lib/timed_sql";

import { search_metadata } from "../reeman/lib/metadata_resource";
import { refresh_db_tables, type DbTableSnapshot } from "./sql.custom";

export const TABLE_NAME = "db_tables";
export const VIEW_DEPENDENCIES: string[] = [];

export interface Record extends DbTableSnapshot {}

export interface Options {
	option_value: number | string;
	option_text: string;
}

export type DbTablesListFilter = "non_system" | "all";

/** The Tables page defaults to application tables and can opt into system tables. */
export function resolve_db_tables_list_filter(value: string): DbTablesListFilter {
	return value === "all" ? "all" : "non_system";
}

async function records(include_system_tables = false): Promise<Record[]> {
	return refresh_db_tables(include_system_tables);
}

export async function get_all_records(): Promise<Record[]> {
	try { return await timed_query(TABLE_NAME, "get_all_records", records); }
	catch (error) { console.error("Error fetching all records:", error); return []; }
}

export async function get_db_tables_select_options(): Promise<Options[]> {
	try {
		return await timed_query(TABLE_NAME, "get_select_options", async () =>
			(await records()).sort((a, b) => a.display.localeCompare(b.display)).slice(0, 50).map((record) => ({ option_value: record.id, option_text: record.display })));
	} catch (error) { console.error("Error fetching select options:", error); return []; }
}

export async function get_record_by_id(id: number): Promise<Record | undefined> {
	try { return await timed_query(TABLE_NAME, "get_record_by_id", async () => (await records()).find((record) => record.id === id)); }
	catch (error) { console.error("Error fetching record by id:", error); return undefined; }
}

export async function search_records(search = "", offset = 0, limit = 20, order_by = "id::asc", _scope_clause = "", filter_clauses: { clause: string; params: any[] }[] = [], include_system_tables = false): Promise<{ records: Record[]; total: number; }> {
	try {
		return await timed_query(TABLE_NAME, "search_records", async () => {
			return search_metadata(await records(include_system_tables), search, offset, limit, order_by, ["name", "display"], filter_clauses);
		});
	} catch (error) { console.error("Error searching records:", error); return { records: [], total: 0 }; }
}

export async function create_record(_record: Omit<Record, "id" | "display">): Promise<Record> { throw new Error("db_tables is a read-only metadata resource"); }
export async function update_record(_id: number, _record: Omit<Record, "id" | "display">): Promise<Record | undefined> { throw new Error("db_tables is a read-only metadata resource"); }
export async function delete_record(_id: number): Promise<boolean> { throw new Error("db_tables is a read-only metadata resource"); }
