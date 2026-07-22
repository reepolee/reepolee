import { default_language } from "$config/supported_languages";
import { feature_paths, redirect_from_referer, run_bulk_delete } from "$lib/crud_routes";
import { cache } from "$lib/cache";
import { get_global_scopes, get_scope_clause } from "$lib/global_scopes";
import { create_toast_cookie, get_cookie } from "$lib/cookies";
import { get_lang_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { sql_log } from "$lib/logger";
import { build_pagination_urls, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, get_filter_definitions, resolve_filters } from "$lib/table_filters";
import { type BunRequest, Cookie } from "bun";

import { columns, enable_delete, fields } from "./schema/table";
import { validate, validate_touched } from "./schema/validation_server";
import { create_record, delete_record, get_record_by_id, search_records, TABLE_NAME, update_record } from "./sql";
import { strip_api_sensitive } from "$config/api_blocklist";

const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "/system";

const { base_path, entity_path } = feature_paths(route_prefix, feature);

const DEFAULT_LIMIT = 20;

const SORT_OPTIONS = [
	{ value: "id::asc", label: "ID (Ascending)" },
	{ value: "id::desc", label: "ID (Descending)" },
	{ value: "code::asc", label: "Code (Ascending)" },
	{ value: "code::desc", label: "Code (Descending)" },
];

export async function post_modules_validate(req: BunRequest): Promise<Response> {
	const [body, ctx] = await Promise.all([req.json(), create_ctx(req, import.meta.dir)]);
	const touched: string[] = body.touched || [];

	const data = { code: body.code || "", name: body.name || "", description: body.description || "" };

	const [errors] = validate_touched(data, touched, ctx.translations.errors);
	const success = Object.keys(errors).length === 0;

	return Response.json({ success, errors }, { status: 200 });
}

export async function get_modules_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	// Read toast cookies so they survive page reload
	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url, DEFAULT_LIMIT, ["scope"]);
	const limit_numeric = limit === "all" ? 999999 : limit;

	// Derive module_code from route_prefix so scopes are filtered by module
	const module_code = route_prefix ? route_prefix.slice(1) : "";

	// Resolve table scopes
	const global_scopes = await get_global_scopes(TABLE_NAME, "modules", module_code);
	const scope_key = scope || get_cookie(req, "scope_modules") || global_scopes.find((s) => s.is_default)?.scope_key || "";
	const scope_clause = scope_key ? await get_scope_clause(
		TABLE_NAME,
		scope_key,
		ctx,
		"modules",
		module_code
	) : "";

	// Resolve filter definitions and WHERE clauses from URL params
	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	// Load FK filter options for filter panel checkboxes

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

	// Build dynamic grid cols from the columns map (exclude grid: false columns)
	// Last column gets "auto" so it fills remaining row width
	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_delete));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} auto`;

	return render("index", {
		data: {
			title: "Modules",
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

export async function post_modules_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
	const params = new URLSearchParams(body);

	const data = {
		code: params.get(`code`)?.trim() || "",
		name: params.get(`name`)?.trim() || "",
		description: params.get(`description`)?.trim() || "",
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		return render("form", {
			data: { record: data, errors, action: base_path(), enable_delete },
			ctx,
		});
	}

	try {
		const created_record = await create_record(valid_data);
		await cache.invalidate(TABLE_NAME);
		sql_log({ s: "Create", t: `${feature}`, r: { ...created_record } }, ctx.user?.username);

		const save_action = params.get("_save_action");
		if (save_action === "stay") {
			// Save: go to edit page for new record
			const route_param_value = created_record.id;
			return Response.redirect(localized_url(entity_path(route_param_value), _lang), 303);
		}
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
				enable_delete,
			},
			ctx,
		});
	}
}

export async function get_modules_new(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	return render("form", {
		data: {
			title: "New record",
			record: { code: "", name: "", description: "" },
			errors: { code: "", name: "", description: "" },
			action: base_path(),
			enable_delete,
		},
		ctx,
	});
}

export async function get_modules_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = req.params.id ? String(req.params.id) : "";
	const record = await get_record_by_id(id);

	if (!record) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	if (req.headers.get("Accept") === "application/json") {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		return Response.json(strip_api_sensitive(record as Record<string, unknown>));
	}

	const bp = base_path();
	return render("form", {
		data: {
			title: `Edit ${record.code}`,
			record,
			back_route: `${bp}?there_should_be_back_params`,
			errors: { code: "", name: "", description: "" },
			action: entity_path(record.id),
			enable_delete,
		},
		ctx,
	});
}

export async function post_modules_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = req.params.id ? String(req.params.id) : "";
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
	const params = new URLSearchParams(body);
	const action = params.get("_action");
	const return_url_from_form = params.get("_return_url");
	const save_action = params.get("_save_action");

	const bp = base_path();
	let redirect_url = localized_url(bp, _lang);
	if (save_action === "stay") {
		// Save: stay on edit page - id is always available from the lookup above
		redirect_url = localized_url(entity_path(id), _lang);
	} else if (return_url_from_form?.includes(bp)) {
		redirect_url = return_url_from_form;
	} else {
		const referer_redirect = redirect_from_referer(req, base_path());
		if (referer_redirect) redirect_url = referer_redirect;
	}
	if (action === "delete") {
		if (!enable_delete) {
			return Response.json({ error: "Delete is disabled." }, { status: 403 });
		}
		try {
			const deleted = await delete_record(id);

			if (deleted) {
				await cache.invalidate(TABLE_NAME);
				sql_log({ s: "Delete", t: `${feature}`, id }, ctx.user?.username);
				return Response.redirect(redirect_url, 303);
			}

			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		} catch (error) {
			const existing_record = await get_record_by_id(id);
			if (!existing_record) {
				return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
			}

			const error_message = error instanceof Error && error.message.includes("foreign key") ? "Cannot delete this record because it's referenced by other records." : "Error deleting record.";

			return render("form", {
				data: {
					title: `Edit ${existing_record.name}`,
					record: existing_record,
					form_errors: error_message,
					errors: {},
					action: entity_path(id),
					enable_delete,
				},
				ctx,
			});
		}
	}

	const data = {
		code: params.get(`code`)?.trim() || "",
		name: params.get(`name`)?.trim() || "",
		description: params.get(`description`)?.trim() || "",
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0) {
		const existing_record = await get_record_by_id(id);
		if (!existing_record) {
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		}
		return render("form", {
			data: {
				title: `Edit ${existing_record.code}`,
				record: { ...existing_record, ...data },
				errors,
				action: entity_path(id),
				enable_delete,
			},
			ctx,
		});
	}

	let record;
	try {
		record = await update_record(id, valid_data);
		await cache.invalidate(TABLE_NAME);
		sql_log({ s: "Update", t: `${feature}`, r: { ...record } }, ctx.user?.username);
	} catch (error) {
		const error_key = error instanceof Error && error.message.toLowerCase().includes("duplicate entry") ? "duplicate_key" : "error_creating_record";

		const error_message = ctx.translations.errors[error_key];

		return render("form", {
			data: {
				record: data,
				errors,
				form_errors: error_message,
				action: entity_path(id),
				enable_delete,
			},
			ctx,
		});
	}

	if (!record) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	const cookie = create_toast_cookie({
		record_id: record.id,
		feature,
		message: ctx.translations.messages.record_updated,
		type: "green",
		user: ctx.user?.display_name,
	});

	const headers = new Headers({ Location: redirect_url });

	headers.append("Set-Cookie", cookie.toString());

	return new Response(null, { status: 303, headers });
}

export async function post_modules_bulk_delete(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	return run_bulk_delete(req, ctx, {
		feature,
		table_name: TABLE_NAME,
		delete_one: (id) => delete_record(Number(id)),
	});
}
