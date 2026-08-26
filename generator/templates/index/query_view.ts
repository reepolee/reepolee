let result: { records: any[]; total: number; };

try {
	result = await get_all_records_view(query, after, before, is_last, limit_numeric, order_by, scope_clause, filter_clauses__sql.locale_arg____archive.view_filter_arg__);
} catch (e) {
	console.warn("View __view.name__ not found, using table:", e);
	result = await search_records(query, after, before, is_last, limit_numeric, order_by, scope_clause, filter_clauses__sql.locale_arg____archive.filter_arg__);
}
