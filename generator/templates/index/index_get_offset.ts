export async function get___table.exact___index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	// Read toast cookies so they survive page reload
	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url);
	const limit_numeric = limit === "all" ? 999999 : limit;

	// Derive module_code from route_prefix so scopes are filtered by module
	const module_code = route_prefix ? route_prefix.slice(1) : "";

	// Resolve table scopes
	const global_scopes = await get_global_scopes(TABLE_NAME, "__table.exact__", module_code);
	const scope_key = scope
		|| get_cookie(req, "scope___table.exact__")
		|| global_scopes.find(s => s.is_default)?.scope_key
		|| "";
	const scope_clause = scope_key ? await get_scope_clause(TABLE_NAME, scope_key, ctx, "__table.exact__", module_code) : "";

	// Resolve filter definitions and WHERE clauses from URL params
	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	// Load FK filter options for filter panel checkboxes
	__filter.fk_loader__

	// Enrich filter_definitions with translated labels, option lists, and URL param state
	const { labels } = ctx.translations;
	const filter_definitions = enrich_filter_definitions(
		raw_filter_definitions,
		labels,
		filters,
		filter_not,
		{ __filter.fk_options__ },
	);

	__list.strategy__

	if (req.headers.get("Accept") === "application/json") {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		const json_records = result.records.map(strip_api_sensitive);
		return Response.json({ data: json_records, total: result.total, limit: limit_numeric, offset: offset as number });
	}

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));

	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(offset, limit_numeric, result.total, query, order_by, scope_key, filters);

	// Build dynamic grid cols from the columns map (exclude grid: false columns)
	// Last column gets "auto" so it fills remaining row width
	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_delete));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} auto`;

	return render("index", {
		data:{
			title: "__table.title__",
			records: result.records,
			query: query || "",
			limit,
			offset,
			order_by,
			total: result.total,
			limit_options,
			sort_options: SORT_OPTIONS,
			prev_url,
			next_url,
			first_url,
			last_url,
			global_scopes,
			scope: scope_key,
			columns,
			grid_cols,
			filter_definitions,
			filter_clauses,
			filter_params: filters,
			filter_not_params: filter_not,
			active_filter_count: filter_clauses.length,
			enable_delete,
		},
		ctx,
	});
}
