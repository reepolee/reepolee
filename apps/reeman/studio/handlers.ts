import { make_toast } from "$lib/cookies";
import { localized_url, resolve_locale } from "$lib/route";
import type { BunRequest } from "bun";

import { apply_column_renames, detect_column_renames } from "./lib/column_rename";
import { check_studio_file, format_check_report } from "./lib/ddl_checker";
import { diff_ddl_lines } from "./lib/ddl_diff";
import { render_create_table } from "./lib/ddl_writer";
import { parse_table_form, validate_table_references } from "./lib/form_data";
import { add_new_table, copy_table, delete_table, delete_view, derive_copy_path, generate_view, get_studio_tables, get_table_statement, read_studio_file, StudioError, write_studio_file, write_studio_file_copy } from "./lib/model";
import { adapt_schema_to_standard } from "./lib/schema_adaptation";
import { read_required, render_studio_page, studio_url } from "./page";
import { clear_versions, get_version, push_version, reset_versions } from "./lib/undo_store";

export async function post_save_table(req: BunRequest): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	const path = params.get("path")?.trim() ?? "";
	const table_name = params.get("table_name")?.trim() ?? "";
	try {
		const model = read_studio_file(read_required(params, "path"));
		const statement = get_table_statement(model, read_required(params, "table_name"));
		const source_table = statement.table!;
		const source_indexes: (number | null)[] = [];
		statement.table = parse_table_form(params, source_table, model.dialect, get_studio_tables(model), source_indexes);
		validate_table_references(statement.table, model);
		statement.dirty = true;

		// INSERTs, triggers, and indexes are raw text with no editor of their own,
		// so a rename that is not propagated leaves the file unopenable and
		// unrepairable from the studio.
		const renames = detect_column_renames(source_table, statement.table, source_indexes);
		const touched = apply_column_renames(model, renames);

		write_studio_file(model);
		// The on-disk baseline just moved - version 0 (disk) is no longer this
		// table's on-disk state, so the whole version history is stale.
		clear_versions(model.path, table_name);
		const message = touched.length > 0
			? `Table saved. Renamed column(s) updated in: ${touched.join(", ")}.`
			: "Table saved.";
		return redirect_saved(req, path, table_name, message);
	} catch (error) {
		return render_studio_page(req, {
			path,
			object_name: table_name,
			form_error: error_message(error),
			status: 400,
		});
	}
}

export async function post_preview(req: BunRequest): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	try {
		const model = read_studio_file(read_required(params, "path"));
		const statement = get_table_statement(model, read_required(params, "table_name"));
		const source_table = statement.table!;
		const original_ddl = statement.is_new ? "" : render_create_table(source_table, model.dialect);
		const table = parse_table_form(params, source_table, model.dialect, get_studio_tables(model));
		validate_table_references(table, model);
		const updated_ddl = render_create_table(table, model.dialect);
		const diff = diff_ddl_lines(original_ddl, updated_ddl);

		let version = Number(params.get("v") ?? "0");
		if (!statement.is_new) {
			// The page always creates version 0 before the form can be submitted,
			// but seed it defensively in case the cache file was cleared out from
			// under an open tab (e.g. a save in another tab).
			if (get_version(model.path, statement.object_name, 0) === null) {
				reset_versions(model.path, statement.object_name, source_table);
				version = 0;
			}
			// A real, structural change - append a new version (plain data, not
			// DDL text) so undo can restore it without re-parsing SQL.
			if (diff.some((line) => line.kind !== "same")) {
				version = push_version(model.path, statement.object_name, version, table);
			}
		}

		return Response.json({ diff, version });
	} catch (error) {
		return new Response(error_message(error), { status: 400 });
	}
}

/**
 * Undo: redirects to the normal GET /studio URL with ?v=<version-1> - a
 * plain 303, same as every other mutation, so the address bar stays correct
 * and nothing is written to the tracked SQL file. The GET handler applies
 * that version's stashed table state (see render_studio_page), so there is
 * no cross-request state to hand off here.
 */
export async function post_undo(req: BunRequest): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	const path = params.get("path")?.trim() ?? "";
	const table_name = params.get("table_name")?.trim() ?? "";
	try {
		read_required(params, "path");
		read_required(params, "table_name");
		const version = Math.max(0, Number(params.get("v") ?? "0") - 1);
		const locale = resolve_locale(req);
		const base = localized_url("/studio", locale);
		const target = `${studio_url(path, table_name).replace("/studio", base)}&v=${version}`;
		return new Response(null, { status: 303, headers: { Location: target } });
	} catch (error) {
		return render_studio_page(req, { path, object_name: table_name, form_error: error_message(error), status: 400 });
	}
}

