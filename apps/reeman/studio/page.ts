import { get_cookie } from "$lib/cookies";
import { render } from "$lib/render";
import { create_ctx } from "$lib/request_context";
import { db_type } from "$lib/resolve_db_type";
import { singularize } from "$generator/naming";
import type { BunRequest } from "bun";

import { diff_ddl_lines } from "./lib/ddl_diff";
import { render_create_table } from "./lib/ddl_writer";
import { domain_type_matches, get_domain_groups, get_domain_types } from "./lib/domain_types";
import { column_reference_value } from "./lib/form_data";
import { get_folder_studio_tables, is_system_column, read_studio_file, StudioError } from "./lib/model";
import { group_demo_files, list_demo_files, studio_url } from "../database/lib/sql_files";

export { studio_url } from "../database/lib/sql_files";
import { get_version, reset_versions } from "./lib/undo_store";
import type { StudioFile, StudioStatement, StudioTable } from "./lib/types";

type PageOverrides = {
	path?: string;
	object_name?: string;
	form_error?: string;
	table?: StudioTable;
	status?: number;
};

export async function get_studio_page(req: BunRequest): Promise<Response> {
	return render_studio_page(req);
}

export async function render_studio_page(req: BunRequest, overrides: PageOverrides = {}): Promise<Response> {
	const ctx = await create_ctx(req, import.meta.dir);
	const url = new URL(req.url);
	const path = overrides.path ?? url.searchParams.get("path") ?? "";
	const requested_object = overrides.object_name ?? url.searchParams.get("object") ?? "";
	const files = list_demo_files().filter((file) => file.dialect === db_type);
	const file_groups = group_demo_files(files);

	let model: StudioFile | null = null;
	let selected: StudioStatement | null = null;
	let form_error = overrides.form_error ?? "";

	let version = 0;
	if (path) {
		try {
			model = read_studio_file(path);
			selected = select_statement(model, requested_object);
			if (selected?.table && selected.object_name) {
				if (overrides.table) {
					// A validation-error re-render: show the attempted (invalid) edit
					// without touching the version cache at all.
					selected = { ...selected, table: overrides.table };
				} else {
					const requested_version = url.searchParams.get("v");
					if (requested_version === null) {
						// A visit with no ?v (typed URL, sidebar link, fresh open) always
						// starts a new edit session at version 0 - the on-disk table -
						// and resets the version cache so stale history from an
						// earlier, abandoned session can't resurface.
						reset_versions(model.path, selected.object_name, selected.table);
					} else {
						version = Number(requested_version);
						const table_override = get_version(model.path, selected.object_name, version);
						if (table_override) selected = { ...selected, table: table_override };
					}
				}
			}
		} catch (error) {
			form_error = error instanceof Error ? error.message : "Unable to open the SQL file.";
		}
	}

	const objects = model ? object_links(model) : { tables: [], views: [] };
	const selected_table = selected?.table ?? null;
	const tables = model ? get_folder_studio_tables(model.path) : [];
	const domain_types = model ? get_domain_types(model.dialect) : [];
	const domain_groups = model ? get_domain_groups(model.dialect) : [];
	const hide_system_columns = get_cookie(req, "studio_hide_system_columns") === "1";
	const selected_columns = selected_table?.columns.map((column) => {
		const is_system = is_system_column(column.name);
		return {
			...column,
			reference_value: column_reference_value(selected_table, column, tables),
			domain_compliant: model && column.domain_type ? domain_type_matches(column.domain_type, column.type_string, model.dialect) : false,
			canonical_type: domain_types.find((domain) => domain.name === column.domain_type)?.type_string ?? "",
			is_system,
			hidden: hide_system_columns && is_system,
		};
	}) ?? [];
	const selected_view = selected?.kind === "create_view" ? selected : null;
	const fk_options = model ? get_fk_options(tables) : [];
	const fk_id_options = fk_options.filter((option) => option.value.endsWith(".id"));
	const fk_other_options = fk_options.filter((option) => !option.value.endsWith(".id"));
	const fk_targets = get_fk_targets(tables);
	const selected_object = selected?.object_name ?? "";
	const undo_available = version > 0;
	const base_table = model && selected_object ? get_version(model.path, selected_object, 0) : null;
	const ddl_diff = selected_table && model && base_table && version > 0
		? diff_ddl_lines(render_create_table(base_table, model.dialect), render_create_table(selected_table, model.dialect))
		: null;

	return render("index", {
		data: {
			page_title: ctx.translations.ui?.title,
			file_groups,
			path,
			model,
			objects,
			selected_object,
			selected_table,
			selected_columns,
			selected_view,
			domain_types,
			domain_groups,
			fk_id_options,
			fk_other_options,
			fk_targets,
			ddl_preview: selected_table && model ? render_create_table(selected_table, model.dialect) : "",
			ddl_diff,
			form_error,
			undo_available,
			version,
			hide_system_columns,
		},
		ctx,
		status: overrides.status ?? (form_error && !model ? 400 : 200),
	});
}

function get_fk_targets(tables: StudioTable[]): Array<{ table_name: string; column_name: string; reference: string; }> {
	return tables.flatMap((table) => table.columns.some((column) => column.name === "id") ? [{
		table_name: table.name,
		column_name: `${singularize(table.name)}_id`,
		reference: `${table.name}.id`,
	}] : []);
}

function select_statement(model: StudioFile, requested: string): StudioStatement | null {
	const editable = model.statements.filter((item) => item.kind === "create_table" || item.kind === "create_view");
	if (requested) return editable.find((item) => item.object_name === requested) ?? editable[0] ?? null;
	return editable[0] ?? null;
}

function object_links(model: StudioFile) {
	const tables: Array<{ name: string; url: string; }> = [];
	const views: Array<{ name: string; url: string; }> = [];
	for (const statement of model.statements) {
		if (statement.kind !== "create_table" && statement.kind !== "create_view") continue;
		const item = { name: statement.object_name, url: studio_url(model.path, statement.object_name) };
		if (statement.kind === "create_table") tables.push(item);
		else views.push(item);
	}
	return { tables, views };
}

export function get_fk_options(tables: StudioTable[]): Array<{ value: string; label: string; }> {
	const options: Array<{ value: string; label: string; }> = [];
	for (const table of tables) {
		for (const column of table.columns) {
			const value = `${table.name}.${column.name}`;
			options.push({ value, label: `${value} (${column.type_string})` });
		}
	}
	return options;
}

export function read_required(params: URLSearchParams, key: string): string {
	const value = params.get(key)?.trim() ?? "";
	if (!value) throw new StudioError(`Missing ${key}.`);
	return value;
}
