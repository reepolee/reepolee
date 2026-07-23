import type { RouteDefinition } from "$lib/route_builder";
import { feature_paths } from "$lib/crud_routes";
import { default_language } from "$config/supported_languages";
import { get_available_tables, get_global_scopes, get_scope_clause, resolve_scope_key } from "$lib/global_scopes";
import { get_cookie } from "$lib/cookies";
import { get_lang_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { sql_log } from "$lib/logger";
import { get_available_modules } from "$lib/modules";
import { build_pagination_urls, get_limit_numeric, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, get_filter_definitions, resolve_filters } from "$lib/table_filters";
import type { BunRequest } from "bun";

import { post_global_scopes_edit } from "./edit_handlers";
import {
	get_global_scopes_edit,
	get_global_scopes_new,
	post_global_scopes_bulk_delete,
	post_global_scopes_test_scope,
	post_global_scopes_validate,
} from "./handlers";
import { columns, enable_delete, fields } from "./schema/table";
import { validate } from "./schema/validation_server";
import { create_record, search_records } from "./sql";

export { enable_delete };

export const system_global_scopes_crud = {
	"/global_scopes": { GET: get_global_scopes_index, POST: post_global_scopes_index },
	"/global_scopes/new": get_global_scopes_new,
	"/global_scopes/validate": { POST: post_global_scopes_validate },
	"/global_scopes/test-scope": { POST: post_global_scopes_test_scope },
	"/global_scopes/:id/edit": { GET: get_global_scopes_edit, POST: post_global_scopes_edit },
	"/global_scopes/bulk-delete": { POST: post_global_scopes_bulk_delete },
};

const TABLE_NAME = "global_scopes";
const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "/system";

const { base_path } = feature_paths(route_prefix, feature);

const SORT_OPTIONS = [
	{ value: "id::asc", label: "ID (Ascending)" },
	{ value: "id::desc", label: "ID (Descending)" },
	{ value: "table_name::asc", label: "Table name (Ascending)" },
	{ value: "table_name::desc", label: "Table name (Descending)" },
	{ value: "scope_key::asc", label: "Scope key (Ascending)" },
	{ value: "scope_key::desc", label: "Scope key (Descending)" },
];

// ---------------------------------------------------------------------------
// GET /global_scopes - List index
// ---------------------------------------------------------------------------

export async function get_global_scopes_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url, 20, ["scope"]);
	const limit_numeric = get_limit_numeric(limit);

	const module_code = route_prefix ? route_prefix.slice(1) : "";

	const global_scopes = await get_global_scopes(TABLE_NAME, "global_scopes", module_code);
	const scope_key = resolve_scope_key(global_scopes, scope as string, get_cookie(req, "scope_global_scopes"));
	const scope_clause = scope_key ? await get_scope_clause(
		TABLE_NAME,
		scope_key,
		ctx,
		"global_scopes",
		module_code
	) : "";

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	// Enrich filter_definitions with translated labels, option lists, and URL param state
	const { labels } = ctx.translations;
	const filter_definitions = enrich_filter_definitions(
		raw_filter_definitions,
		labels,
		filters,
		filter_not,
		{}
	);

	const result = await search_records(query, offset, limit_numeric, order_by, scope_clause, filter_clauses);

	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_delete));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} auto`;

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));

	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(
		base_path(),
		offset,
		limit_numeric,
		result.total,
		query,
		order_by,
		scope_key,
		filters
	);

	return render("index", {
		data: {
			title: "Global Scopes",
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

// ---------------------------------------------------------------------------
// POST /global_scopes - Create new record
// ---------------------------------------------------------------------------

export async function post_global_scopes_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
	const params = new URLSearchParams(body);

	const data = {
		module_code: params.get("module_code")?.trim() || "",
		feature_name: params.get("feature_name")?.trim() || "",
		table_name: params.get("table")?.trim() || "",
		scope_key: params.get("scope_key")?.trim() || "",
		display_name: params.get("display_name")?.trim() || "",
		where_clause: params.get("where_clause")?.trim() || "",
		sort_order: params.get("sort_order")?.trim() || "",
		is_default: params.get("is_default")?.trim() || "",
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		const [module_options, table_options] = await Promise.all([get_available_modules(), get_available_tables()]);
		return render("form", {
			data: {
				record: { ...data, table: data.table_name },
				errors,
				action: base_path(),
				module_options,
				table_options,
				enable_delete,
			},
			ctx,
		});
	}

	try {
		const created_record = await create_record(valid_data);
		sql_log({ s: "Create", t: `${feature}`, r: { ...created_record } }, ctx.user?.username);
		return Response.redirect(localized_url(base_path(), _lang), 303);
	} catch (error) {
		const error_key = error instanceof Error && error.message.toLowerCase().includes("duplicate entry") ? "duplicate_key" : "error_creating_record";
		const error_message = ctx.translations.errors[error_key];
		const [module_options, table_options] = await Promise.all([get_available_modules(), get_available_tables()]);
		return render("form", {
			data: {
				save_label: "Shrani zapis",
				title: "New record",
				record: { ...data, table: data.table_name },
				errors,
				form_errors: error_message,
				action: base_path(),
				module_options,
				table_options,
				enable_delete,
			},
			ctx,
		});
	}
}

export const route_definitions: RouteDefinition[] = [
	{
		url: "/system/global_scopes",
		crud: system_global_scopes_crud,
		nav_title_key: "system.global_scopes",
		module: "system",
	},
];
