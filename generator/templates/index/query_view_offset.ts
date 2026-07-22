let result: { records: any[]; total: number; };

try {
	result = await get_all_records_view(query, offset, limit_numeric, order_by, scope_clause, filter_clauses);
} catch (e) {
	console.warn("View __view.name__ not found, using table:", e);
	result = await search_records(query, offset, limit_numeric, order_by, scope_clause, filter_clauses);
}
