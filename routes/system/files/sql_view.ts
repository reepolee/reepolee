import { db } from "$config/db";
import { get_fulltext_clause, get_fulltext_param } from "$lib/sql_dialect";
import { timed_query } from "$lib/timed_sql";

// db.unsafe() - legacy manual CRUD (view-based). Uses dynamic ORDER BY via sort_field regex validation.
// Migrate to generator template (generator/templates/sql_view.ts) when regenerating this route.

export interface ViewRecord {
	id: number;
	folder: string;
	filename: string;
	s3_key: string;
	original_filename: string;
	title: string;
	description: string;
	tags: string;
	mime_type: string;
	file_type: string;
	file_size: number;
	search_text: string;
}

export async function get_all_records_view(
	search: string = "",
	after: string | null = null,
	before: string | null = null,
	is_last: boolean = false,
	limit: number = 20,
	order_by: string = "id::asc",
	scope_clause: string = "",
): Promise<{ records: ViewRecord[]; total: number; }> {
	try {
		const parts = order_by.split("::");
		const sort_field = parts[0] || "id";
		const sort_direction = parts[1] || "asc";
		const valid_direction = ["asc", "desc"].includes(sort_direction?.toLowerCase() || "") ? sort_direction.toLowerCase() : "asc";

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sort_field)) {
			return get_all_records_view(search, after, before, is_last, limit, "id::asc", scope_clause);
		}

		return await timed_query("v_files", "get_all_records_view", async () => {
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
					cursor_id = typeof cursor_parts[0] === "number" ? cursor_parts[0] : null;
					cursor_value = cursor_parts[1] != null ? String(cursor_parts[1]) : null;
				} catch {
					console.warn("Invalid cursor format:", cursor_str);
				}
			}

			// Build WHERE clauses and params
			const where_clauses: string[] = [];
			const params: any[] = [];

			if (search) {
				const search_term = search;
				where_clauses.push(get_fulltext_clause());
				params.push(get_fulltext_param(search_term));
			}

			if (scope_clause) { where_clauses.push(`(${scope_clause})`); }

			if (cursor_id !== null && cursor_value !== null) {
				if (query_direction === "asc") {
					where_clauses.push(`(${sort_field} > ? OR (${sort_field} = ? AND id > ?))`);
				} else {
					where_clauses.push(`(${sort_field} < ? OR (${sort_field} = ? AND id < ?))`);
				}
				params.push(cursor_value, cursor_value, cursor_id);
			}

			const where = where_clauses.length > 0 ? `WHERE ${where_clauses.join(" AND ")}` : "";
			const data_query = `SELECT * FROM v_files ${where} ORDER BY ${sort_field} ${query_direction.toUpperCase()}, id ${query_direction.toUpperCase()} LIMIT ?`;
			params.push(limit);

			const records = (await db.unsafe(data_query, params)) as ViewRecord[];

			// Count query (without cursor filters - just search)
			let total: number = 0;
			if (search) {
				const count_params: any[] = [get_fulltext_param(search)];
				const count_query = `SELECT COUNT(*) as count FROM v_files WHERE ${get_fulltext_clause()}`;
				const count_result = await db.unsafe(count_query, count_params);
				total = (count_result[0] as any)?.count || 0;
			}
			if (!search) {
				const count_where_clauses: string[] = [];
				if (scope_clause) { count_where_clauses.push(`(${scope_clause})`); }
				const count_where = count_where_clauses.length > 0 ? ` WHERE ${count_where_clauses.join(" AND ")}` : "";
				const count_query = `SELECT COUNT(*) as count FROM v_files${count_where}`;
				const count_result = await db.unsafe(count_query);
				total = (count_result[0] as any)?.count || 0;
			}

			// Reverse for backward navigation so records are always in ASC order
			if (need_reverse) { records.reverse(); }

			return { records, total };
		});
	} catch (error) {
		console.error("Error fetching records from view v_files:", error);
		return { records: [], total: 0 };
	}
}
