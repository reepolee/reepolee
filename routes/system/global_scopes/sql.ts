import { db } from "$config/db";
import { timed_query } from "$lib/timed_sql";

// db.unsafe() - legacy manual CRUD. Uses dynamic ORDER BY, offset-based pagination, and
// scope_clause injection. Regex-validated sort_field.

export interface Record {
	id: number;
	module_code: string;
	feature_name: string;
	table_name: string;
	scope_key: string;
	display_name: string;
	where_clause: string;
	sort_order: number;
	is_default: number;
}

export interface Options {
	option_value: number | string;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		return await timed_query("global_scopes", "get_all_records", async () => {
			const _records = await db`SELECT * FROM global_scopes ORDER BY id ASC`;
			const records = _records;

			return records as Record[];
		});
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_global_scopes_select_options(): Promise<Options[]> {
	try {
		return await timed_query("global_scopes", "get_select_options", async () => {
			const records = await db`SELECT id as option_value, table_name as option_text FROM global_scopes ORDER BY table_name ASC LIMIT 50`;
			return records as Options[];
		});
	} catch (error) {
		console.error("Error fetching select options:", error);
		return [];
	}
}

export async function get_record_by_id(id: number): Promise<Record | undefined> {
	try {
		return await timed_query("global_scopes", "get_record_by_id", async () => {
			const records = await db`SELECT * FROM global_scopes WHERE id = ${id} LIMIT 1`;
			const record = records[0];
			return record as Record | undefined;
		});
	} catch (error) {
		console.error("Error fetching record by id:", error);
		return undefined;
	}
}

export async function search_records(
	search: string = "",
	offset: number = 0,
	limit: number = 20,
	order_by: string = "id::asc",
	scope_clause: string = "",
	filter_clauses: { clause: string; params: any[]; }[] = [],
): Promise<{ records: Record[]; total: number; }> {
	try {
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return search_records(search, offset, limit, "id::asc", scope_clause, filter_clauses);
		}

		return await timed_query("global_scopes", "search_records", async () => {
			let records: Record[] = [];
			let total: number = 0;

			const where_clauses: string[] = [];
			const params: any[] = [];

			if (search) {
				const search_term = `%${search}%`;
				where_clauses.push("(scope_key LIKE ? OR display_name LIKE ? OR where_clause LIKE ?)");
				params.push(search_term, search_term, search_term);
			}

			if (scope_clause) { where_clauses.push(`(${scope_clause})`); }

			for (const filter of filter_clauses) {
				where_clauses.push(`(${filter.clause})`);
				params.push(...filter.params);
			}

			const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(" AND ")}` : "";
			const data_query = `SELECT * FROM global_scopes ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
			records = (await db.unsafe(data_query, [...params, limit, offset])) as Record[];

			const count_query = `SELECT COUNT(*) as count FROM global_scopes ${where_clauses.length > 0 ? where : ""}`;
			const count_result = await db.unsafe(count_query, params);
			total = (count_result[0] as any)?.count || 0;

			return { records, total };
		});
	} catch (error) {
		console.error("Error searching records:", error);
		return { records: [], total: 0 };
	}
}
export async function create_record(record: Omit<Record, "id">): Promise<Record> {
	try {
		return await timed_query("global_scopes", "create_record", async () => {
			const insert_result = await db`INSERT INTO global_scopes (module_code, feature_name, table_name, scope_key, display_name, where_clause, sort_order, is_default) VALUES (${record.module_code}, ${record.feature_name || ""}, ${record.table_name}, ${record.scope_key}, ${record.display_name}, ${record.where_clause}, ${record.sort_order}, ${record.is_default})`;
			const get_result = await db`SELECT * FROM global_scopes WHERE id = ${insert_result.lastInsertRowid} LIMIT 1`;
			return get_result[0] as Record;
		});
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: number, record: Omit<Record, "id">): Promise<Record | undefined> {
	try {
		return await timed_query("global_scopes", "update_record", async () => {
			await db`UPDATE global_scopes SET module_code = ${record.module_code}, feature_name = ${record.feature_name || ""}, table_name = ${record.table_name}, scope_key = ${record.scope_key}, display_name = ${record.display_name}, where_clause = ${record.where_clause}, sort_order = ${record.sort_order}, is_default = ${record.is_default} WHERE id = ${id}`;
			const records = await db`SELECT * FROM global_scopes WHERE id = ${id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function delete_record(id: number): Promise<boolean> {
	try {
		return await timed_query("global_scopes", "delete_record", async () => {
			const result = await db`DELETE FROM global_scopes WHERE id = ${id}`;
			return (result.affectedRows ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error deleting record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) { throw error; }
		return false;
	}
}
