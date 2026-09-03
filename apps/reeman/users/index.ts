import { navigation } from "./config";
import type { RouteDefinition } from "$lib/route_builder";
import { feature_paths } from "$lib/crud_routes";
import { default_locale } from "$config/supported_locales";
import { cache } from "$lib/cache";
import { get_global_scopes, get_scope_clause, resolve_scope_key } from "$lib/global_scopes";
import { get_cookie } from "$lib/cookies";
import { get_locale_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { sql_log } from "$lib/logger";
import { get_available_modules } from "$lib/modules";
import { build_pagination_urls, get_limit_numeric, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, get_filter_definitions, load_tags_filter_options, resolve_filters } from "$lib/table_filters";
import type { BunRequest } from "bun";

import { get_users_edit, get_users_new, post_users_bulk_archive, post_users_edit, post_users_validate } from "./handlers";
import { columns, enable_archive, fields } from "./config";
import { validate } from "./validation_server";
import { is_archive_scope_key, resolve_archive_filter } from "$lib/archive";
import { create_record, get_archive_counts, search_records, strip_log_sensitive } from "./sql";
import { strip_api_sensitive } from "$config/api_blocklist";
import { wants_json } from "$lib/wants_json";

const TABLE_NAME = "users";
const feature = get_table_name_from_dir(import.meta.dir);

const { base_path, entity_path } = feature_paths("", feature);

export const system_users_crud = {
	"/users": { GET: get_users_index, POST: post_users_index },
	"/users/new": get_users_new,
	"/users/validate": { POST: post_users_validate },
	"/users/:id/edit": { GET: get_users_edit, POST: post_users_edit },
	"/users/bulk-archive": { POST: post_users_bulk_archive },
};

const SORT_OPTIONS = [
	{ value: "id::asc", field: "id", direction: "asc" },
	{ value: "id::desc", field: "id", direction: "desc" },
	{ value: "name::asc", field: "name", direction: "asc" },
	{ value: "name::desc", field: "name", direction: "desc" },
	{ value: "email::asc", field: "email", direction: "asc" },
	{ value: "email::desc", field: "email", direction: "desc" },
];

// ---------------------------------------------------------------------------
// GET /users - List index
// ---------------------------------------------------------------------------
export async function get_users_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url, 20, ["scope"]);
	const limit_numeric = get_limit_numeric(limit);

	// The reeman app is the system app: global scopes on users resolve under the
	// "system" module code even though the page is served at root (/users).
	const module_code = "system";
	const _lang = get_locale_from_request(req) || default_locale;
	// Translations namespace is scoped under reeman (apps/reeman/users -> "reeman.users");
	// the "system" module code is kept below for global-scope resolution only.
	const namespace = feature;

	const global_scopes = await get_global_scopes(TABLE_NAME, "users", module_code);
	const scope_key = resolve_scope_key(global_scopes, scope as string, get_cookie(req, "scope_users"));
	const archive_filter = resolve_archive_filter(scope_key);
	const scope_clause = scope_key && !is_archive_scope_key(scope_key) ? await get_scope_clause(TABLE_NAME, scope_key, ctx, "users", module_code) : "";

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	const { labels } = ctx.translations;

	const [tag_filter_options, result, archive_counts] = await Promise.all([
		load_tags_filter_options(raw_filter_definitions, fields, namespace, _lang),
		search_records(query, offset, limit_numeric, order_by, scope_clause, filter_clauses, archive_filter),
		get_archive_counts(scope_clause),
	]);

	if (wants_json(req)) {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		const json_records = (result.records as unknown as Record<string, unknown>[]).map(strip_api_sensitive);
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
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
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
			archive_counts,
			archive_filter,
			enable_archive,
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
	const _lang = get_locale_from_request(req) || default_locale;
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

	if (Object.keys(errors).length > 0 || !valid_data) {
		return render("form", {
			data: { record: data, errors, form_errors: null, action: base_path(), module_options, enable_archive },
			ctx,
		});
	}

	try {
		const created_record = await create_record(valid_data);
		await cache.invalidate(TABLE_NAME);
		sql_log({ s: "Create", t: `${feature}`, r: strip_log_sensitive(created_record) }, ctx.user?.username);

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
				enable_archive,
			},
			ctx,
		});
	}
}

export const route_definitions: RouteDefinition[] = [
	{ url: "/users", crud: system_users_crud, nav_title_key: "reeman.users", module: "system", nav_module: null, nav_section_key: navigation.section_key, nav_section_order: navigation.section_order, nav_item_order: navigation.item_order, nav_group_order: navigation.group_order, nav_final_order: navigation.final_order },
];
