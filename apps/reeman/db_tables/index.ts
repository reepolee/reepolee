import { navigation } from "./config";
import { feature_paths } from "$lib/crud_routes";
import { build_pagination_urls as build_offset_pagination_urls, get_limit_options, parse_pagination_params as parse_offset_pagination_params } from "$lib/pagination";

import { get_filter_definitions, resolve_filters, enrich_filter_definitions } from "$lib/table_filters";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";

import { resolve_db_tables_list_filter, search_records } from "./sql";
import { get_table_sample_records, get_table_row_count } from "./sql.custom";

import { wants_json } from "$lib/wants_json";
import { strip_api_sensitive } from "$config/api_blocklist";
import { type BunRequest } from "bun";
import { localized_url, resolve_locale } from "$lib/route";

import { columns, enable_archive, fields, grid_filler } from "./config";
import type { RouteDefinition } from "$lib/route_builder";

import { post_bulk, post_bulk_refresh, post_bulk_schema, post_crud } from "../reeman/handlers";
import { load_reeman_data } from "../reeman/page";
import { discover_routes_with_schema } from "$generator/reeman/utils/route_scan";
import { route_edit_paths_by_table } from "../db_routes/route_settings";

import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";

export const reeman_db_tables_crud = {
	"/tables": { GET: get_db_tables_index },
	"/tables/new": { GET: get_db_tables_new },
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
const parse_pagination_params = (url: string) => parse_offset_pagination_params(url, DEFAULT_LIMIT, ["list_filter"]);
const build_pagination_urls = (
	current_offset: number,
	limit_numeric: number,
	total: number,
	query: string,
	order_by: string,
	list_filter: string,
	filters: Record<string, string>,
	filter_not: Record<string, string>,
) => build_offset_pagination_urls(base_path(), current_offset, limit_numeric, total, query, order_by, "", filters, filter_not, { list_filter });

export async function get_db_tables_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, list_filter: raw_list_filter, filters, filter_not } = parse_pagination_params(req.url);
	const limit_numeric = limit === "all" ? 999999 : limit;
	const list_filter = resolve_db_tables_list_filter(raw_list_filter as string);
	const include_system_tables = list_filter === "all";

	const reeman_data = await load_reeman_data({ tables: false });

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	const { labels } = ctx.translations;
	const filter_definitions = enrich_filter_definitions(raw_filter_definitions, labels, filters, filter_not, {});

	const result = await search_records(query, offset, limit_numeric, order_by, "", filter_clauses, include_system_tables);

	if (wants_json(req)) {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		const json_records = (result.records as unknown as Record<string, unknown>[]).map(strip_api_sensitive);
		return Response.json({ data: json_records, total: result.total, limit: limit_numeric, offset: offset as number });
	}

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));
	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(offset, limit_numeric, result.total, query, order_by, list_filter, filters, filter_not);

	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
	const grid_widths = visible_column_entries.map(([, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} ${grid_filler}`;
	const routes_with_schema = discover_routes_with_schema();
	const route_edit_paths = route_edit_paths_by_table(routes_with_schema);

	return render("index", {
		data: {
			page_title: ctx.translations.ui?.index_title,
			busy: reeman_data.busy,
			modules: reeman_data.modules,
			records: result.records,
			query: query || "",
			limit,
			offset,
			order_by,
			total: result.total,
			limit_options,
			sort_options: SORT_OPTIONS,
			list_filter,
			prev_url,
			next_url,
			first_url,
			last_url,
			columns,
			grid_cols,
			route_edit_paths,
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
	const table = req.params.name ?? "";
	const request_url = new URL(req.url);
	const new_route = request_url.searchParams.get("new_route") === "1";
	const routes_with_schema = discover_routes_with_schema();
	const route_edit_paths = route_edit_paths_by_table(routes_with_schema);
	const route_edit_url = route_edit_paths[table];
	if (route_edit_url && !new_route) {
		const localized_edit_url = localized_url(route_edit_url, resolve_locale(req));
		return Response.redirect(localized_edit_url, 302);
	}

	const ctx = await create_ctx(req, import.meta.dir);

	const [reeman_data, { get_grid_column_choices }, row_count, { is_busy }] = await Promise.all([
		load_reeman_data({ tables: false }),
		import("$generator/reeman/db"),
		get_table_row_count(table),
		import("../reeman/actions"),
	]);

	const grid_columns = await get_grid_column_choices(table);
	const sample_data = await get_table_sample_records(table, grid_columns.map((column) => column.name));
	const sample_grid_cols = sample_data.columns.map(() => "auto").join(" ") || "auto";

	// This table's own busy state (crud/schema generation for `table`), not
	// the generic "anything running" flag - generating another table
	// concurrently must not disable this page's Generate button.
	const busy = await is_busy(table);

	return render("detail", {
		data: {
			page_title: ctx.translations.ui?.edit_title,
			busy,
			modules: reeman_data.modules,
			new_route,
			table,
			row_count,
			grid_columns,
			sample_columns: sample_data.columns,
			sample_records: sample_data.records,
			sample_grid_cols,
			helper_names: DEFAULT_HELPER_NAMES,
		},
		ctx,
	});
}

export async function get_db_tables_new(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const request_url = new URL(req.url);
	const raw_tables = request_url.searchParams.getAll("tables");
	const trimmed_tables = raw_tables.map((table) => table.trim());
	const requested_tables = trimmed_tables.filter(Boolean);
	const reeman_data = await load_reeman_data();
	const available_table_names = reeman_data.tables.map((table) => table.name);
	const available_tables = new Set(available_table_names);
	const selected_tables: string[] = [];
	const selected_table_names = new Set<string>();

	for (const table of requested_tables) {
		if (!available_tables.has(table) || selected_table_names.has(table)) continue;
		selected_table_names.add(table);
		selected_tables.push(table);
	}

	return render("new", {
		data: {
			page_title: ctx.translations.actions?.generate_crud,
			busy: reeman_data.busy,
			modules: reeman_data.modules,
			selected_tables,
			return_to: "/tables",
			valid_selection: selected_tables.length > 0,
		},
		ctx,
	});
}

export const route_definitions: RouteDefinition[] = [
	{ url: "/tables", crud: reeman_db_tables_crud, nav_title_key: "reeman.db_tables", module: "system", nav_module: null, nav_section_key: navigation.section_key, nav_section_order: navigation.section_order, nav_item_order: navigation.item_order, nav_group_order: navigation.group_order, nav_final_order: navigation.final_order },
];
