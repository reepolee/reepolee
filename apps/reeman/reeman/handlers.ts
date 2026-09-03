/**
 * POST handlers for the reeman web actions.
 *
 * Synchronous actions record their captured output to the .reepolee state file,
 * then 303-redirect back to the reeman page the form came from (validated
 * against the reeman page whitelist) with a toast - the same pattern studio
 * uses. CRUD-family actions are spawned; their pending run records are updated
 * with the child output and final status when generation completes.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { make_toast } from "$lib/cookies";
import { notify_server_reload } from "$lib/server_notify";
import { require_max_upload_size_mb } from "$lib/env";
import { localized_url, resolve_locale } from "$lib/route";
import type { BunRequest } from "bun";
import type { GridColumnDefinition } from "$generator/schema/types";

import {
	action_add_locale,
	action_backup_database,
	action_bulk,
	action_bulk_refresh,
	action_bulk_refresh_routes,
	action_bulk_remove_route,
	action_bulk_schema,
	action_check_compliance,
	action_json_to_sql,
	action_spreadsheet_to_sql,
	action_refresh,
	action_save_route_settings,
	action_reload_routes,
	action_run_sql,
	action_schema,
	action_simple_page,
	action_simple_route,
	action_sync_locale_tables,
	action_sync_translations,
	is_busy,
	spawn_bulk_action,
	spawn_crud_action,
	spawn_nested_children_action,
	type ActionResult,
} from "./actions";
import { clear_runs, record_run } from "./lib/state";
import { safe_return_to } from "./return_to";

async function params_of(req: BunRequest): Promise<URLSearchParams> {
	return new URLSearchParams(await req.text());
}

function get_param(params: URLSearchParams, key: string): string {
	return params.get(key)?.trim() ?? "";
}

function is_checked(params: URLSearchParams, key: string): boolean {
	return params.get(key) === "1" || params.get(key) === "on" || params.get(key) === "true";
}

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

async function redirect_result(req: BunRequest, action: string, target: string, result: ActionResult, return_to: string = "", should_record: boolean = true): Promise<Response> {
	if (should_record) await record_run({ action, target, ok: result.ok, output: result.output, error: result.error, meta: result.meta });

	const locale = resolve_locale(req);
	const base = localized_url(safe_return_to(return_to), locale);
	const headers = new Headers({ Location: base });
	const message = result.ok
		? `Reeman: ${action} succeeded${target ? ` (${target})` : ""}`
		: `Reeman: ${action} failed${target ? ` (${target})` : ""}${result.error ? ` — ${result.error}` : ""}`;
	headers.append("Set-Cookie", make_toast("toast-reeman", { message, type: result.ok ? "green" : "red", duration: 6000 }).toString());
	return new Response(null, { status: 303, headers });
}

async function busy_response(req: BunRequest, return_to: string = "", key?: string): Promise<Response> {
	const busy = await is_busy(key);
	const locale = resolve_locale(req);
	const base = localized_url(safe_return_to(return_to), locale);
	const headers = new Headers({ Location: base });
	const message = busy
		? `Reeman: another action is already running (${busy.action}${busy.target ? ` ${busy.target}` : ""}). Wait for it to finish.`
		: "Reeman: another action is already running. Wait for it to finish.";
	headers.append("Set-Cookie", make_toast("toast-reeman", { message, type: "yellow", duration: 6000 }).toString());
	return new Response(null, { status: 303, headers });
}

// ---------------------------------------------------------------------------
// CRUD generators
// ---------------------------------------------------------------------------

type GridFormSettings = {
	grid_columns?: string[];
	grid_column_definitions?: GridColumnDefinition[];
	error?: string;
};

function parse_grid_form_settings(params: URLSearchParams): GridFormSettings {
	const raw_grid_column_names = params.getAll("grid_column_name");
	if (raw_grid_column_names.length === 0) return {};

	const raw_grid_columns = params.getAll("grid_columns");
	const trimmed_grid_columns = raw_grid_columns.map((column) => column.trim());
	const grid_columns = trimmed_grid_columns.filter(Boolean);
	const grid_column_names = raw_grid_column_names.map((name) => name.trim());
	const raw_grid_column_widths = params.getAll("grid_column_width");
	const grid_column_widths = raw_grid_column_widths.map((width) => width.trim());
	const raw_grid_column_classes = params.getAll("grid_column_class");
	const grid_column_classes = raw_grid_column_classes.map((class_name) => class_name.trim());
	const raw_grid_column_helpers = params.getAll("grid_column_helper");
	const grid_column_helpers = raw_grid_column_helpers.map((helper) => helper.trim());
	const raw_filter_columns = params.getAll("grid_filter_columns");
	const filter_columns = new Set(raw_filter_columns);
	const has_localized_control = params.get("grid_localized_control") === "1";
	const raw_localized_columns = params.getAll("grid_localized_columns");
	const localized_columns = new Set(raw_localized_columns);
	const raw_readonly_columns = params.getAll("grid_readonly_columns");
	const readonly_columns = new Set(raw_readonly_columns);
	const definition_names = new Set(grid_column_names);
	const has_invalid_definition_lengths = grid_column_names.length !== grid_column_widths.length || grid_column_names.length !== grid_column_classes.length || grid_column_names.length !== grid_column_helpers.length;
	const has_blank_definition = grid_column_names.some((name, index) => !name || !grid_column_widths[index]);
	const has_duplicate_definition = definition_names.size !== grid_column_names.length;
	const has_unknown_selection = grid_columns.some((name) => !definition_names.has(name));
	const has_unknown_filter = raw_filter_columns.some((name) => !definition_names.has(name));
	const has_unknown_localized = raw_localized_columns.some((name) => !definition_names.has(name));
	const has_unknown_readonly = raw_readonly_columns.some((name) => !definition_names.has(name));
	if (has_invalid_definition_lengths || has_blank_definition || has_duplicate_definition || has_unknown_selection || has_unknown_filter || has_unknown_localized || has_unknown_readonly) {
		return { error: "Invalid grid column definitions." };
	}

	const grid_column_definitions: GridColumnDefinition[] = grid_column_names.map((name, index) => ({
		name,
		width: grid_column_widths[index]!,
		class_name: grid_column_classes[index]!,
		filter: filter_columns.has(name),
		helper: grid_column_helpers[index] || undefined,
		localized: has_localized_control ? localized_columns.has(name) : undefined,
		readonly: readonly_columns.has(name),
	}));
	return { grid_columns, grid_column_definitions };
}

export async function post_crud(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const table = get_param(params, "table");
	if (!table) return redirect_result(req, "crud", "", { ok: false, output: "", error: "No table selected." }, return_to);
	if (await is_busy(table)) return busy_response(req, return_to, table);
	const grid_settings = parse_grid_form_settings(params);
	if (grid_settings.error) return redirect_result(req, "crud", table, { ok: false, output: "", error: grid_settings.error }, return_to);
	// Spawn as subprocess so generation survives bun --hot reloads. Keyed by
	// table, so generating another table concurrently is not blocked.
	const started = await spawn_crud_action(table, {
		force: is_checked(params, "force"),
		translate: is_checked(params, "translate"),
		prefix: get_param(params, "prefix"),
		route_name: get_param(params, "route_name"),
		pagination: get_param(params, "pagination"),
		render_strategy: get_param(params, "render_strategy"),
		template_tags: get_param(params, "template_tags"),
		form_hints: is_checked(params, "form_hints"),
		form_details: is_checked(params, "form_details"),
		grid_columns: grid_settings.grid_columns,
		grid_column_definitions: grid_settings.grid_column_definitions,
	});
	if (!started) return busy_response(req, return_to, table);
	return redirect_result(req, "crud", table, { ok: true, output: "Generation started in background." }, return_to, false);
}

export async function post_schema(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const table = get_param(params, "table");
	if (!table) return redirect_result(req, "schema", "", { ok: false, output: "", error: "No table selected." }, return_to);
	if (await is_busy(table)) return busy_response(req, return_to, table);
	const result = await action_schema({ table, prefix: get_param(params, "prefix") });
	return redirect_result(req, "schema", table, result, return_to);
}

// Same folder-name rule the CLI flows enforce (generator/reeman/flows).
const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

export async function post_simple_page(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const folder_name = get_param(params, "folder_name");
	if (!FOLDER_NAME_RE.test(folder_name)) return redirect_result(req, "simple-page", "", { ok: false, output: "", error: "Invalid folder name (use lowercase letters, digits, - or _)." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_simple_page({ prefix: get_param(params, "prefix"), folder_name });
	return redirect_result(req, "simple-page", folder_name, result, return_to);
}

export async function post_simple_route(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const folder_name = get_param(params, "folder_name");
	const table = get_param(params, "table");
	const fields = params.getAll("fields").map((f) => f.trim()).filter(Boolean);
	if (!FOLDER_NAME_RE.test(folder_name)) return redirect_result(req, "simple-table-page", "", { ok: false, output: "", error: "Invalid folder name (use lowercase letters, digits, - or _)." }, return_to);
	if (!table) return redirect_result(req, "simple-table-page", "", { ok: false, output: "", error: "No table selected." }, return_to);
	if (fields.length === 0) return redirect_result(req, "simple-table-page", "", { ok: false, output: "", error: "No fields selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);

	// Zip the parallel ORDER BY / WHERE row arrays the form posts. Rows with no
	// field (blank template rows) are dropped; WHERE also needs a value.
	const order_fields = params.getAll("order_field");
	const order_dirs = params.getAll("order_dir");
	const order_by = order_fields
		.map((field, i) => ({ field: field.trim(), direction: (order_dirs[i] ?? "asc").toUpperCase() === "DESC" ? ("DESC" as const) : ("ASC" as const) }))
		.filter((o) => o.field);

	const where_fields = params.getAll("where_field");
	const where_ops = params.getAll("where_op");
	const where_values = params.getAll("where_value");
	const where = where_fields
		.map((field, i) => ({ field: field.trim(), operator: (where_ops[i] ?? "=").trim() || "=", value: (where_values[i] ?? "").trim() }))
		.filter((w) => w.field && w.value);

	const result = await action_simple_route({ prefix: get_param(params, "prefix"), folder_name, table, fields, order_by, where });
	return redirect_result(req, "simple-table-page", folder_name, result, return_to);
}

export async function post_bulk(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const tables = params.getAll("tables").map((t) => t.trim()).filter(Boolean);
	if (tables.length === 0) return redirect_result(req, "bulk", "", { ok: false, output: "", error: "No tables selected." }, return_to);
	// Spawn one bulk subprocess so generation survives bun --hot reloads while
	// preserving the shared apps/main/routes.ts registry. Tables already busy
	// are skipped, not treated as a reason to reject the whole batch.
	const started = await spawn_bulk_action(tables, {
		force: is_checked(params, "force"),
		translate: is_checked(params, "translate"),
		prefix: get_param(params, "prefix"),
		pagination: get_param(params, "pagination"),
		render_strategy: get_param(params, "render_strategy"),
		template_tags: get_param(params, "template_tags"),
	});
	if (started.length === 0) return busy_response(req, return_to, tables[0]);
	const skipped = tables.filter((t) => !started.includes(t));
	const output = skipped.length > 0
		? `Generation started for: ${started.join(", ")}. Skipped (already busy): ${skipped.join(", ")}.`
		: "Generation started in background.";
	return redirect_result(req, "bulk", started.join(", "), { ok: true, output }, return_to, false);
}

export async function post_bulk_schema(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const tables = params.getAll("tables").map((t) => t.trim()).filter(Boolean);
	if (tables.length === 0) return redirect_result(req, "bulk-schema", "", { ok: false, output: "", error: "No tables selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_bulk_schema({ tables, prefix: get_param(params, "prefix") });
	return redirect_result(req, "bulk-schema", tables.join(", "), result, return_to);
}

export async function post_bulk_refresh(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const tables = params.getAll("tables").map((t) => t.trim()).filter(Boolean);
	if (tables.length === 0) return redirect_result(req, "bulk-refresh", "", { ok: false, output: "", error: "No tables selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_bulk_refresh({ tables });
	return redirect_result(req, "bulk-refresh", tables.join(", "), result, return_to);
}

export async function post_bulk_refresh_routes(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const urls = params.getAll("urls").map((u) => u.trim()).filter(Boolean);
	if (urls.length === 0) return redirect_result(req, "bulk-refresh-routes", "", { ok: false, output: "", error: "No routes selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_bulk_refresh_routes({ urls });
	return redirect_result(req, "bulk-refresh-routes", urls.join(", "), result, return_to);
}

export async function post_save_route_settings(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const url = get_param(params, "urls");
	if (!url) return redirect_result(req, "save-route-settings", "", { ok: false, output: "", error: "No route selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const grid_settings = parse_grid_form_settings(params);
	if (grid_settings.error) return redirect_result(req, "save-route-settings", url, { ok: false, output: "", error: grid_settings.error }, return_to);
	const result = await action_save_route_settings({
		url,
		template_tags: get_param(params, "template_tags"),
		pagination: get_param(params, "pagination"),
		render_strategy: get_param(params, "render_strategy"),
		form_hints: is_checked(params, "form_hints"),
		form_details: is_checked(params, "form_details"),
		grid_columns: grid_settings.grid_columns,
		grid_column_definitions: grid_settings.grid_column_definitions,
		refresh: is_checked(params, "refresh"),
	});
	return redirect_result(req, is_checked(params, "refresh") ? "refresh-crud" : "save-route-settings", url, result, return_to);
}

export async function post_add_nested_children(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const parent_table = get_param(params, "parent_table");
	const parent_url = get_param(params, "parent_url");
	const raw_child_selections = params.getAll("child_selection");
	const raw_selections = raw_child_selections.map((value) => value.trim());
	if (!parent_table || !parent_url) return redirect_result(req, "add-nested-children", "", { ok: false, output: "", error: "A parent route is required." }, return_to);
	if (raw_selections.length === 0) {
		return redirect_result(req, "add-nested-children", parent_table, { ok: false, output: "", error: "Select at least one valid child relationship." }, return_to);
	}
	if (await is_busy(parent_table)) return busy_response(req, return_to, parent_table);
	try {
		const children = raw_selections.map((selection) => {
			const separator = selection.indexOf(":");
			if (separator < 1 || separator === selection.length - 1) throw new Error("Invalid child relationship.");
			return { table: selection.slice(0, separator).trim(), fk_column: selection.slice(separator + 1).trim() };
		});
		const started = await spawn_nested_children_action({
			parent_table,
			parent_url,
			children,
			pagination: get_param(params, "pagination"),
			render_strategy: get_param(params, "render_strategy"),
			template_tags: get_param(params, "template_tags"),
			translate: is_checked(params, "translate"),
		});
		if (!started) return busy_response(req, return_to, parent_table);
		return redirect_result(req, "add-nested-children", parent_table, { ok: true, output: "Nested child generation started in background." }, return_to, false);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return redirect_result(req, "add-nested-children", parent_table, { ok: false, output: "", error: message }, return_to);
	}
}

export async function post_bulk_remove_route(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const urls = params.getAll("urls").map((u) => u.trim()).filter(Boolean);
	if (urls.length === 0) return redirect_result(req, "bulk-remove-route", "", { ok: false, output: "", error: "No routes selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_bulk_remove_route({ urls });
	const response = await redirect_result(req, "bulk-remove-route", urls.join(", "), result, return_to);
	// Let the 303 response leave this request before Bun rebuilds the main
	// app's route table. Rebuilding while the POST is still unwinding can
	// strand the browser on the deleted /routes/:id page.
	setTimeout(() => { void notify_server_reload(); }, 0);
	return response;
}

export async function post_refresh_crud(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const url = get_param(params, "url");
	if (!url) return redirect_result(req, "refresh-crud", "", { ok: false, output: "", error: "No route selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_refresh({ url });
	return redirect_result(req, "refresh-crud", url, result, return_to);
}

// ---------------------------------------------------------------------------
// Languages & translations
// ---------------------------------------------------------------------------

export async function post_sync_translations(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_sync_translations({ translate: is_checked(params, "translate") });
	return redirect_result(req, "sync-translations", "", result, return_to);
}

export async function post_sync_locale_tables(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_sync_locale_tables();
	return redirect_result(req, "sync-locale-tables", "", result, return_to);
}

export async function post_add_locale(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const locale_code = get_param(params, "locale_code");
	if (!locale_code) return redirect_result(req, "add-locale", "", { ok: false, output: "", error: "No locale code provided." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_add_locale({ locale_code, translate: is_checked(params, "translate") });
	return redirect_result(req, "add-locale", locale_code, result, return_to);
}

// ---------------------------------------------------------------------------
// Database & routes
// ---------------------------------------------------------------------------

export async function post_backup_database(req: BunRequest): Promise<Response> {
	const return_to = "/database";
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_backup_database();
	return redirect_result(req, "backup-database", "", result, return_to);
}

export async function post_run_sql(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	const path = get_param(params, "path");
	if (!path) return redirect_result(req, "run-sql-file", "", { ok: false, output: "", error: "No SQL file selected." }, return_to);
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_run_sql({ path });
	return redirect_result(req, "run-sql-file", path, result, return_to);
}

function import_json_response(data: Record<string, unknown>, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

export async function post_inspect_import(req: BunRequest): Promise<Response> {
	const form_data = await req.formData();
	const uploaded = form_data.get("json_file");
	if (!(uploaded instanceof File) || uploaded.size === 0) {
		return import_json_response({ error: "Select an import file first." }, 400);
	}
	const is_spreadsheet = /\.(?:xls|xlsx)$/i.test(uploaded.name);
	const is_json = uploaded.name.toLowerCase().endsWith(".json");
	if (!is_json && !is_spreadsheet) {
		return import_json_response({ error: "Only .json, .xls, and .xlsx files are accepted." }, 400);
	}
	const max_upload_size_mb = require_max_upload_size_mb();
	if (uploaded.size > max_upload_size_mb * 1024 * 1024) {
		return import_json_response({ error: `The import file must be ${max_upload_size_mb} MB or smaller.` }, 400);
	}

	const extension = is_spreadsheet ? (uploaded.name.toLowerCase().endsWith(".xlsx") ? ".xlsx" : ".xls") : ".json";
	const temp_path = join(tmpdir(), `reepolee-inspect-${randomUUID()}${extension}`);
	try {
		await Bun.write(temp_path, uploaded);
		const { extract_rows, read_spreadsheet_sheets, suggest_table_name } = await import("$generator/reeman/data_to_sql");
		if (is_spreadsheet) {
			const sheets = await read_spreadsheet_sheets(temp_path);
			const used_names = new Set<string>();
			const inspected_sheets = sheets.map((sheet, index) => {
				const base_name = suggest_table_name(sheet.name);
				let table_name = base_name;
				let suffix = 2;
				while (used_names.has(table_name)) {
					table_name = `${base_name}_${suffix}`;
					suffix++;
				}
				used_names.add(table_name);
				return { ...sheet, index, table_name };
			});
			return import_json_response({ kind: "spreadsheet", sheets: inspected_sheets });
		}
		const parsed = JSON.parse(await Bun.file(temp_path).text());
		const rows = extract_rows(parsed);
		const column_names = new Set<string>();
		for (const row of rows) {
			for (const column_name of Object.keys(row)) column_names.add(column_name);
		}
		return import_json_response({
			kind: "json",
			row_count: rows.length,
			columns: [...column_names],
			table_name: suggest_table_name(uploaded.name),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return import_json_response({ error: message }, 400);
	} finally {
		await Bun.file(temp_path).delete();
	}
}

export async function post_data_to_sql(req: BunRequest): Promise<Response> {
	const return_to = "/database";
	const form_data = await req.formData();
	const uploaded = form_data.get("json_file") ?? form_data.get("spreadsheet_file");
	const table = typeof form_data.get("table_name") === "string" ? String(form_data.get("table_name")).trim() : "";
	const slug = typeof form_data.get("slug") === "string" ? String(form_data.get("slug")).trim() : "";
	if (!(uploaded instanceof File) || uploaded.size === 0) {
		return redirect_result(req, "data-to-sql", "", { ok: false, output: "", error: "An import file is required." }, return_to);
	}
	const is_spreadsheet = /\.(?:xls|xlsx)$/i.test(uploaded.name);
	const is_json = uploaded.name.toLowerCase().endsWith(".json");
	if (!is_json && !is_spreadsheet) {
		return redirect_result(req, "data-to-sql", "", { ok: false, output: "Only .json, .xls, and .xlsx files are accepted." }, return_to);
	}
	if (await is_busy()) return busy_response(req, return_to);

	// Use a random filename in the OS temp directory. Never use the browser
	// filename as a path because it is untrusted input and may contain traversal.
	const max_upload_size_mb = require_max_upload_size_mb();
	if (uploaded.size > max_upload_size_mb * 1024 * 1024) {
		return redirect_result(req, "data-to-sql", "", { ok: false, output: "", error: `The import file must be ${max_upload_size_mb} MB or smaller.` }, return_to);
	}

	const extension = is_spreadsheet ? (uploaded.name.toLowerCase().endsWith(".xlsx") ? ".xlsx" : ".xls") : ".json";
	const temp_path = join(tmpdir(), `reepolee-import-${randomUUID()}${extension}`);
	try {
		await Bun.write(temp_path, uploaded);
		if (is_spreadsheet) {
			const raw_selections = form_data.get("sheet_selections");
			if (typeof raw_selections !== "string") {
				return redirect_result(req, "spreadsheet-to-sql", uploaded.name, { ok: false, output: "", error: "Select at least one spreadsheet sheet." }, return_to);
			}
			let selections: Array<{ sheet: string; table: string; }>;
			try {
				const parsed_selections = JSON.parse(raw_selections) as unknown;
				if (!Array.isArray(parsed_selections)) throw new Error("Invalid sheet selection.");
				selections = parsed_selections.map((selection) => {
					if (typeof selection !== "object" || selection === null) throw new Error("Invalid sheet selection.");
					const sheet = "sheet" in selection && typeof selection.sheet === "string" ? selection.sheet.trim() : "";
					const selection_table = "table" in selection && typeof selection.table === "string" ? selection.table.trim() : "";
					if (!sheet || !selection_table) throw new Error("Every selected sheet requires a table name.");
					return { sheet, table: selection_table };
				});
				if (selections.length === 0) throw new Error("Select at least one spreadsheet sheet.");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return redirect_result(req, "spreadsheet-to-sql", uploaded.name, { ok: false, output: "", error: message }, return_to);
			}
			const result = await action_spreadsheet_to_sql({ spreadsheet_path: temp_path, selections, project_root: process.cwd() });
			return redirect_result(req, "spreadsheet-to-sql", uploaded.name, result, return_to);
		}
		if (!table) {
			return redirect_result(req, "data-to-sql", uploaded.name, { ok: false, output: "", error: "A table name is required." }, return_to);
		}
		const result = await action_json_to_sql({ json_path: temp_path, table, slug, project_root: process.cwd() });
		return redirect_result(req, "data-to-sql", uploaded.name, result, return_to);
	} finally {
		await Bun.file(temp_path).delete();
	}
}

export async function post_check_compliance(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_check_compliance();
	return redirect_result(req, "check-domain-compliance", "", result, return_to);
}

export async function post_reload_routes(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	if (await is_busy()) return busy_response(req, return_to);
	const result = await action_reload_routes();
	return redirect_result(req, "reload-routes", "", result, return_to);
}

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

export async function post_clear_runs(req: BunRequest): Promise<Response> {
	const params = await params_of(req);
	const return_to = get_param(params, "return_to");
	await clear_runs();
	return redirect_result(req, "clear-runs", "", { ok: true, output: "Run log cleared." }, return_to);
}
