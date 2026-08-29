import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { make_toast } from "$lib/cookies";
import { localized_url, resolve_locale } from "$lib/route";
import { normalize_locale } from "$lib/locale";
import type { RouteDefinition } from "$lib/route_builder";
import type { BunRequest } from "bun";

import { build_pagination_urls, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { enrich_filter_definitions, get_filter_definitions, resolve_filters } from "$lib/table_filters";
import { wants_json } from "$lib/wants_json";
import { strip_api_sensitive } from "$config/api_blocklist";

import { is_busy } from "../reeman/actions";
import { get_inactive_supported_locales, get_record_by_id, search_records, update_record } from "./sql";
import { columns, enable_archive, grid_filler } from "./schema/table";
import { fields } from "./schema/table.generated";

const DEFAULT_LIMIT = 20;
const SORT_OPTIONS = [
	{ value: "code::asc", field: "code", direction: "asc" },
	{ value: "code::desc", field: "code", direction: "desc" },
	{ value: "name::asc", field: "name", direction: "asc" },
	{ value: "name::desc", field: "name", direction: "desc" },
	{ value: "alias::asc", field: "alias", direction: "asc" },
	{ value: "alias::desc", field: "alias", direction: "desc" },
	{ value: "active::asc", field: "active", direction: "asc" },
	{ value: "active::desc", field: "active", direction: "desc" },
	{ value: "default::asc", field: "default", direction: "asc" },
	{ value: "default::desc", field: "default", direction: "desc" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toast_redirect(req: BunRequest, message: string, type: "green" | "red" | "yellow" = "green", target = "/locales"): Response {
	const locale = resolve_locale(req);
	const base = localized_url(target, locale);
	const headers = new Headers({ Location: base });
	headers.append("Set-Cookie", make_toast("toast-reeman", { message, type, duration: 6000 }).toString());
	return new Response(null, { status: 303, headers });
}

async function params_of(req: BunRequest): Promise<URLSearchParams> {
	return new URLSearchParams(await req.text());
}

// ---------------------------------------------------------------------------
// GET /locales/export-bundle - Download current English translation sources
// ---------------------------------------------------------------------------

export async function get_locales_export_bundle(): Promise<Response> {
	const { create_translation_bundle } = await import("$generator/translation_bundle");
	const bundle = await create_translation_bundle();
	const body = `${JSON.stringify(bundle, null, "\t")}\n`;
	return new Response(body, {
		headers: {
			"Cache-Control": "no-store",
			"Content-Disposition": 'attachment; filename="reepolee-en-us-translations.json"',
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

// ---------------------------------------------------------------------------
// GET /locales - Locale grid (mirrors db_tables index)
// ---------------------------------------------------------------------------

export async function get_locales_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const { query, offset, limit, order_by, filters, filter_not } = parse_pagination_params(req.url, DEFAULT_LIMIT);
	const limit_numeric = limit === "all" ? 999999 : limit;

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	const result = await search_records(query, offset, limit_numeric, order_by, "", filter_clauses);

	if (wants_json(req)) {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		return Response.json({
			data: (result.records as unknown as Record<string, unknown>[]).map(strip_api_sensitive),
			total: result.total,
			limit: limit_numeric,
			offset: offset as number,
		});
	}

	const { labels } = ctx.translations;
	const filter_definitions = enrich_filter_definitions(raw_filter_definitions, labels, filters, filter_not, {});

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));
	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(
		"/locales",
		offset,
		limit_numeric,
		result.total,
		query,
		order_by,
		"",
		filters,
		filter_not,
	);

	const column_entries = Object.entries(columns);
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
	const grid_widths = visible_column_entries.map(([, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} ${grid_filler}`;

	const inactive_supported_locales = await get_inactive_supported_locales();
	const { list_available_seed_locales } = await import("$generator/activate_locale");
	const available_seed_locales = await list_available_seed_locales();
	const { list_installable_archived_locales } = await import("$generator/install_locale");
	const archived_locales = await list_installable_archived_locales();

	return render("index", {
		data: {
			title: "Locales",
			records: result.records,
			inactive_supported_locales,
			available_seed_locales,
			archived_locales,
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
			busy: await is_busy(),
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// GET /locales/:code - Locale detail (edit form)
// ---------------------------------------------------------------------------

export async function get_locale_detail(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const code = (req.params.code ?? "").toLowerCase();
	const record = await get_record_by_id(code);

	if (!record) {
		return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
	}

	return render("detail", {
		data: {
			title: record.code,
			record,
			busy: await is_busy(),
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// POST /locales/:code - Save locale detail (name / alias / active / default)
// ---------------------------------------------------------------------------

export async function post_locale_update(req: BunRequest): Promise<Response> {
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	const code = (req.params.code ?? "").toLowerCase();
	const params = await params_of(req);

	const patch: Parameters<typeof update_record>[1] = {
		name: params.get("name") || "",
		alias: params.get("alias") || "",
		active: params.get("active") === "1" ? 1 : 0,
		is_default: params.get("is_default") === "1" ? 1 : 0,
	};

	if (patch.alias) {
		try {
			normalize_locale(patch.alias);
		} catch {
			return toast_redirect(req, `Reeman: "${patch.alias}" is not a valid alias locale code.`, "red");
		}
	}

	// Ticking "Active" on a locale that had no translations yet needs its
	// init SQL run before the config flips - otherwise the locale shows
	// active without translation files (run before update_record so a
	// failed SQL run never leaves the locale marked active).
	if (patch.active === 1) {
		const existing = await get_record_by_id(code);
		if (existing && existing.active !== 1) {
			const { run_locale_init_sql } = await import("$generator/activate_locale");
			const ran = await run_locale_init_sql(code);
			if (!ran) return toast_redirect(req, `Reeman: failed to run init translations for "${code}".`, "red", `/locales/${code}`);
		}
	}

	try {
		await update_record(code, patch);
	} catch (err) {
		return toast_redirect(req, `Reeman: failed to save locale — ${err instanceof Error ? err.message : String(err)}`, "red");
	}

	return toast_redirect(req, `Reeman: ${code} saved. Reload routes to apply.`, "green", `/locales/${code}`);
}

// ---------------------------------------------------------------------------
// POST /locales/add - Add a locale via the shared generator
// ---------------------------------------------------------------------------

export async function post_locales_add(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const locale_code = params.get("locale_code")?.trim() || "";
	if (!locale_code) return toast_redirect(req, "Reeman: no locale code provided.", "red");
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	const { action_add_locale } = await import("../reeman/actions");
	const result = await action_add_locale({ locale_code, translate: params.get("translate") === "1" });
	return toast_redirect(req, result.ok ? `Reeman: added ${locale_code}.` : `Reeman: failed to add ${locale_code}${result.error ? ` — ${result.error}` : ""}.`, result.ok ? "green" : "red");
}

// ---------------------------------------------------------------------------
// POST /locales/add-seeded - Bulk add one or more locales that have a curated
// seed file on disk (no AI). Lands in `locales` only, not `active_locales`.
// ---------------------------------------------------------------------------

export async function post_locales_add_seeded(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const codes = params.getAll("codes").map((c) => c.trim()).filter(Boolean);
	if (codes.length === 0) return toast_redirect(req, "Reeman: no locales selected.", "red");
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	const { action_add_seeded_locale } = await import("../reeman/actions");
	let ok = 0;
	let fail = 0;
	for (const code of codes) {
		const result = await action_add_seeded_locale({ locale_code: code });
		if (result.ok) ok++; else fail++;
	}
	const message = fail === 0
		? `Reeman: added ${ok} locale(s).`
		: `Reeman: added ${ok}, failed ${fail}.`;
	return toast_redirect(req, message, fail === 0 ? "green" : "red");
}

// ---------------------------------------------------------------------------
// POST /locales/install-archived - Restore one curated locale from the archive
// to its mirrored live paths and register it as supported but inactive.
// ---------------------------------------------------------------------------

export async function post_locales_install_archived(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const locale_code = params.get("locale_code")?.trim() || "";
	if (!locale_code) return toast_redirect(req, "Reeman: no archived locale selected.", "red");
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	const { action_install_archived_locale } = await import("../reeman/actions");
	const result = await action_install_archived_locale({ locale_code });
	const error_detail = result.error || result.output;
	return toast_redirect(
		req,
		result.ok ? `Reeman: imported ${locale_code} from the locale archive.` : `Reeman: failed to import ${locale_code}${error_detail ? ` - ${error_detail}` : ""}.`,
		result.ok ? "green" : "red",
	);
}

// ---------------------------------------------------------------------------
// POST /locales/upload-bundle - Validate and archive an externally translated
// bundle. Installation remains an explicit second step in the archive list.
// ---------------------------------------------------------------------------

export async function post_locales_upload_bundle(req: BunRequest): Promise<Response> {
	try {
		const form_data = await req.formData();
		const uploaded = form_data.get("translation_bundle");
		if (!(uploaded instanceof File) || uploaded.size === 0) return toast_redirect(req, "Reeman: select a translated JSON bundle.", "red");
		if (uploaded.size > 20 * 1024 * 1024) return toast_redirect(req, "Reeman: translation bundle exceeds the 20 MB limit.", "red");

		const input = JSON.parse(await uploaded.text());
		const { archive_translation_bundle_data } = await import("$generator/translation_bundle");
		const bundle = await archive_translation_bundle_data(input);
		return toast_redirect(req, `Reeman: uploaded and validated ${bundle.target_locale}.`, "green");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toast_redirect(req, `Reeman: translation bundle rejected - ${message}`, "red");
	}
}

// ---------------------------------------------------------------------------
// POST /locales/activate - Turn on one or more already-supported locales
// (translations already generated - just run their init SQL + flip the flag)
// ---------------------------------------------------------------------------

export async function post_locales_activate(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const locale_codes = params.getAll("locale_codes").map((c) => c.trim()).filter(Boolean);
	if (locale_codes.length === 0) return toast_redirect(req, "Reeman: no locales selected.", "red");
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	const { action_activate_locales } = await import("../reeman/actions");
	const result = await action_activate_locales({ locale_codes });
	return toast_redirect(req, result.ok ? `Reeman: activated ${locale_codes.join(", ")}.` : `Reeman: failed to activate locale(s)${result.error ? ` — ${result.error}` : ""}.`, result.ok ? "green" : "red");
}

// ---------------------------------------------------------------------------
// POST /locales/remove - Remove a locale via the shared generator
// ---------------------------------------------------------------------------

export async function post_locales_remove(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const locale_code = params.get("locale_code")?.trim() || "";
	if (!locale_code) return toast_redirect(req, "Reeman: no locale code provided.", "red");
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	const { action_remove_locale } = await import("../reeman/actions");
	const result = await action_remove_locale({ locale_code });
	return toast_redirect(req, result.ok ? `Reeman: removed ${locale_code}.` : `Reeman: failed to remove ${locale_code}${result.error ? ` — ${result.error}` : ""}.`, result.ok ? "green" : "red");
}

// ---------------------------------------------------------------------------
// POST /locales/bulk-remove - Remove several locales at once
// ---------------------------------------------------------------------------

export async function post_locales_bulk_remove(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const codes = params.getAll("codes").map((c) => c.trim()).filter(Boolean);
	if (codes.length === 0) return toast_redirect(req, "Reeman: no locales selected.", "red");
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	const { action_remove_locale } = await import("../reeman/actions");
	let ok = 0;
	let fail = 0;
	for (const code of codes) {
		const result = await action_remove_locale({ locale_code: code });
		if (result.ok) ok++; else fail++;
	}
	const message = fail === 0
		? `Reeman: removed ${ok} locale(s).`
		: `Reeman: removed ${ok}, failed ${fail}.`;
	return toast_redirect(req, message, fail === 0 ? "green" : "red");
}

// ---------------------------------------------------------------------------
// POST /locales/bulk-set-active - Activate or deactivate several locales at once
// ---------------------------------------------------------------------------

export async function post_locales_bulk_set_active(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const codes = params.getAll("codes").map((c) => c.trim()).filter(Boolean);
	const active = params.get("active") === "1" ? 1 : 0;
	if (codes.length === 0) return toast_redirect(req, "Reeman: no locales selected.", "red");
	if (await is_busy()) return toast_redirect(req, "Reeman: another action is already running. Wait for it to finish.", "yellow");

	let ok = 0;
	let fail = 0;
	for (const code of codes) {
		try {
			// Same guard as post_locale_update: a locale with no translations yet
			// needs its init SQL run before the config flips it active, so it never
			// shows active without translation files.
			if (active === 1) {
				const existing = await get_record_by_id(code);
				if (existing && existing.active !== 1) {
					const { run_locale_init_sql } = await import("$generator/activate_locale");
					const ran = await run_locale_init_sql(code);
					if (!ran) { fail++; continue; }
				}
			}
			await update_record(code, { active });
			ok++;
		} catch {
			fail++;
		}
	}
	const verb = active === 1 ? "activated" : "deactivated";
	const message = fail === 0
		? `Reeman: ${verb} ${ok} locale(s).`
		: `Reeman: ${verb} ${ok}, failed ${fail}.`;
	return toast_redirect(req, message, fail === 0 ? "green" : "red");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const locales_crud = {
	"/locales": { GET: get_locales_index },
	"/locales/export-bundle": { GET: get_locales_export_bundle },
	"/locales/add": { POST: post_locales_add },
	"/locales/add-seeded": { POST: post_locales_add_seeded },
	"/locales/upload-bundle": { POST: post_locales_upload_bundle },
	"/locales/install-archived": { POST: post_locales_install_archived },
	"/locales/activate": { POST: post_locales_activate },
	"/locales/remove": { POST: post_locales_remove },
	"/locales/bulk-remove": { POST: post_locales_bulk_remove },
	"/locales/bulk-set-active": { POST: post_locales_bulk_set_active },
	"/locales/:code": { GET: get_locale_detail, POST: post_locale_update },
};

export const route_definitions: RouteDefinition[] = [
	{
		url: "/locales",
		crud: locales_crud,
		nav_title_key: "reeman.locales",
		module: "system",
		nav_module: null,
	},
];
