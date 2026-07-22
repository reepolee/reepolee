import { db } from "$config/db";
import { timed_query } from "$lib/timed_sql";
import { cache } from "$lib/cache";

export const TABLE_NAME = "__table.exact__";
export const VIEW_DEPENDENCIES = __sql.view_dependencies__;

export interface Record {
	__interface.fields__
}

export interface Options {
	option_value: number | string;
	option_text: string;
}

export async function get_all_records(): Promise<Record[]> {
	try {
		return await timed_query("__table.exact__", "get_all_records", async () => {
			const _records = await db`SELECT * FROM __table.exact__ ORDER BY id ASC`;
			const records = _records;

			return records as Record[];
		});
	} catch (error) {
		console.error("Error fetching all records:", error);
		return [];
	}
}

export async function get___table.exact___select_options(): Promise<Options[]> {
	try {
		return await timed_query("__table.exact__", "get_select_options", async () => {
			const records = await db`SELECT id as option_value, __table.option_text_field__ as option_text FROM __table.exact__ ORDER BY __table.option_text_field__ ASC LIMIT 50`;
			return records as Options[];
		});
	} catch (error) {
		console.error("Error fetching select options:", error);
		return [];
	}
}

export async function get_record_by_id(id: __sql.id_type__): Promise<Record | undefined> {
	try {
		return await timed_query("__table.exact__", "get_record_by_id", async () => {
			const records = await db`SELECT * FROM __table.exact__ WHERE id = ${id} LIMIT 1`;
			const record = records[0];
			return record as Record | undefined;
		});
	} catch (error) {
		console.error("Error fetching record by id:", error);
		return undefined;
	}
}

__sql.route_param_functions__

export async function search_records(search: string = "", after: string | null = null, before: string | null = null, is_last: boolean = false, limit: number = 20, order_by: string = "id::asc", scope_clause: string = "", filter_clauses: { clause: string; params: any[] }[] = []): Promise<{ records: Record[], total: number }> {
	try {
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return search_records(search, after, before, is_last, limit, "id::asc", scope_clause);
		}

		return await timed_query("__table.exact__", "search_records", async () => {
			return cache.search(
				"__sql.route__",
				{ search, after, before, is_last, limit, order_by, scope_clause, filter_clauses },
				VIEW_DEPENDENCIES,
				async () => {
					// Determine effective query direction and whether to reverse results
					let query_direction = valid_direction;
					let need_reverse = false;
					if (is_last || before) {
						query_direction = valid_direction === "asc" ? "desc" : "asc";
						need_reverse = true;
					}

					// Parse cursor: JSON array [id, value]
					let cursor_id: number | null = null;
					let cursor_value: string | null = null;
					const cursor_str = after || before;
					if (cursor_str) {
						try {
							const cursor_parts = JSON.parse(cursor_str);
							cursor_id = typeof cursor_parts[0] === 'number' ? cursor_parts[0] : null;
							cursor_value = cursor_parts[1] != null ? String(cursor_parts[1]) : null;
						} catch {
							console.warn('Invalid cursor format:', cursor_str);
						}
					}

					// Build WHERE clauses and params
					const where_clauses: string[] = [];
					const params: any[] = [];

					__search.block__

					if (scope_clause) {
						where_clauses.push(`(${scope_clause})`);
					}

					// Apply filter clauses (parameterized)
					for (const filter of filter_clauses) {
						where_clauses.push(`(${filter.clause})`);
						params.push(...filter.params);
					}

					if (cursor_id !== null && cursor_value !== null) {
						if (query_direction === "asc") {
							where_clauses.push(`(${sort_field} > ? OR (${sort_field} = ? AND id > ?))`);
						} else {
							where_clauses.push(`(${sort_field} < ? OR (${sort_field} = ? AND id < ?))`);
						}
						params.push(cursor_value, cursor_value, cursor_id);
					}

					const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(' AND ')}` : '';
					const data_query = `SELECT * FROM __table.exact__ ${where} ORDER BY ${sort_field} ${query_direction.toUpperCase()}, id ${query_direction.toUpperCase()} LIMIT ?`;
					// Fetch limit+1 to accurately detect if a next page exists
					params.push(limit + 1);

					const records = await db.unsafe(data_query, params) as Record[];

					// Count query (without cursor filters - just search)
					let total: number = 0;
					__search.count_block__
					if (!search) {
						const count_where_clauses: string[] = [];
						if (scope_clause) {
							count_where_clauses.push(`(${scope_clause})`);
						}
						// Apply filter clauses to count (same as data query)
						const count_params: any[] = [];
						for (const filter of filter_clauses) {
							count_where_clauses.push(`(${filter.clause})`);
							count_params.push(...filter.params);
						}
						const count_where = count_where_clauses.length > 0 ? ` WHERE ${count_where_clauses.join(' AND ')}` : '';
						const count_query = `SELECT COUNT(*) as count FROM __table.exact__${count_where}`;
						const count_result = await db.unsafe(count_query, count_params);
						total = (count_result[0] as any)?.count || 0;
					}

					// Reverse for backward navigation so records are always in ASC order
					if (need_reverse) {
						records.reverse();
					}

					return { records, total };
				}
			);
		});
	} catch (error) {
		console.error("Error searching records:", error);
		return { records: [], total: 0 };
	}
}	export async function create_record(record: __sql.create_record_arg__): Promise<Record> {
	try {
		return await timed_query("__table.exact__", "create_record", async () => {
			const insert_result = await db`INSERT INTO __table.exact__ (__insert.fields__) VALUES (__insert.values__)`;
			__sql.create_record_return__
		});
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: __sql.id_type__, record: __sql.update_record_arg__): Promise<Record | undefined> {
	try {
		return await timed_query("__table.exact__", "update_record", async () => {
			await db`UPDATE __table.exact__ SET __update.set__ WHERE id = ${id}`;
			const records = await db`SELECT * FROM __table.exact__ WHERE id = ${id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function delete_record(id: __sql.id_type__): Promise<boolean> {
	try {
		return await timed_query("__table.exact__", "delete_record", async () => {
			const result = await db`DELETE FROM __table.exact__ WHERE id = ${id}`;
			return (result.affectedRows ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error deleting record:", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) {
			throw error;
		}
		return false;
	}
}__sql.tag_functions__
__sql.fk_select_functions__
__sql.autocomplete_display_functions__
