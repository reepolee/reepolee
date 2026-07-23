import type { RouteDefinition } from "$lib/route_builder";
import { feature_paths } from "$lib/crud_routes";
import { default_language } from "$config/supported_languages";
import { cache } from "$lib/cache";
import { get_lang_from_request, localized_url } from "$lib/route";
import { get_table_name_from_dir } from "$lib/helpers";
import { sql_log } from "$lib/logger";
import { build_pagination_urls, get_limit_numeric, get_limit_options, parse_pagination_params } from "$lib/pagination";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { enrich_filter_definitions, get_filter_definitions, resolve_filters } from "$lib/table_filters";
import { delete_from_local, delete_from_s3 } from "$lib/s3";
import type { BunRequest } from "bun";

import { post_files_save } from "./upload_server";
import { post_files_bulk_delete, post_files_validate } from "./handlers";
import { columns, enable_delete, fields } from "./schema/table";
import { delete_record, get_record_by_id, search_records, update_record } from "./sql";
import { strip_api_sensitive } from "$config/api_blocklist";
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TABLE_NAME = "files";
const feature = get_table_name_from_dir(import.meta.dir);
const route_prefix = "/system";

const { base_path, entity_path } = feature_paths(route_prefix, feature);

const SORT_OPTIONS = [
	{ value: "id::asc", label: "ID (Ascending)" },
	{ value: "id::desc", label: "ID (Descending)" },
	{ value: "title::asc", label: "Title (Ascending)" },
	{ value: "title::desc", label: "Title (Descending)" },
	{ value: "folder::asc", label: "Folder (Ascending)" },
	{ value: "folder::desc", label: "Folder (Descending)" },
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
	"/files/bulk-delete": { POST: post_files_bulk_delete },
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

	const result = await search_records(query, offset, limit_numeric, order_by, "", filter_clauses);

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
		scope,
		filters
	);

	// Line 1 of the two-line row shows compact/fixed-width fields; title, description, tags,
	// and mime_type move to a wrapped second line since they can run long (see index.ree).
	const GRID_LINE_1_KEYS = ["checkbox", "file_type", "original_filename", "folder", "file_size"];
	const column_entries = Object.entries(columns).filter(([key]) => GRID_LINE_1_KEYS.includes(key));
	const visible_column_entries = column_entries.filter(([key, value]: [string, any]) => value.grid !== false && (key !== "checkbox" || enable_delete));
	const grid_widths = visible_column_entries.map(([_, value]: [string, any]) => (typeof value === "string" ? value : value.width));
	const grid_cols = `${grid_widths.join(" ")} auto`;

	return render("index", {
		data: {
			title: "Files",
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
			enable_delete,
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
	const lang = get_lang_from_request(req) || default_language;

	const url = new URL(req.url);
	const folder = url.searchParams.get("folder") || "";

	const localized_base = localized_url(base_path(), lang);

	const record = { id: 0, folder, title: "", description: "", tags: "", s3_key: "", created_at: "" };

	return render("form", {
		data: {
			title: ctx.translations.ui?.new_file || "New File",
			record,
			save_url: "/system/files/save",
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
	const record = await get_record_by_id(id);

	if (!record) { return render("notfound", { data: { title: "404 Not Found" }, status: 404, ctx }); }

	if (req.headers.get("Accept") === "application/json") {
		if (!Bun.argv.includes("--dev")) return Response.json({ error: "not found" }, { status: 404 });
		return Response.json(strip_api_sensitive(record as Record<string, unknown>));
	}

	return render("form", {
		data: {
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
// POST /files/:id/edit - Edit form handler (delete action only)
// ---------------------------------------------------------------------------

export async function post_files_edit(req: BunRequest): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const id = Number(req.params.id || 0);
	const body = await req.text();
	const _lang = get_lang_from_request(req) || default_language;
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

	if (action === "delete") {
		try {
			const record = await get_record_by_id(id);

			if (!record) {
				return Response.redirect(localized_url(bp, _lang), 303);
			}

			if (record?.s3_key) {
				try {
					const bucket = Bun.env.S3_FILE_BUCKET || "files";
					await delete_from_s3(bucket, record.s3_key);
					await delete_from_local(bucket, record.s3_key);
				} catch (err) {
					console.error("Failed to delete file:", err);
				}
			}

			const deleted = await delete_record(id);

			if (deleted) {
				sql_log({ s: "Delete", t: `${feature}`, id }, ctx.user?.username);
				await cache.invalidate(TABLE_NAME);
				return Response.redirect(redirect_url, 303);
			}

			return Response.redirect(localized_url(bp, _lang), 303);
		} catch (error) {
			const existing_record = await get_record_by_id(id);

			if (!existing_record) {
				return Response.redirect(localized_url(bp, _lang), 303);
			}

			const error_message = error instanceof Error && error.message.includes("foreign key") ? "Cannot delete this file because it's referenced by other records." : "Error deleting file.";

			return render("form", {
				data: {
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
		url: "/system/files",
		crud: system_files_crud,
		nav_title_key: "system.files",
		module: "system",
	},
];
