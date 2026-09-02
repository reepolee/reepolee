import { default_locale } from "$config/supported_locales";
import { feature_paths, redirect_from_referer, run_bulk_remove } from "$lib/crud_routes";
import { cache } from "$lib/cache";
import { get_global_scopes, get_scope_clause, resolve_scope_key } from "$lib/global_scopes";
import { is_archive_scope_key, resolve_archive_filter } from "$lib/archive";
import { create_toast_cookie, get_cookie } from "$lib/cookies";
import { get_locale_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { sql_log } from "$lib/logger";
import { build_pagination_urls, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, get_filter_definitions, resolve_filters } from "$lib/table_filters";
import { type BunRequest, Cookie } from "bun";

import { columns, enable_archive, fields } from "./config";
import { validate, validate_touched } from "./validation_server";
import { create_record, archive_record, get_archive_counts, get_record_by_id, restore_record, search_records, TABLE_NAME, update_record } from "./sql";
import { strip_api_sensitive } from "$config/api_blocklist";
import { wants_json } from "$lib/wants_json";

const feature = get_table_name_from_dir(import.meta.dir);

const { base_path, entity_path } = feature_paths("", feature);

const DEFAULT_LIMIT = 20;

const SORT_OPTIONS = [
	{ value: "id::asc", field: "id", direction: "asc" },
	{ value: "id::desc", field: "id", direction: "desc" },
	{ value: "code::asc", field: "code", direction: "asc" },
	{ value: "code::desc", field: "code", direction: "desc" },
];

export async function post_modules_validate(req: BunRequest): Promise<Response> {
	const [body, ctx] = await Promise.all([req.json() as Promise<Record<string, any>>, create_ctx(req, import.meta.dir)]);
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

	// The reeman app is the system app: global scopes on modules resolve under
	// the "system" module code even though the page is served at root (/modules).
	const module_code = "system";

	// Resolve table scopes
	const global_scopes = await get_global_scopes(TABLE_NAME, "modules", module_code);
	const scope_key = resolve_scope_key(global_scopes, scope as string, get_cookie(req, "scope_modules"));
	// The two reserved archive scope keys carry no SQL: they select an archive
	// state through archive_filter instead of a WHERE clause.
	const archive_filter = resolve_archive_filter(scope_key);
	const scope_clause = scope_key && !is_archive_scope_key(scope_key) ? await get_scope_clause(
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

	const result = await search_records(query, offset, limit_numeric, order_by, scope_clause, filter_clauses, archive_filter);
	const archive_counts = await get_archive_counts(scope_clause);

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
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
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
			archive_counts,
			archive_filter,
			enable_archive,
		},
		ctx,
	});
}

export async function post_modules_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const body = await req.text();
	const _lang = get_locale_from_request(req) || default_locale;
	const params = new URLSearchParams(body);

	const data = {
		code: params.get(`code`)?.trim() || "",
		name: params.get(`name`)?.trim() || "",
		description: params.get(`description`)?.trim() || "",
	};

	const [errors, valid_data] = validate(data, ctx.translations.errors);

	if (Object.keys(errors).length > 0 || !valid_data) {
		return render("form", {
			data: { record: data, errors, action: base_path(), enable_archive },
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
				enable_archive,
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
			enable_archive,
		},
		ctx,
	});
}

export async function get_modules_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = Number(req.params.id || 0);
	// include_archived: an archived record must stay reachable from the archived
	// list, otherwise the restore action on this page could never be triggered.
	const record = await get_record_by_id(id, true);

	if (!record) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	if (wants_json(req)) {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		return Response.json(strip_api_sensitive(record as unknown as Record<string, unknown>));
	}

	const bp = base_path();
	return render("form", {
		data: {
			title: `Edit ${record.code}`,
			record,
			back_route: `${bp}?there_should_be_back_params`,
			errors: { code: "", name: "", description: "" },
			action: entity_path(record.id),
			enable_archive,
		},
		ctx,
	});
}

export async function post_modules_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = Number(req.params.id || 0);
	const body = await req.text();
	const _lang = get_locale_from_request(req) || default_locale;
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
	if (action === "restore") {
		if (!enable_archive) {
			return Response.json({ error: "Restore is disabled." }, { status: 403 });
		}
		try {
			const restored = await restore_record(id);
			if (restored) {
				await cache.invalidate(TABLE_NAME);
				sql_log({ s: "Restore", t: `${feature}`, id }, ctx.user?.username);
				return Response.redirect(redirect_url, 303);
			}
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		} catch (error) {
			console.error("Error restoring record:", error);
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		}
	}

	if (action === "archive") {
		if (!enable_archive) {
			return Response.json({ error: "Archive is disabled." }, { status: 403 });
		}
		try {
			const archived = await archive_record(id, ctx.user?.id ?? null);

			if (archived) {
				await cache.invalidate(TABLE_NAME);
				sql_log({ s: "Archive", t: `${feature}`, id }, ctx.user?.username);
				return Response.redirect(redirect_url, 303);
			}

			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		} catch (error) {
			const existing_record = await get_record_by_id(id);
			if (!existing_record) {
				return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
			}

			const error_message = error instanceof Error && error.message.includes("foreign key") ? "Cannot archive this record because it's referenced by other records." : "Error archiving record.";

			return render("form", {
				data: {
					title: `Edit ${existing_record.name}`,
					record: existing_record,
					form_errors: error_message,
					errors: {},
					action: entity_path(id),
					enable_archive,
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

	if (Object.keys(errors).length > 0 || !valid_data) {
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
				enable_archive,
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
				enable_archive,
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

export async function post_modules_bulk_archive(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	return run_bulk_remove(req, ctx, {
		feature,
		table_name: TABLE_NAME,
		mode: "archive",
		remove_one: (id) => archive_record(Number(id), ctx.user?.id ?? null),
	});
}
