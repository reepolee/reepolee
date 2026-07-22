import { join } from "node:path";

import { capitalize_first, singularize } from "../naming";
import { entry_fields } from "../validation_generator";
import { generate_input_field } from "./form_ree";

import { render_field_cell, render_field_header } from "./render_field_cell";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ForeignKeyMap, ParentInfo } from "./types";

// ---------------------------------------------------------------------------
// generate_child_section_html - shared between full generation and refresh-fields paths
// ---------------------------------------------------------------------------

export async function generate_child_section_html(
	table_name: string,
	parent_info: ParentInfo,
	fields: FieldDef[],
	v_fields: FieldDef[] | null,
	columns: Record<string, any> | null,
	foreign_keys: ForeignKeyMap,
	route_prefix: string,
	child_records_var: string = "child_records",
	child_parent_label_var: string = "parent_label",
	child_ui_var: string = "child_ui",
	child_fields_var: string = "child_fields",
	child_columns_var: string = "child_columns",
): Promise<{ child_section: string; child_grid_fields: FieldDef[]; child_fields_for_dialog: FieldDef[]; }> {
	const MAX_CHILD_GRID_FIELDS = 7;
	const MAX_CHILD_DIALOG_FIELDS = 7;

	let child_grid_fields: FieldDef[];
	let child_grid_commented: FieldDef[] = [];
	if (columns) {
		const col_keys = Object.keys(columns);
		const field_keys = col_keys.filter((k) => k !== "checkbox" && k !== "id" && k !== parent_info.fk_column && (columns as any)[k]?.grid !== false);
		child_grid_fields = field_keys.map((k) => {
			let found = v_fields?.find((f) => f.name === k);
			if (!found) found = fields.find((f) => f.name === k);
			return found;
		}).filter((f): f is FieldDef => !!f);
	} else {
		const display_fields = v_fields || fields;
		const all_child_grid_fields = entry_fields(display_fields, false).filter((f) => f.name !== parent_info.fk_column && f.name !== "id");
		child_grid_fields = all_child_grid_fields.filter((f) => f.attributes?.omit_index !== true);
		child_grid_commented = all_child_grid_fields.filter((f) => f.attributes?.omit_index === true);

		if (child_grid_fields.length > MAX_CHILD_GRID_FIELDS) { child_grid_fields = child_grid_fields.slice(0, MAX_CHILD_GRID_FIELDS); }
	}
	let child_fields_for_dialog = entry_fields(fields, false).filter((f) => f.name !== parent_info.fk_column);

	if (child_fields_for_dialog.length > MAX_CHILD_DIALOG_FIELDS) { child_fields_for_dialog = child_fields_for_dialog.slice(0, MAX_CHILD_DIALOG_FIELDS); }

	// Render headers and cells with dynamic class from props.{child_columns_var}
	// Headers are wrapped with {#with props} in the template, so labels use bare names.
	let child_headers_html = child_grid_fields.map((f) => {
		const label = `{= child_fields.${f.name} }`;
		return render_field_header(f, label, "child", "\t\t\t", child_columns_var);
	}).join("\n");

	let child_cells_html = child_grid_fields.map((f) => render_field_cell(
		f,
		"child",
		"child",
		"\t\t\t\t",
		child_columns_var
	)).join("\n");

	if (child_grid_commented.length > 0) {
		child_headers_html += `\n\t\t\t<!-- CU fields - uncomment to show in child grid -->\n${child_grid_commented.map((f) => {
			const label = `{= child_fields.${f.name} }`;
			const rendered = render_field_header(f, label, "child", "\t\t\t", child_columns_var);
			return `\t\t\t<!-- ${rendered.trimStart()} -->`;
		}).join("\n")}`;
		child_cells_html += `\n\t\t\t<!-- CU fields -- uncomment to show in child grid -->\n${child_grid_commented.map((f) => render_field_cell(
			f,
			"child",
			"child",
			"\t\t\t\t",
			child_columns_var
		)).map((line) => `\t\t\t<!-- ${line.trimStart()} -->`).join("\n")}`;
	}

	// Grid cols are now dynamic via props.{child_columns_var}_grid_cols at runtime
	const child_grid_cols_expr = `style="grid-template-columns: {= props.${child_columns_var}_grid_cols }"`;

	const child_input_promises = child_fields_for_dialog.map((f) => generate_input_field(
		f,
		foreign_keys,
		table_name,
		route_prefix,
		false,
		null
	).then((html: string) => {
		for (const cf of child_fields_for_dialog) {
			html = html.replaceAll(`{_ labels.${cf.name}}`, `{= child_fields.${cf.name} }`);
		}
		html = html.replace(/value="\{= record\.[^}]+}"/g, "value=\"\"");
		html = html.replace(/\.\.\.record\.[^}]+}/g, "\"\"");
		return html;
	}));
	const child_input_fields = (await Promise.all(child_input_promises)).join("\n\n");

	const child_fill_js = child_fields_for_dialog.map((f) => `\t\t\tqs('[name="${f.name}"]').value = record.${f.name} || '';`).join("\n");
	const child_clear_js = child_fields_for_dialog.map((f) => `\t\t\tqs('[name="${f.name}"]').value = '';`).join("\n");
	const child_error_field_list = child_fields_for_dialog.map((f) => `'${f.name}'`).join(", ");

	const template_path = join(process.cwd(), "generator", "templates", "details_index.ree");
	let child_section = apply_template(await Bun.file(template_path).text(), {
		"child.headers": child_headers_html,
		"child.cells": child_cells_html,
		"child.grid_cols": child_grid_cols_expr,
		"parent.table": parent_info.table,
		"child.table": table_name,
		"child.fk_column": parent_info.fk_column,
		"parent.route_param": parent_info.route_param,
		"child.singular_label": capitalize_first(singularize(table_name)),
		"child.input_fields": child_input_fields.trim(),
		"child.form_fill_js": child_fill_js,
		"child.form_clear_js": child_clear_js,
		"child.error_field_list": child_error_field_list,
		"ui.empty_text": `{= props.${child_ui_var}.empty_text || "No ${table_name.replace(/_/g, " ")} found." }`,
		"child.records": child_records_var,
		"child.parent_label": child_parent_label_var,
		"child.ui": child_ui_var,
		"child.fields": child_fields_var,
	});

	child_section = child_section.replaceAll(`{= child_fields.`, `{= ${child_fields_var}.`);

	return { child_section, child_grid_fields, child_fields_for_dialog };
}
