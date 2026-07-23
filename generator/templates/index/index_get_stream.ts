/**
 * Streaming GET index handler for render_strategy === "stream".
 *
 * Sends the page shell immediately (layout + controls + DPU markers), then
 * streams record rows and pagination info as <template for="..."> chunks
 * after DB queries resolve. Uses Declarative Partial Updates (DPU)
 * - <?marker>, <?start>/<?end>, and <template for="name">.
 *
 * Shell is rendered via render_to_string() from $lib/render.
 */
export async function get___table.exact___index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	// Read toast cookies so they survive page reload
	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url);
	const limit_numeric = limit === "all" ? 999999 : limit;

	// Derive module_code from route_prefix so scopes are filtered by module
	const module_code = route_prefix ? route_prefix.slice(1) : "";

	// Resolve table scopes (must complete BEFORE stream opens)
	const global_scopes = await get_global_scopes(TABLE_NAME, "__table.exact__", module_code);
	const scope_key = resolve_scope_key(global_scopes, scope as string, get_cookie(req, "scope___table.exact__"));
	const scope_clause = scope_key ? await get_scope_clause(TABLE_NAME, scope_key, ctx, "__table.exact__", module_code) : "";

	// Resolve filter definitions and WHERE clauses from URL params (before stream opens)
	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters);

	// Load FK filter options for filter panel checkboxes (before stream opens)
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

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));

	if (req.headers.get("Accept") === "application/json") {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		__list.strategy__
		const json_records = result.records.map(strip_api_sensitive);
		return Response.json({ data: json_records, total: result.total, limit: limit_numeric, offset: offset as number });
	}

	// Build dynamic grid cols from the columns map (exclude grid: false columns)
	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_delete));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} auto`;

	// Render shell via render_to_string (handles all context merging automatically)
	const shell_html = await render_to_string("index", {
		data: {
			title: "__table.title__",
			records: [],
			query: query || "",
			limit,
			offset: 0,
			order_by,
			total: 0,
			limit_options,
			sort_options: SORT_OPTIONS,
			prev_url: null,
			next_url: null,
			first_url: null,
			last_url: null,
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

	// Collect toast-clear headers before the stream starts
	const response_headers = new Headers({ "Content-Type": "text/html" });
	ctx.toasts?.forEach((element) => {
		response_headers.append("Set-Cookie", `${element.key}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
	});

	const encoder = new TextEncoder();

	// Safely enqueue or close a controller, ignoring errors if the stream was already canceled (browser disconnected).
	function safe_enqueue(controller: ReadableStreamDefaultController, chunk: Uint8Array) {
		try { controller.enqueue(chunk); } catch (e: any) {
			if (e?.code !== "ERR_INVALID_STATE") throw e;
		}
	}
	function safe_close(controller: ReadableStreamDefaultController) {
		try { controller.close(); } catch (e: any) {
			if (e?.code !== "ERR_INVALID_STATE") throw e;
		}
	}

	const stream = new ReadableStream({
		async start(controller) {
			// 1. Send the shell immediately (no DB wait)
			safe_enqueue(controller, encoder.encode(shell_html));

			// 2. Keepalive: periodic comment to reset idleTimeout during slow DB queries
			const keepalive = setInterval(() => {
				safe_enqueue(controller, encoder.encode("<!-- keepalive -->"));
			}, 8_000);

			try {
				__list.strategy__

				// 3. Build pagination with real total (replaces DPU placeholder)
				const { prev_url, next_url, first_url, last_url } = build_pagination_urls(offset, limit_numeric, result.total, query, order_by, scope_key, filters, filter_not);

				// Render the pagination bar as a DPU template chunk.
				// This replaces the <?start name="pagination">Loading…<?end> placeholder.
				// Uses the same SVG icons as the index.ree template for visual consistency.
				const total_digits = result.total.toString().length;
				const pagination_width = `${total_digits * 3 + 4}ch`;
				const pagination_html = `
					<div class="pagination-info">
						${first_url
							? `<a href="${first_url}" role="button">${ICONS.chevrons_left}</a>`
							: ICONS.chevrons_left}
						${prev_url
							? `<a href="${prev_url}" role="button">${ICONS.chevron_left}</a>`
							: ICONS.chevron_left}
						<div style="width: ${pagination_width}; text-align: center">${offset + 1}-${Math.min(offset + limit_numeric, result.total)} / ${result.total}</div>
						${next_url
							? `<a href="${next_url}" role="button">${ICONS.chevron_right}</a>`
							: ICONS.chevron_right}
						${last_url
							? `<a href="${last_url}" role="button">${ICONS.chevrons_right}</a>`
							: ICONS.chevrons_right}
					</div>`;

				safe_enqueue(controller, encoder.encode(
					`<template for="pagination">${pagination_html}<?marker name="pagination"></template>`
				));

				// 4. Handle empty records - send a "No records" message
				if (result.records.length === 0) {
					const empty_html = `<div class="col-span-full p-4">${ctx.translations.ui?.no_records || 'No records found.'}</div>`;
					safe_enqueue(controller, encoder.encode(
						`<template for="records">${empty_html}<?marker name="records"></template>`
					));
				} else {
					// Stream records as DPU template chunks (one chunk per batch)
					// Each chunk replaces the previous <?marker name="records">.
					// TODO: split into batches (e.g. 20 at a time) when result set is large.
					// Uses render_fn to render the index_rows partial (no layout).
					// Render record rows via render_to_string with is_partial for fragment-only output
					const rows_html = await render_to_string("index_rows", {
						data: {
							records: result.records,
							columns,
							grid_cols,
							enable_delete,
						},
						ctx,
						is_partial: true,
					});

					safe_enqueue(controller, encoder.encode(
						`<template for="records">${rows_html}<?marker name="records"></template>`
					));
				}

			} catch (err) {
				console.error("Streaming DB query failed:", err);
				// Use safe_enqueue so an already-disconnected browser doesn't crash the server
				safe_enqueue(controller, encoder.encode(
					`<template for="records">
						<div class="col-span-full p-4 text-red-500">Failed to load records.</div>
						<?marker name="records">
					</template>`
				));
			} finally {
				clearInterval(keepalive);
			}

			safe_close(controller);
		},
	});

	return new Response(stream, { headers: response_headers });
}