export async function post_new_table(req: BunRequest): Promise<Response> {
	return mutate_named(req, "new_name", (model, _source, name) => add_new_table(model, name), "Table created.");
}

export async function post_copy_table(req: BunRequest): Promise<Response> {
	return mutate_named(req, "new_name", (model, source, name) => copy_table(model, source, name), "Table copied.");
}

export async function post_delete_table(req: BunRequest): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	const path = params.get("path")?.trim() ?? "";
	const source = params.get("table_name")?.trim() ?? "";
	try {
		const model = read_studio_file(read_required(params, "path"));
		delete_table(model, read_required(params, "table_name"));
		write_studio_file(model);
		return redirect_saved(req, path, "", "Table deleted.");
	} catch (error) {
		return render_studio_page(req, { path, object_name: source, form_error: error_message(error), status: 400 });
	}
}

export async function post_delete_view(req: BunRequest): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	const path = params.get("path")?.trim() ?? "";
	const view_name = params.get("view_name")?.trim() ?? "";
	try {
		const model = read_studio_file(read_required(params, "path"));
		delete_view(model, read_required(params, "view_name"));
		write_studio_file(model);
		return redirect_saved(req, path, "", "View deleted.");
	} catch (error) {
		return render_studio_page(req, { path, object_name: view_name, form_error: error_message(error), status: 400 });
	}
}

export async function post_generate_view(req: BunRequest): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	const path = params.get("path")?.trim() ?? "";
	const source = params.get("table_name")?.trim() ?? "";
	try {
		const model = read_studio_file(read_required(params, "path"));
		const view_name = generate_view(model, read_required(params, "table_name"));
		write_studio_file(model);
		return redirect_saved(req, path, view_name, "View generated.");
	} catch (error) {
		return render_studio_page(req, { path, object_name: source, form_error: error_message(error), status: 400 });
	}
}

export async function post_adapt_schema(req: BunRequest): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	const path = params.get("path")?.trim() ?? "";
	const source = params.get("table_name")?.trim() ?? "";
	try {
		const model = read_studio_file(read_required(params, "path"));
		const summary = adapt_schema_to_standard(model);
		const report = await check_studio_file(model);
		if (!report.ok) throw new StudioError(`Adapted schema failed validation - not saved. ${format_check_report(report)}`);

		const copy_path = derive_copy_path(model.path, "adapted");
		write_studio_file_copy(model, copy_path);
		const adapted_parts: string[] = [];
		if (summary.tables_adapted.length > 0) adapted_parts.push(`tables: ${summary.tables_adapted.join(", ")}`);
		if (summary.views_adapted.length > 0) adapted_parts.push(`views: ${summary.views_adapted.join(", ")}`);
		const adapted_text = adapted_parts.length > 0
			? `Adapted copy saved to ${copy_path}: ${adapted_parts.join("; ")}.`
			: `Schema already standard. Copy saved to ${copy_path}.`;
		const message = `${adapted_text} ${format_check_report(report)}`;
		return redirect_saved(req, copy_path, source, message);
	} catch (error) {
		return render_studio_page(req, { path, object_name: source, form_error: error_message(error), status: 400 });
	}
}

async function mutate_named(
	req: BunRequest,
	name_key: string,
	mutate: (model: ReturnType<typeof read_studio_file>, source: string, name: string) => void,
	message: string,
): Promise<Response> {
	const params = new URLSearchParams(await req.text());
	const path = params.get("path")?.trim() ?? "";
	const source = params.get("table_name")?.trim() ?? "";
	const name = params.get(name_key)?.trim() ?? "";
	try {
		const model = read_studio_file(read_required(params, "path"));
		mutate(model, source, read_required(params, name_key));
		write_studio_file(model);
		return redirect_saved(req, path, name, message);
	} catch (error) {
		return render_studio_page(req, { path, object_name: source, form_error: error_message(error), status: 400 });
	}
}

function redirect_saved(req: BunRequest, path: string, object_name: string, message: string): Response {
	const locale = resolve_locale(req);
	const base = localized_url("/studio", locale);
	const target = studio_url(path, object_name).replace("/studio", base);
	const headers = new Headers({ Location: target });
	headers.append("Set-Cookie", make_toast("toast-studio", { message }).toString());
	return new Response(null, { status: 303, headers });
}

function error_message(error: unknown): string {
	return error instanceof Error ? error.message : "Studio operation failed.";
}
