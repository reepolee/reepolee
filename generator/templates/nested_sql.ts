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

export async function get_children_by_parent(parent_id: __sql.id_type__): Promise<Record[]> {
	try {
		return await timed_query("__table.exact__", "get_children_by_parent", async () => {
			const records = await db`SELECT * FROM __table.exact__ WHERE __parent.fk_column__ = ${parent_id} ORDER BY id ASC`;
			return records as Record[];
		});
	} catch (error) {
		console.error("Error fetching children by parent:", error);
		return [];
	}
}

export async function get_record_by_id_and_parent(id: __sql.id_type__, parent_id: __sql.id_type__): Promise<Record | undefined> {
	try {
		return await timed_query("__table.exact__", "get_record_by_id_and_parent", async () => {
			const records = await db`SELECT * FROM __table.exact__ WHERE id = ${id} AND __parent.fk_column__ = ${parent_id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error fetching record by id and parent:", error);
		return undefined;
	}
}

export async function get_record_by_id(id: __sql.id_type__): Promise<Record | undefined> {
	try {
		return await timed_query("__table.exact__", "get_record_by_id", async () => {
			const records = await db`SELECT * FROM __table.exact__ WHERE id = ${id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error fetching record by id:", error);
		return undefined;
	}
}

__sql.route_param_functions__

/**
 * Search records, optionally scoped to a parent. When parent_id is provided,
 * only records belonging to that parent are returned. This prevents accidental
 * cross-parent data exposure since nested CRUD tables have no index page.
 * Uses offset-based pagination.
 */
export async function search_records(search: string = "", offset: number = 0, limit: number = 20, order_by: string = "id::asc", parent_id?: __sql.id_type__, scope_clause: string = "", filter_clauses: { clause: string; params: any[] }[] = []): Promise<{ records: Record[], total: number }> {
	try {
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return search_records(search, offset, limit, "id::asc", parent_id, scope_clause);
		}

		return await timed_query("__table.exact__", "search_records", async () => {
			return cache.search(
				"__sql.route__",
				{ search, offset, limit, order_by, parent_id, scope_clause },
				VIEW_DEPENDENCIES,
				async () => {
					let records: Record[] = [];
					let total: number = 0;

					// Build WHERE clauses
					const where_parts: string[] = [];

					// Scope to parent if provided
					if (parent_id !== undefined) {
						where_parts.push('__parent.fk_column__ = ?');
					}

					if (scope_clause) {
						where_parts.push(`(${scope_clause})`);
					}

					// Apply filter clauses (parameterized)
					for (const filter of filter_clauses) {
						where_parts.push(`(${filter.clause})`);
					}

					if (search) {
						const search_term = `%${search}%`;
						where_parts.push('__search.field__ LIKE ?');

						const where = where_parts.length > 0 ? `WHERE ${where_parts.join(' AND ')}` : '';
						const params: any[] = [];

						// Add parent_id param if needed
						if (parent_id !== undefined) {
							params.push(parent_id);
						}

						if (scope_clause) {
							// scope_clause doesn't need a param - it's inline SQL
						}

						params.push(search_term);

						const data_query = `SELECT * FROM __table.exact__ ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
						records = await db.unsafe(data_query, [...params, limit, offset]) as Record[];

						const count_query = `SELECT COUNT(*) as count FROM __table.exact__ ${where}`;
						const count_result = await db.unsafe(count_query, params);
						total = (count_result[0] as any)?.count || 0;
					} else {
						const where = where_parts.length > 0 ? `WHERE ${where_parts.join(' AND ')}` : '';
						const params: any[] = [];

						// Add parent_id param if needed
						if (parent_id !== undefined) {
							params.push(parent_id);
						}

						const data_query = `SELECT * FROM __table.exact__ ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
						records = await db.unsafe(data_query, [...params, limit, offset]) as Record[];

						const count_query = `SELECT COUNT(*) as count FROM __table.exact__${where}`;
						const count_result = await db.unsafe(count_query, params);
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

export async function create_record(record: __sql.create_record_arg__): Promise<Record> {
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
}

export async function delete_record_by_parent_id(id: __sql.id_type__, parent_id: __sql.id_type__): Promise<boolean> {
	try {
		return await timed_query("__table.exact__", "delete_by_parent_id", async () => {
			const result = await db`DELETE FROM __table.exact__ WHERE id = ${id} AND __parent.fk_column__ = ${parent_id}`;
			return (result.affectedRows ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("Error deleting record:", error);
		return false;
	}
}

__sql.tag_functions__
__sql.fk_select_functions__
__sql.autocomplete_display_functions__
