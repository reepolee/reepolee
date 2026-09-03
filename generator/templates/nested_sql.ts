import { db } from "$config/db";
import { timed_query } from "$lib/timed_sql";
import { cache } from "$lib/cache";
__sql.localized_import__

export const TABLE_NAME = "__table.exact__";
export const VIEW_DEPENDENCIES = __sql.view_dependencies__;
__sql.localized_config__
__sql.locale_resolver__

export interface Record {
	__interface.fields__
}

export interface Options {
	option_value: number | string;
	option_text: string;
}
__sql.archive_helper__
export async function get_children_by_parent(parent_id: __sql.id_type____sql.locale_param__): Promise<Record[]> {
	try {
		return await timed_query("__table.exact__", "get_children_by_parent", async () => {
			const from_source = __sql.read_source__;
			const records = await db.unsafe(`SELECT * FROM ${from_source} WHERE __parent.fk_column__ = ?__sql.archive_and__ ORDER BY id ASC`, [parent_id]);
			return records as Record[];
		});
	} catch (error) {
		console.error("Error fetching children by parent:", error);
		return [];
	}
}

export async function get_record_by_id_and_parent(id: __sql.id_type__, parent_id: __sql.id_type____sql.locale_param__): Promise<Record | undefined> {
	try {
		return await timed_query("__table.exact__", "get_record_by_id_and_parent", async () => {
			const from_source = __sql.read_source__;
			const records = await db.unsafe(`SELECT * FROM ${from_source} WHERE id = ? AND __parent.fk_column__ = ?__sql.archive_and__ LIMIT 1`, [id, parent_id]);
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error fetching record by id and parent:", error);
		return undefined;
	}
}

export async function get_record_by_id(id: __sql.id_type____sql.locale_param____sql.include_archived_param__): Promise<Record | undefined> {
	try {
		return await timed_query("__table.exact__", "get_record_by_id", async () => {
			__sql.include_archived_setup__
			const from_source = __sql.read_source__;
			const by_id_query = `SELECT * FROM ${from_source} WHERE id = ?__sql.include_archived_sql__ LIMIT 1`;
			const records = await db.unsafe(by_id_query, [id]) as Record[];
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
export async function search_records(search: string = "", offset: number = 0, limit: number = 20, order_by: string = "id::asc", parent_id?: __sql.id_type__, scope_clause: string = "", filter_clauses: { clause: string; params: any[] }[] = []__sql.archive_param__): Promise<{ records: Record[], total: number }> {
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

					__sql.archive_parts_push__

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
			__sql.create_fan_out__
			__sql.create_record_return__
		});
	} catch (error) {
		console.error("Error creating record:", error);
		throw error;
	}
}

export async function update_record(id: __sql.id_type__, record: __sql.update_record_arg____sql.write_locale_param__): Promise<Record | undefined> {
	try {
		return await timed_query("__table.exact__", "update_record", async () => {
			__sql.update_fan_out__
			const records = await db`SELECT * FROM __table.exact__ WHERE id = ${id} LIMIT 1`;
			return records[0] as Record | undefined;
		});
	} catch (error) {
		console.error("Error updating record:", error);
		throw error;
	}
}

export async function __sql.archive_record_fn__(id: __sql.id_type____sql.archive_by_param__): Promise<boolean> {
	try {
		return await timed_query("__table.exact__", "__sql.archive_record_fn__", async () => {
			__sql.nested_delete_write__
			return (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("__sql.archive_error_log__", error);
		const error_msg = error instanceof Error ? error.message : String(error);
		if (error_msg.includes("foreign key")) {
			throw error;
		}
		return false;
	}
}

export async function __sql.archive_record_by_parent_id_fn__(id: __sql.id_type__, parent_id: __sql.id_type____sql.archive_by_param__): Promise<boolean> {
	try {
		return await timed_query("__table.exact__", "delete_by_parent_id", async () => {
			__sql.nested_delete_parent_write__
			return (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
		});
	} catch (error) {
		console.error("__sql.archive_error_log__", error);
		return false;
	}
}

__sql.tag_functions__
__sql.fk_select_functions__
__sql.autocomplete_display_functions__
__sql.restore_function__
