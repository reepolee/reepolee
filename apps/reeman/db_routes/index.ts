import { navigation } from "./config";
import { feature_paths } from "$lib/crud_routes";
import { build_pagination_urls as build_offset_pagination_urls, get_limit_options, parse_pagination_params as parse_offset_pagination_params } from "$lib/pagination";

import { get_filter_definitions, resolve_filters, enrich_filter_definitions } from "$lib/table_filters";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";

import { search_records } from "./sql";
import { get_route_record_by_url, refresh_db_routes } from "./sql.custom";

import { wants_json } from "$lib/wants_json";
import { strip_api_sensitive } from "$config/api_blocklist";
import { type BunRequest } from "bun";

import { columns, enable_archive, fields, grid_filler } from "./config";
import type { RouteDefinition } from "$lib/route_builder";

import { post_bulk_refresh_routes, post_bulk_remove_route, post_save_route_settings, post_simple_page, post_simple_route } from "../reeman/handlers";
import { load_reeman_data } from "../reeman/page";
import { load_route_settings, route_edit_path } from "./route_settings";
import type { Record as DbRouteRecord } from "./sql";

import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";

export const reeman_db_routes_crud = {
	"/routes": { GET: get_db_routes_index },
	"/routes/bulk-refresh": { POST: post_bulk_refresh_routes },
	"/routes/save-settings": { POST: post_save_route_settings },
	"/routes/bulk-remove": { POST: post_bulk_remove_route },
	// Simple page / simple table page generators, mirroring the `bun reeman`
	// CLI flows. Static paths are matched before the "/routes/:id" param route.
	"/routes/add-page": { GET: get_add_page_form, POST: post_simple_page },
	"/routes/add-table-page": { GET: get_add_table_page_form, POST: post_simple_route },
	"/routes/edit": { GET: get_db_route_edit },
	"/routes/:id": { GET: get_db_route_detail },
};

const route_prefix: string = "";
const DEFAULT_LIMIT = 20;
const SORT_OPTIONS = [
	{ value: "url::asc", field: "url", direction: "asc" },
	{ value: "url::desc", field: "url", direction: "desc" },
	{ value: "table_name::asc", field: "table_name", direction: "asc" },
	{ value: "table_name::desc", field: "table_name", direction: "desc" },
	{ value: "module::asc", field: "module", direction: "asc" },
	{ value: "module::desc", field: "module", direction: "desc" },
];

const { base_path } = feature_paths(route_prefix, "routes");
const parse_pagination_params = (url: string) => parse_offset_pagination_params(url, DEFAULT_LIMIT);
const build_pagination_urls = (
	current_offset: number,
	limit_numeric: number,
	total: number,
	query: string,
	order_by: string,
) => build_offset_pagination_urls(base_path(), current_offset, limit_numeric, total, query, order_by);

export async function get_db_routes_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, filters, filter_not } = parse_pagination_params(req.url);
	const limit_numeric = limit === "all" ? 999999 : limit;

	const reeman_data = await load_reeman_data({ tables: false });

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	const { labels } = ctx.translations;
	const filter_definitions = enrich_filter_definitions(raw_filter_definitions, labels, filters, filter_not, {});

	const all_records = (await refresh_db_routes()).filter((record) => record.table_name !== "users");
	const result = await search_records(query, offset, limit_numeric, order_by, "", filter_clauses);
	result.records = result.records.filter((record) => all_records.some((allowed) => allowed.url === record.url));
	result.total = result.records.length;

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
	const records = result.records.map((record) => ({
		...record,
		edit_path: route_edit_path(record.url),
	}));

	return render("index", {
		data: {
			title: "Routes",
			busy: reeman_data.busy,
			records,
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

export async function get_db_route_detail(req: BunRequest): Promise<Response> {
	const id = Number(req.params.id || 0);

	const { get_record_by_id } = await import("./sql");
	const record = await get_record_by_id(id);
	return render_db_route_detail(req, record);
}

export async function get_db_route_edit(req: BunRequest): Promise<Response> {
	const request_url = new URL(req.url);
	const raw_route_url = request_url.searchParams.get("url");
	const route_url = raw_route_url?.trim() ?? "";

	const record = route_url ? await get_route_record_by_url(route_url) : undefined;
	return render_db_route_detail(req, record);
}

async function render_db_route_detail(req: BunRequest, record: DbRouteRecord | undefined): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	if (!record) {
		return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
	}
	const [reeman_data, route_settings] = await Promise.all([
		load_reeman_data({ tables: false }),
		load_route_settings(record.url),
	]);

	return render("detail", {
		data: {
			busy: reeman_data.busy,
			record,
			route_settings,
			route_detail_path: route_edit_path(record.url),
			helper_names: DEFAULT_HELPER_NAMES,
		},
		ctx,
	});
}

export async function get_add_page_form(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const reeman_data = await load_reeman_data({ tables: false });

	return render("add_page", {
		data: {
			busy: reeman_data.busy,
			modules: reeman_data.modules,
		},
		ctx,
	});
}

export async function get_add_table_page_form(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const [reeman_data, { get_available_tables, get_table_columns }] = await Promise.all([
		load_reeman_data({ tables: false }),
		import("$generator/reeman/db"),
	]);

	const tables = await get_available_tables();
	// Preload each table's columns so the form can populate the field / ORDER BY
	// / WHERE selectors client-side when a table is picked (no round trip).
	const column_lists = await Promise.all(tables.map((t) => get_table_columns(t)));
	const table_columns: Record<string, string[]> = {};
	for (let i = 0; i < tables.length; i++) {
		table_columns[tables[i] as string] = column_lists[i] as string[];
	}

	return render("add_table_page", {
		data: {
			busy: reeman_data.busy,
			modules: reeman_data.modules,
			tables,
			// Stringified for a <script type="application/json"> block the form's
			// client script reads to populate selectors when a table is picked.
			table_columns_json: JSON.stringify(table_columns),
			where_operators: ["=", "!=", "<", "<=", ">", ">=", "LIKE"],
		},
		ctx,
	});
}

export const route_definitions: RouteDefinition[] = [
	{ url: "/routes", crud: reeman_db_routes_crud, nav_title_key: "reeman.db_routes", module: "system", nav_module: null, nav_section_key: navigation.section_key, nav_section_order: navigation.section_order, nav_item_order: navigation.item_order, nav_group_order: navigation.group_order, nav_final_order: navigation.final_order },
];
