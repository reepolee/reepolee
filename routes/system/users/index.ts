import type { RouteDefinition } from "$lib/route_builder";
import { feature_paths } from "$lib/crud_routes";
import { default_language } from "$config/supported_languages";
import { cache } from "$lib/cache";
import { get_global_scopes, get_scope_clause, resolve_scope_key } from "$lib/global_scopes";
import { get_cookie } from "$lib/cookies";
import { get_lang_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { sql_log } from "$lib/logger";
import { get_available_modules } from "$lib/modules";
import { build_pagination_urls, get_limit_numeric, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, get_filter_definitions, load_tags_filter_options, resolve_filters } from "$lib/table_filters";
import type { BunRequest } from "bun";

import { get_users_edit, get_users_new, post_users_bulk_delete, post_users_edit, post_users_validate } from "./handlers";
import { columns, enable_delete, fields } from "./schema/table";
import { validate } from "./schema/validation_server";
import { create_record, search_records } from "./sql";
import { strip_api_sensitive } from "$config/api_blocklist";

const TABLE_NAME = "users";
const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "/system";

const { base_path, entity_path } = feature_paths(route_prefix, feature);

export const system_users_crud = {
	"/users": { GET: get_users_index, POST: post_users_index },
	"/users/new": get_users_new,
	"/users/validate": { POST: post_users_validate },
	"/users/:id/edit": { GET: get_users_edit, POST: post_users_edit },
	"/users/bulk-delete": { POST: post_users_bulk_delete },
};

const SORT_OPTIONS = [
	{ value: "id::asc", label: "ID (Ascending)" },
	{ value: "id::desc", label: "ID (Descending)" },
	{ value: "name::asc", label: "Name (Ascending)" },
	{ value: "name::desc", label: "Name (Descending)" },
	{ value: "email::asc", label: "Email (Ascending)" },
	{ value: "email::desc", label: "Email (Descending)" },
];

// ---------------------------------------------------------------------------
// GET /users - List index
// ---------------------------------------------------------------------------
export async function get_users_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url, 20, ["scope"]);
	const limit_numeric = get_limit_numeric(limit);

	const module_code = route_prefix ? route_prefix.slice(1) : "";
	const _lang = get_lang_from_request(req) || default_language;
	const namespace = `${module_code}.${feature}`;

	const global_scopes = await get_global_scopes(TABLE_NAME, "users", module_code);
	const scope_key = resolve_scope_key(global_scopes, scope as string, get_cookie(req, "scope_users"));
	const scope_clause = scope_key ? await get_scope_clause(TABLE_NAME, scope_key, ctx, "users", module_code) : "";

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	const { labels } = ctx.translations;

	const [tag_filter_options, result] = await Promise.all([
		load_tags_filter_options(raw_filter_definitions, fields, namespace, _lang),
		search_records(query, offset, limit_numeric, order_by, scope_clause, filter_clauses),
	]);

	if (req.headers.get("Accept") === "application/json") {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		const json_records = result.records.map(strip_api_sensitive);
		return Response.json({
			data: json_records,
			total: result.total,
			limit: limit_numeric,
			offset: offset as number,
		});
	}

	// Enrich filter_definitions with translated labels, option lists, and URL param state
	const filter_definitions = enrich_filter_definitions(
		raw_filter_definitions,
		labels,
		filters,
		filter_not,
		tag_filter_options
	);

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

	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_delete));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} auto`;

	return render("index", {
		data: {
			title: "Users",
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
// POST /users - Create new record
// ---------------------------------------------------------------------------

export async function post_users_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
	const module_options = await get_available_modules();
	const params = new URLSearchParams(body);
	const save_action = params.get("_save_action");

	const data = {
		email: params.get("email")?.trim() || "",
		name: params.get("name")?.trim() || "",
		nickname: params.get("nickname")?.trim() || "",
		username: params.get("username")?.trim() || "",
		avatar_filename: params.get("avatar_filename")?.trim() || "",
		verified_at: params.get("verified_at")?.trim() || "",
		hashed_password: params.get("hashed_password")?.trim() || "",
		invitation_code: params.get("invitation_code")?.trim() || "",
		modules_tags: params.get("modules_tags")?.trim() || "",
		previous_hashed_password: params.get("previous_hashed_password")?.trim() || "",
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		return render("form", {
			data: { record: data, errors, action: base_path(), module_options, enable_delete },
			ctx,
		});
	}

	try {
		const created_record = await create_record(valid_data);
		await cache.invalidate(TABLE_NAME);
		sql_log({ s: "Create", t: `${feature}`, r: { ...created_record } }, ctx.user?.username);

		if (save_action === "stay") { return Response.redirect(localized_url(entity_path(created_record.id), _lang), 303); }
		return Response.redirect(localized_url(base_path(), _lang), 303);
	} catch (error) {
		const error_key = error instanceof Error && error.message.toLowerCase().includes("duplicate entry") ? "duplicate_key" : "error_creating_record";
		const error_message = ctx.translations.errors[error_key];
		return render("form", {
			data: {
				save_label: "Shrani zapis",
				title: "New record",
				record: data,
				errors,
				form_errors: error_message,
				action: base_path(),
				module_options,
				enable_delete,
			},
			ctx,
		});
	}
}

export const route_definitions: RouteDefinition[] = [
	{ url: "/system/users", crud: system_users_crud, nav_title_key: "system.users", module: "system" },
];
