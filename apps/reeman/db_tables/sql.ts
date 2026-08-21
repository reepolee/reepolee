import { db } from "$config/db";
import { timed_query } from "$lib/timed_sql";
import { cache } from "$lib/cache";

export const TABLE_NAME = "db_tables";
export const VIEW_DEPENDENCIES = ["db_tables"];

export interface Record {
	id: number;
	name: string;
	column_count: number;
	fk_count: number;
	has_crud: number;
	display?: string | null | undefined;
}

export interface Options {
	option_value: number | string;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		return await timed_query("db_tables", "get_all_records", async () => {
			const _records = await db`SELECT * FROM db_tables ORDER BY id ASC`;
			const records = _records;

			return records as Record[];
		});
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get_db_tables_select_options(): Promise<Options[]> {
	try {
		return await timed_query("db_tables", "get_select_options", async () => {
			const records = await db`SELECT id as option_value, display as option_text FROM db_tables ORDER BY display ASC LIMIT 50`;
			return records as Options[];
		});
	} catch (error) {
		console.error("Error fetching select options:", error);
		return [];
	}
}

export async function get_record_by_id(id: number): Promise<Record | undefined> {
	try {
		return await timed_query("db_tables", "get_record_by_id", async () => {
			const from_source = TABLE_NAME;
			const by_id_query = `SELECT * FROM ${from_source} WHERE id = ? LIMIT 1`;
			const records = await db.unsafe(by_id_query, [id]) as Record[];
			const record = records[0];
			return record as Record | undefined;
		});
	} catch (error) {
		console.error("Error fetching record by id:", error);
		return undefined;
	}
}

export async function search_records(search: string = "", offset: number = 0, limit: number = 20, order_by: string = "id::asc", scope_clause: string = "", filter_clauses: { clause: string; params: any[] }[] = []): Promise<{ records: Record[], total: number }> {
	try {
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return search_records(search, offset, limit, "id::asc", scope_clause, filter_clauses);
		}

		return await timed_query("db_tables", "search_records", async () => {
			return cache.search(
				"//reeman/db_tables",
				{ search, offset, limit, order_by, scope_clause, filter_clauses },
				VIEW_DEPENDENCIES,
				async () => {
					const from_source = TABLE_NAME;
					const from_params: string[] = [];
					let records: Record[] = [];
					let total: number = 0;

					if (search) {
						const search_term = `%${search}%`;
						const search_where: string[] = [`display LIKE ?`];
						const search_params: any[] = [search_term];

						// Apply scope clause
						if (scope_clause) {
							search_where.push(`(${scope_clause})`);
						}

						// Apply filter clauses
						for (const filter of filter_clauses) {
							search_where.push(`(${filter.clause})`);
							search_params.push(...filter.params);
						}

						const search_where_clause = search_where.join(' AND ');
						const data_query = `SELECT * FROM ${from_source} WHERE ${search_where_clause} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
						records = await db.unsafe(data_query, [...from_params, ...search_params, limit, offset]) as Record[];

						const count_query = `SELECT COUNT(*) as count FROM ${from_source} WHERE ${search_where_clause}`;
						const count_result = await db.unsafe(count_query, [...from_params, ...search_params]);
						total = (count_result[0] as any)?.count || 0;
					} else {
						const where_clauses: string[] = [];
						if (scope_clause) {
							where_clauses.push(`(${scope_clause})`);
						}

						// Apply filter clauses (parameterized)
						const filter_params: any[] = [];
						for (const filter of filter_clauses) {
							where_clauses.push(`(${filter.clause})`);
							filter_params.push(...filter.params);
						}

						const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(' AND ')}` : '';
						const data_query = `SELECT * FROM ${from_source} ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
						records = await db.unsafe(data_query, [...from_params, ...filter_params, limit, offset]) as Record[];

						const count_where = where_clauses.length > 0 ? ` WHERE ${where_clauses.join(' AND ')}` : '';
						const count_query = `SELECT COUNT(*) as count FROM ${from_source}${count_where}`;
						const count_result = await db.unsafe(count_query, [...from_params, ...filter_params]);
						total = (count_result[0] as any)?.count || 0;
					}

					return { records, total };
				}
			);
		});
	} catch (error) {
		console.error("Error searching records:", error);
		return { records: [], total: 0 };
	}
}
export async function create_record(record: Omit<Record, "id" | "display">): Promise<Record> {
	try {
		return await timed_query("db_tables", "create_record", async () => {
			const insert_result = await db`INSERT INTO db_tables (name, column_count, fk_count, has_crud) VALUES (${record.name}, ${record.column_count}, ${record.fk_count}, ${record.has_crud})`;

			const get_result = await db`SELECT * FROM db_tables WHERE id = ${insert_result.lastInsertRowid} LIMIT 1`;
			return get_result[0] as Record;
		});
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: number, record: Omit<Record, "id" | "display">): Promise<Record | undefined> {
	try {
		return await timed_query("db_tables", "update_record", async () => {
			await db`UPDATE db_tables SET name = ${record.name}, column_count = ${record.column_count}, fk_count = ${record.fk_count}, has_crud = ${record.has_crud} WHERE id = ${id}`;
			const records = await db`SELECT * FROM db_tables WHERE id = ${id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function delete_record(id: number): Promise<boolean> {
	try {
		return await timed_query("db_tables", "delete_record", async () => {
			const result = await db`DELETE FROM db_tables WHERE id = ${id}`;
			return (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error deleting record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) {
			throw error;
		}
		return false;
	}
}
