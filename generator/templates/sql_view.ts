import { db } from "$config/db";
import { timed_query } from "$lib/timed_sql";
import { cache } from "$lib/cache";

export const TABLE_NAME = "__table.exact__";
export const VIEW_DEPENDENCIES = __sql.view_dependencies__;

export interface ViewRecord {
	__interface.fields__
}

export async function get_all_records_view(search: string = "", after: string | null = null, before: string | null = null, is_last: boolean = false, limit: number = 20, order_by: string = "id::asc", scope_clause: string = "", filter_clauses: { clause: string; params: any[] }[] = []): Promise<{ records: ViewRecord[], total: number }> {
	try {
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return get_all_records_view(search, after, before, is_last, limit, "id::asc", scope_clause);
		}

		return await timed_query("__view.name__", "get_all_records_view", async () => {
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

					// Apply filter clauses (parameterized) - also applied to search path
					// because __search.block__ above may have already added search conditions
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
					const data_query = `SELECT * FROM __view.name__ ${where} ORDER BY ${sort_field} ${query_direction.toUpperCase()}, id ${query_direction.toUpperCase()} LIMIT ?`;
					// Fetch limit+1 to accurately detect if a next page exists
					params.push(limit + 1);

					const records = await db.unsafe(data_query, params) as ViewRecord[];

					// Count query (without cursor filters - just search)
					let total: number = 0;
					__search.count_block__
					if (!search) {
						const count_where_clauses: string[] = [];
						if (scope_clause) {
							count_where_clauses.push(`(${scope_clause})`);
						}
						const count_where = count_where_clauses.length > 0 ? ` WHERE ${count_where_clauses.join(' AND ')}` : '';
						const count_query = `SELECT COUNT(*) as count FROM __view.name__${count_where}`;
						const count_result = await db.unsafe(count_query);
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
		console.error("Error fetching records from view __view.name__:", error);
		return { records: [], total: 0 };
	}
}
