import { db } from "$config/db";
import { cache } from "$lib/cache";
import { timed_query } from "$lib/timed_sql";

export const TABLE_NAME = "modules";
export const VIEW_DEPENDENCIES = ["modules"];

export interface Record {
	id: number;
	code: string;
	name: string;
	description: string;
}

export interface Options {
	option_value: number | string;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		return await timed_query("modules", "get_all_records", async () => {
			const _records = await db`SELECT * FROM modules ORDER BY id ASC`;
			const records = _records;

			return records as Record[];
		});
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_modules_select_options(): Promise<Options[]> {
	try {
		return await timed_query("modules", "get_select_options", async () => {
			const records = await db`SELECT id as option_value, code as option_text FROM modules ORDER BY code ASC LIMIT 50`;
			return records as Options[];
		});
	} catch (error) {
		console.error("Error fetching select options:", error);
		return [];
	}
}

export async function get_record_by_id(id: number): Promise<Record | undefined> {
	try {
		return await timed_query("modules", "get_record_by_id", async () => {
			const records = await db`SELECT * FROM modules WHERE id = ${id} LIMIT 1`;
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
			return search_records(search, offset, limit, "id::asc", scope_clause);
		}

		return await timed_query("modules", "search_records", async () => {
			return cache.search("//system/modules", {
				search,
				offset,
				limit,
				order_by,
				scope_clause,
				filter_clauses,
			}, VIEW_DEPENDENCIES, async () => {
				let records: Record[] = [];
				let total: number = 0;

				if (search) {
					const search_term = `%${search}%`;
					const search_where: string[] = [`name LIKE ?`];
					const search_params: any[] = [search_term];

					// Apply scope clause
					if (scope_clause) { search_where.push(`(${scope_clause})`); }

					// Apply filter clauses
					for (const filter of filter_clauses) {
						search_where.push(`(${filter.clause})`);
						search_params.push(...filter.params);
					}

					const search_where_clause = search_where.join(" AND ");
					const data_query = `SELECT * FROM modules WHERE ${search_where_clause} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
					records = (await db.unsafe(data_query, [...search_params, limit, offset])) as Record[];

					const count_query = `SELECT COUNT(*) as count FROM modules WHERE ${search_where_clause}`;
					const count_result = await db.unsafe(count_query, search_params);
					total = (count_result[0] as any)?.count || 0;
				} else {
					const where_clauses: string[] = [];
					if (scope_clause) { where_clauses.push(`(${scope_clause})`); }

					// Apply filter clauses (parameterized)
					const filter_params: any[] = [];
					for (const filter of filter_clauses) {
						where_clauses.push(`(${filter.clause})`);
						filter_params.push(...filter.params);
					}

					const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(" AND ")}` : "";
					const data_query = `SELECT * FROM modules ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
					records = (await db.unsafe(data_query, [...filter_params, limit, offset])) as Record[];

					const count_where = where_clauses.length > 0 ? ` WHERE ${where_clauses.join(" AND ")}` : "";
					const count_query = `SELECT COUNT(*) as count FROM modules${count_where}`;
					const count_result = await db.unsafe(count_query, filter_params);
					total = (count_result[0] as any)?.count || 0;
				}

				return { records, total };
			});
		});
	} catch (error) {
		console.error("Error searching records:", error);
		return { records: [], total: 0 };
	}
}
export async function create_record(record: Omit<Record, "id">): Promise<Record> {
	try {
		return await timed_query("modules", "create_record", async () => {
			const insert_result = await db`INSERT INTO modules (code, name, description) VALUES (${record.code}, ${record.name}, ${record.description})`;
			const get_result = await db`SELECT * FROM modules WHERE id = ${insert_result.lastInsertRowid} LIMIT 1`;
			return get_result[0] as Record;
		});
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: number, record: Omit<Record, "id">): Promise<Record | undefined> {
	try {
		return await timed_query("modules", "update_record", async () => {
			await db`UPDATE modules SET code = ${record.code}, name = ${record.name}, description = ${record.description} WHERE id = ${id}`;
			const records = await db`SELECT * FROM modules WHERE id = ${id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function delete_record(id: number): Promise<boolean> {
	try {
		return await timed_query("modules", "delete_record", async () => {
			const result = await db`DELETE FROM modules WHERE id = ${id}`;
			return (result.affectedRows ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error deleting record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) { throw error; }
		return false;
	}
}
