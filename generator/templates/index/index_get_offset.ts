export async function get___table.exact___index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	// Read toast cookies so they survive page reload
	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url);
	const limit_numeric = limit === "all" ? 999999 : limit;

	// Derive module_code from route_prefix so scopes are filtered by module
	const module_code = route_prefix ? route_prefix.slice(1) : "";

	// Resolve table scopes
	const global_scopes = await get_global_scopes(TABLE_NAME, "__table.exact__", module_code);
	const scope_key = resolve_scope_key(global_scopes, scope as string, get_cookie(req, "scope___table.exact__"));
	const scope_clause = scope_key__archive.scope_guard__ ? await get_scope_clause(TABLE_NAME, scope_key, ctx, "__table.exact__", module_code) : "";
	__archive.filter_setup__

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

	if (wants_json(req)) {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		const json_records = (result.records as unknown as Record<string, unknown>[]).map(strip_api_sensitive);
		return Response.json({ data: json_records, total: result.total, limit: limit_numeric, offset: offset as number });
	}

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));

	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(offset, limit_numeric, result.total, query, order_by, scope_key, filters);

	// Build dynamic grid cols from the columns map (exclude grid: false columns)
	// The trailing grid_filler track absorbs the leftover row width so declared
	// widths are respected instead of being stretched by the content tracks.
	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	// The ws "updated record" marker column sits right after the checkbox
	// column (or leads the grid when the table has no checkbox column).
	const marker_width = "2rem";
	const grid_cols = enable_archive
		? `${grid_widths[0]} ${marker_width} ${grid_widths.slice(1).join(" ")} ${grid_filler}`
		: `${marker_width} ${grid_widths.join(" ")} ${grid_filler}`;

	return render("index", {
		data:{
			page_title: ctx.translations.ui?.index_title,
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
			enable_archive,
			__archive.render_data__
		},
		ctx,
	});
}
