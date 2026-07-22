import type { PaginationStrategy, RenderStrategy } from "./types";

export interface TemplateNames {
	// In generator/templates/
	sql: string;
	sql_view: string;

	// In generator/templates/index/
	header: string;
	index_get: string;
	index_post: string;
	new_get: string;
	edit_get: string;
	edit_post: string;
	index_bulk_delete: string;
	route_export: string;
	query: string;
}

export function select_templates(opts: { pagination_strategy: PaginationStrategy; render_strategy: RenderStrategy; is_nested: boolean; has_view: boolean; }): TemplateNames {
	const { pagination_strategy: pg, render_strategy: rs, is_nested, has_view } = opts;

	const sql = is_nested ? "nested_sql.ts" : pg === "offset" ? "sql_offset.ts" : "sql.ts";

	const sql_view = pg === "offset" ? "sql_view_offset.ts" : "sql_view.ts";

	const header = is_nested ? "nested_header.ts" : pg === "offset" ? "header_offset.ts" : "header.ts";

	const index_get = is_nested ? "" : rs === "stream" ? pg === "cursor" ? "index_get_stream_cursor.ts" : "index_get_stream.ts" : pg === "offset" ? "index_get_offset.ts" : "index_get.ts";

	const query = has_view ? pg === "offset" ? "query_view_offset.ts" : "query_view.ts" : pg === "offset" ? "query_table_offset.ts" : "query_table.ts";

	return {
		sql,
		sql_view,
		header,
		index_get,
		index_post: is_nested ? "nested_index_post.ts" : "index_post.ts",
		new_get: is_nested ? "" : "new_get.ts",
		edit_get: is_nested ? "nested_edit_get.ts" : "edit_get.ts",
		edit_post: is_nested ? "nested_edit_post.ts" : "edit_post.ts",
		index_bulk_delete: is_nested ? "" : "index_bulk_delete.ts",
		route_export: is_nested ? "nested_route_export.ts" : "route_export.ts",
		query,
	};
}
