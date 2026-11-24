import { navigation } from "./config";
import type { RouteDefinition } from "$lib/route_builder";
import { feature_paths } from "$lib/crud_routes";
import { default_locale } from "$config/supported_locales";
import { cache } from "$lib/cache";
import { get_locale_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { sql_log } from "$lib/logger";
import { build_pagination_urls, get_limit_numeric, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, get_filter_definitions, resolve_filters } from "$lib/table_filters";
import { delete_from_local, delete_from_s3 } from "$lib/s3";
import type { BunRequest } from "bun";

import { post_files_save } from "./upload_server";
import { post_files_bulk_archive, post_files_validate } from "./handlers";
import { columns, enable_archive, fields } from "./config";
import { resolve_archive_filter } from "$lib/archive";
import { archive_record, get_archive_counts, get_record_by_id, restore_record, search_records, update_record } from "./sql";
import { strip_api_sensitive } from "$config/api_blocklist";
import { wants_json } from "$lib/wants_json";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TABLE_NAME = "files";
const feature = get_table_name_from_dir(import.meta.dir);

const { base_path, entity_path } = feature_paths("", feature);

const SORT_OPTIONS = [
	{ value: "id::asc", field: "id", direction: "asc" },
	{ value: "id::desc", field: "id", direction: "desc" },
	{ value: "title::asc", field: "title", direction: "asc" },
	{ value: "title::desc", field: "title", direction: "desc" },
	{ value: "folder::asc", field: "folder", direction: "asc" },
	{ value: "folder::desc", field: "folder", direction: "desc" },
];

// ---------------------------------------------------------------------------
// Route map
// ---------------------------------------------------------------------------

export const system_files_crud = {
	"/files": { GET: get_files_index },
	"/files/new": get_files_new,
	"/files/validate": { POST: post_files_validate },
	"/files/save": { POST: post_files_save },
	"/files/:id/edit": { GET: get_files_edit, POST: post_files_edit },
	"/files/bulk-archive": { POST: post_files_bulk_archive },
};

// ---------------------------------------------------------------------------
// GET /files - List page (CRUD table)
// ---------------------------------------------------------------------------

export async function get_files_index(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);

	const { query, offset, limit, order_by, scope, filters, filter_not } = parse_pagination_params(req.url, 20, ["scope"]);
	const limit_numeric = get_limit_numeric(limit);

	const raw_filter_definitions = get_filter_definitions(columns, fields);
	const filter_clauses = resolve_filters(raw_filter_definitions, filters, filter_not);

	// files has no global_scopes wiring, so the scope param maps straight to an
	// archive state and never to a WHERE clause.
	const archive_filter = resolve_archive_filter(scope as string);
	const result = await search_records(query, offset, limit_numeric, order_by, "", filter_clauses, archive_filter);
	const archive_counts = await get_archive_counts();

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
	const { labels } = ctx.translations;
	const filter_definitions = enrich_filter_definitions(
		raw_filter_definitions,
		labels,
		filters,
		filter_not,
		{}
	);

	const limit_options = get_limit_options(limit === "all" ? "all" : (limit as number));

	const { prev_url, next_url, first_url, last_url } = build_pagination_urls(
		base_path(),
		offset,
		limit_numeric,
		result.total,
		query,
		order_by,
		scope as string,
		filters
	);

	// Line 1 of the two-line row shows compact/fixed-width fields; title, description, tags,
	// and mime_type move to a wrapped second line since they can run long (see index.ree).
	const GRID_LINE_1_KEYS = ["checkbox", "file_type", "original_filename", "folder", "file_size", "uploaded_by_user_id"];
	const column_entries = Object.entries(columns).filter(([key]) => GRID_LINE_1_KEYS.includes(key));
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_archive));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} auto`;

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
			columns,
			grid_cols,
			filter_definitions,
			filter_clauses,
			filter_params: filters,
			filter_not_params: filter_not,
			active_filter_count: filter_clauses.length,
			enable_archive,
			archive_counts,
			archive_filter,
			v_labels: ctx.translations.v_labels || {},
			files_basepath: Bun.env.S3_FILE_BUCKET || "files",
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// GET /files/new - New file form
// ---------------------------------------------------------------------------

export async function get_files_new(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const locale = get_locale_from_request(req) || default_locale;

	const url = new URL(req.url);
	const folder = url.searchParams.get("folder") || "";

	const localized_base = localized_url(base_path(), locale);

	const record = { id: 0, folder, title: "", description: "", tags: "", s3_key: "", created_at: "" };

	return render("form", {
		data: {
			page_title: ctx.translations.ui?.new_title,
			title: ctx.translations.ui?.new_file || "New File",
			record,
			save_url: "/files/save",
			return_url: localized_base,
			edit_mode: false,
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// GET /files/:id/edit - Edit file form
// ---------------------------------------------------------------------------

export async function get_files_edit(req: BunRequest): Promise<Response> {
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

	return render("form", {
		data: {
			page_title: ctx.translations.ui?.edit_title,
			title: `Edit ${record.original_filename || record.filename || "file"}`,
			record,
			action: entity_path(record.id),
			edit_mode: true,
			files_basepath: Bun.env.S3_FILE_BUCKET || "files",
		},
		ctx,
	});
}

// ---------------------------------------------------------------------------
// POST /files/:id/edit - Edit form handler (archive action only)
// ---------------------------------------------------------------------------

export async function post_files_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = Number(req.params.id || 0);
	const body = await req.text();
	const _lang = get_locale_from_request(req) || default_locale;
	const params = new URLSearchParams(body);
	const action = params.get("_action");
	const save_action = params.get("_save_action");

	const bp = base_path();
	const redirect_url = save_action === "stay" ? localized_url(entity_path(id), _lang) : localized_url(bp, _lang);

	if (action === "update") {
		const existing_record = await get_record_by_id(id);

		if (!existing_record) {
			return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx });
		}

		const title = params.get("title") || "";
		const description = params.get("description") || "";
		const tags = params.get("tags") || "";

		try {
			await update_record(id, {
				...existing_record,
				title,
				description,
				tags,
			});

			sql_log({ s: "Update", t: `${feature}`, id }, ctx.user?.username);
			await cache.invalidate(TABLE_NAME);
			return Response.redirect(redirect_url, 303);
		} catch (error) {
			const error_message = error instanceof Error ? error.message : "Error updating file.";

			return render("form", {
				data: {
					page_title: ctx.translations.ui?.edit_title,
					title: `Edit ${existing_record.original_filename || existing_record.filename || "file"}`,
					record: { ...existing_record, title, description, tags },
					action: entity_path(id),
					edit_mode: true,
					form_errors: error_message,
					files_basepath: Bun.env.S3_FILE_BUCKET || "files",
				},
				ctx,
			});
		}
	}

	if (action === "restore") {
		try {
			const restored = await restore_record(id);
			if (restored) {
				await cache.invalidate(TABLE_NAME);
				sql_log({ s: "Restore", t: `${feature}`, id }, ctx.user?.username);
				return Response.redirect(redirect_url, 303);
			}
			return Response.redirect(localized_url(bp, _lang), 303);
		} catch (error) {
			console.error("Error restoring record:", error);
			return Response.redirect(localized_url(bp, _lang), 303);
		}
	}

	if (action === "archive") {
		try {
			const record = await get_record_by_id(id);

			if (!record) {
				return Response.redirect(localized_url(bp, _lang), 303);
			}

			// The stored object stays where it is. Archiving is reversible, so
			// destroying the blob here would make a later restore hand back a broken
			// record. Reclaiming storage belongs to a purge step that removes
			// archived rows for real.
			const archived = await archive_record(id, ctx.user?.id ?? null);

			if (archived) {
				sql_log({ s: "Archive", t: `${feature}`, id }, ctx.user?.username);
				await cache.invalidate(TABLE_NAME);
				return Response.redirect(redirect_url, 303);
			}

			return Response.redirect(localized_url(bp, _lang), 303);
		} catch (error) {
			const existing_record = await get_record_by_id(id);

			if (!existing_record) {
				return Response.redirect(localized_url(bp, _lang), 303);
			}

			const error_message = error instanceof Error && error.message.includes("foreign key") ? "Cannot archive this file because it's referenced by other records." : "Error archiving file.";

			return render("form", {
				data: {
					page_title: ctx.translations.ui?.edit_title,
					title: `Edit ${existing_record.original_filename || existing_record.filename || "file"}`,
					record: existing_record,
					action: entity_path(id),
					edit_mode: true,
					form_errors: error_message,
					files_basepath: Bun.env.S3_FILE_BUCKET || "files",
				},
				ctx,
			});
		}
	}

	return Response.redirect(entity_path(id), 303);
}

export const route_definitions: RouteDefinition[] = [
	{
		url: "/files",
		crud: system_files_crud,
		nav_title_key: "reeman.files",
		module: "system",
		nav_module: null,
		nav_section_key: navigation.section_key,
		nav_section_order: navigation.section_order,
		nav_item_order: navigation.item_order,
		nav_group_order: navigation.group_order,
		nav_final_order: navigation.final_order,
	},
];
