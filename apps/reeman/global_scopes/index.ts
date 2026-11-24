import { navigation } from "./config";
import type { RouteDefinition } from "$lib/route_builder";
import { feature_paths } from "$lib/crud_routes";
import { default_locale } from "$config/supported_locales";
import { get_available_tables, get_global_scopes, get_scope_clause, resolve_scope_key } from "$lib/global_scopes";
import { get_cookie } from "$lib/cookies";
import { get_locale_from_request, localized_url } from "$lib/route";
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
	post_global_scopes_bulk_archive,
	post_global_scopes_test_scope,
	post_global_scopes_validate,
} from "./handlers";
import { columns, enable_archive, fields } from "./config";
import { validate } from "./validation_server";
import { is_archive_scope_key, resolve_archive_filter } from "$lib/archive";
import { create_record, get_archive_counts, resolve_global_scope_list_filter, search_records } from "./sql";

export { enable_archive };

export const system_global_scopes_crud = {
	"/global_scopes": { GET: get_global_scopes_index, POST: post_global_scopes_index },
	"/global_scopes/new": get_global_scopes_new,
	"/global_scopes/validate": { POST: post_global_scopes_validate },
	"/global_scopes/test-scope": { POST: post_global_scopes_test_scope },
	"/global_scopes/:id/edit": { GET: get_global_scopes_edit, POST: post_global_scopes_edit },
	"/global_scopes/bulk-archive": { POST: post_global_scopes_bulk_archive },
};

const TABLE_NAME = "global_scopes";
const feature = get_table_name_from_dir(import.meta.dir);

const { base_path } = feature_paths("", feature);

const SORT_OPTIONS = [
	{ value: "id::asc", field: "id", direction: "asc" },
	{ value: "id::desc", field: "id", direction: "desc" },
	{ value: "table_name::asc", field: "table_name", direction: "asc" },
	{ value: "table_name::desc", field: "table_name", direction: "desc" },
	{ value: "scope_key::asc", field: "scope_key", direction: "asc" },
	{ value: "scope_key::desc", field: "scope_key", direction: "desc" },
];

// ---------------------------------------------------------------------------
// GET /global_scopes - List index
// ---------------------------------------------------------------------------

export async function get_global_scopes_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, scope, filters, filter_not, list_filter: raw_list_filter } = parse_pagination_params(req.url, 20, ["scope", "list_filter"]);
	const list_filter = resolve_global_scope_list_filter(raw_list_filter as string);
	const limit_numeric = get_limit_numeric(limit);

	// The reeman app is the system app: global scopes resolve under the "system"
	// module code even though the page is served at root (/global_scopes).
	const module_code = "system";

	const global_scopes = await get_global_scopes(TABLE_NAME, "global_scopes", module_code);
	const scope_key = resolve_scope_key(global_scopes, scope as string, get_cookie(req, "scope_global_scopes"));
	const archive_filter = resolve_archive_filter(scope_key);
	const scope_clause = scope_key && !is_archive_scope_key(scope_key) ? await get_scope_clause(
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

	const result = await search_records(query, offset, limit_numeric, order_by, scope_clause, filter_clauses, archive_filter, list_filter);
	const archive_counts = await get_archive_counts(scope_clause);

	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
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
		filters,
		filter_not,
		{ list_filter }
	);

	return render("index", {
		data: {
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
			archive_counts,
			archive_filter,
			list_filter,
			enable_archive,
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
	const _lang = get_locale_from_request(req) || default_locale;
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

	if (Object.keys(errors).length > 0 || !valid_data) {
		const [module_options, table_options] = await Promise.all([get_available_modules(), get_available_tables()]);
		return render("form", {
			data: {
				page_title: ctx.translations.ui?.new_title,
				record: { ...data, table: data.table_name },
				errors,
				form_errors: null,
				action: base_path(),
				module_options,
				table_options,
				enable_archive,
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
				page_title: ctx.translations.ui?.new_title,
				record: { ...data, table: data.table_name },
				errors,
				form_errors: error_message,
				action: base_path(),
				module_options,
				table_options,
				enable_archive,
			},
			ctx,
		});
	}
}

export const route_definitions: RouteDefinition[] = [
	{
		url: "/global_scopes",
		crud: system_global_scopes_crud,
		nav_title_key: "reeman.global_scopes",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_section_order: navigation.section_order,
		nav_item_order: navigation.item_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
