import { db } from "$config/db";
import { timed_query } from "$lib/timed_sql";
import { cache } from "$lib/cache";

export const TABLE_NAME = "__table.exact__";
export const VIEW_DEPENDENCIES = __sql.view_dependencies__;
__view.resolver__

export interface ViewRecord {
	__interface.fields__
}
__sql.archive_helper__
export async function get_all_records_view(search: string = "", offset: number = 0, limit: number = 20, order_by: string = "id::asc", scope_clause: string = "", filter_clauses: { clause: string; params: any[] }[] = []__sql.view_locale_param____sql.archive_param__): Promise<{ records: ViewRecord[], total: number }> {
	try {
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return get_all_records_view(search, offset, limit, "id::asc", scope_clause, filter_clauses__sql.locale_arg____sql.archive_arg__);
		}

		return await timed_query("__view.name__", "get_all_records_view", async () => {
			return cache.search(
				"__sql.route__",
				{ search, offset, limit, order_by, scope_clause, filter_clauses__sql.view_locale_cache_key____sql.archive_cache_key__ },
				__sql.view_cache_dependencies__,
				async () => {
					const view_source = __view.source__;
					let records: ViewRecord[] = [];
					let total: number = 0;

					if (search) {
						const search_term = `%${search}%`;
						const search_where: string[] = [`__search.field__ LIKE ?`__sql.view_locale_search_where__];
						const search_params: any[] = [search_term__sql.view_locale_search_param__];

						__sql.archive_search_push__
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
						const data_query = `SELECT * FROM ${view_source} WHERE ${search_where_clause} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
						records = await db.unsafe(data_query, [...search_params, limit, offset]) as ViewRecord[];

						const count_query = `SELECT COUNT(*) as count FROM ${view_source} WHERE ${search_where_clause}`;
						const count_result = await db.unsafe(count_query, search_params);
						total = (count_result[0] as any)?.count || 0;
					} else {
						const where_clauses: string[] = [__sql.view_locale_where__];
						__sql.archive_push__
						const filter_params: any[] = [__sql.view_locale_filter_param__];

						if (scope_clause) {
							where_clauses.push(`(${scope_clause})`);
						}

						// Apply filter clauses (parameterized)
						for (const filter of filter_clauses) {
							where_clauses.push(`(${filter.clause})`);
							filter_params.push(...filter.params);
						}

						const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(' AND ')}` : '';
						const data_query = `SELECT * FROM ${view_source} ${where} ORDER BY ${sort_field} ${valid_direction.toUpperCase()}, id ${valid_direction.toUpperCase()} LIMIT ? OFFSET ?`;
						records = await db.unsafe(data_query, [...filter_params, limit, offset]) as ViewRecord[];

						const count_where = where_clauses.length > 0 ? ` WHERE ${where_clauses.join(' AND ')}` : '';
						const count_query = `SELECT COUNT(*) as count FROM ${view_source}${count_where}`;
						const count_result = await db.unsafe(count_query, filter_params);
						total = (count_result[0] as any)?.count || 0;
					}

					return { records, total };
				}
			);
		});
	} catch (error) {
		console.error("Error fetching records from view __view.name__:", error);
		throw error;
	}
}
