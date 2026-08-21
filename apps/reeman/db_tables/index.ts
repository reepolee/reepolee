import { feature_paths } from "$lib/crud_routes";
import { build_pagination_urls as build_offset_pagination_urls, get_limit_options, parse_pagination_params as parse_offset_pagination_params } from "$lib/pagination";

import { get_filter_definitions, resolve_filters, enrich_filter_definitions } from "$lib/table_filters";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";

import { search_records } from "./sql";
import { get_table_row_count, refresh_db_tables } from "./sql.custom";

import { wants_json } from "$lib/wants_json";
import { strip_api_sensitive } from "$config/api_blocklist";
import { type BunRequest } from "bun";

import { columns, enable_archive, fields, grid_filler } from "./schema/table";
import type { RouteDefinition } from "$lib/route_builder";

import { post_bulk, post_bulk_refresh, post_bulk_schema, post_crud } from "../reeman/handlers";
import { load_reeman_data } from "../reeman/page";

export const reeman_db_tables_crud = {
	"/tables": { GET: get_db_tables_index },
	// Single-table CRUD generation used by the table detail form (was mounted
	// by the removed /generate module - the Tables page now owns it).
	"/crud": { POST: post_crud },
	"/tables/bulk": { POST: post_bulk },
	"/tables/bulk-schema": { POST: post_bulk_schema },
	"/tables/bulk-refresh": { POST: post_bulk_refresh },
	"/tables/:name": { GET: get_db_table_detail },
};

const route_prefix: string = "";
const DEFAULT_LIMIT = 20;
const SORT_OPTIONS = [
	{ value: "name::asc", field: "name", direction: "asc" },
	{ value: "name::desc", field: "name", direction: "desc" },
	{ value: "column_count::asc", field: "column_count", direction: "asc" },
	{ value: "column_count::desc", field: "column_count", direction: "desc" },
	{ value: "fk_count::asc", field: "fk_count", direction: "asc" },
	{ value: "fk_count::desc", field: "fk_count", direction: "desc" },
	{ value: "has_crud::asc", field: "has_crud", direction: "asc" },
	{ value: "has_crud::desc", field: "has_crud", direction: "desc" },
];

const { base_path } = feature_paths(route_prefix, "tables");
const parse_pagination_params = (url: string) => parse_offset_pagination_params(url, DEFAULT_LIMIT);
const build_pagination_urls = (
	current_offset: number,
	limit_numeric: number,
	total: number,
	query: string,
	order_by: string,
) => build_offset_pagination_urls(base_path(), current_offset, limit_numeric, total, query, order_by);

export async function get_db_tables_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, filters, filter_not } = parse_pagination_params(req.url);
	const limit_numeric = limit === "all" ? 999999 : limit;

	const [reeman_data] = await Promise.all([load_reeman_data({ tables: false }), refresh_db_tables()]);

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	const { labels } = ctx.translations;
	const filter_definitions = enrich_filter_definitions(raw_filter_definitions, labels, filters, filter_not, {});

	const result = await search_records(query, offset, limit_numeric, order_by, "", filter_clauses);

	if (wants_json(req)) {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		const json_records = (result.records as unknown as Record<string, unknown>[]).map(strip_api_sensitive);
		return Response.json({ data: json_records, total: result.total, limit: limit_numeric, offset: offset as number });
	}

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));
	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(offset, limit_numeric, result.total, query, order_by);

	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
	const grid_widths = visible_column_entries.map(([, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} ${grid_filler}`;

	return render("index", {
		data: {
			title: "Tables",
			busy: reeman_data.busy,
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
			columns,
			grid_cols,
			filter_definitions,
			filter_clauses,
			filter_params: filters,
			filter_not_params: filter_not,
			active_filter_count: filter_clauses.length,
			enable_archive,
		},
		ctx,
	});
}

export async function get_db_table_detail(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const table = req.params.name ?? "";

	const [reeman_data, { get_grid_column_choices }, row_count, { is_busy }] = await Promise.all([
		load_reeman_data({ tables: false }),
		import("$generator/reeman/db"),
		get_table_row_count(table),
		import("../reeman/actions"),
	]);

	const grid_columns = await get_grid_column_choices(table);

	// This table's own busy state (crud/schema generation for `table`), not
	// the generic "anything running" flag - generating another table
	// concurrently must not disable this page's Generate button.
	const busy = await is_busy(table);

	return render("detail", {
		data: {
			busy,
			modules: reeman_data.modules,
			table,
			row_count,
			grid_columns,
		},
		ctx,
	});
}

export const route_definitions: RouteDefinition[] = [
	{ url: "/tables", crud: reeman_db_tables_crud, nav_title_key: "reeman.db_tables", module: "system", nav_module: null },
];
