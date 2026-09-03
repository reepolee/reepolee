import { join } from "node:path";

import { capitalize_first, singularize } from "../naming";
import { entry_fields } from "../validation_generator";
import { generate_field_block } from "./form_ree";

import { render_field_cell, render_field_header } from "./render_field_cell";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ForeignKeyMap, LocalizedFieldMeta, ParentInfo } from "./types";

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
	child_columns_var: string = "child_columns",
	localized_fields: readonly LocalizedFieldMeta[] = [],
	child_localization_var: string = "child_localization",
): Promise<{ child_section: string; child_grid_fields: FieldDef[]; child_fields_for_dialog: FieldDef[]; }> {
	const MAX_CHILD_GRID_FIELDS = 7;
	const MAX_CHILD_DIALOG_FIELDS = 7;

	// The view's denormalized "<parent>_display" column
	// is redundant in the child grid - we're already viewing children scoped to one
	// parent record, so restating its display field is noise.
	const parent_display_column = `${singularize(parent_info.table)}_display`;

	let child_grid_fields: FieldDef[];
	let child_grid_commented: FieldDef[] = [];
	if (columns) {
		const col_keys = Object.keys(columns);
		const field_keys = col_keys.filter((k) => k !== "checkbox" && k !== "id" && k !== parent_info.fk_column && k !== parent_display_column && (columns as any)[k]?.grid !== false);
		child_grid_fields = field_keys.map((k) => {
			let found = v_fields?.find((f) => f.name === k);
			if (!found) found = fields.find((f) => f.name === k);
			return found;
		}).filter((f): f is FieldDef => !!f);
	} else {
		const display_fields = v_fields || fields;
		const all_child_grid_fields = entry_fields(display_fields, false).filter((f) => f.name !== parent_info.fk_column && f.name !== "id" && f.name !== parent_display_column);
		child_grid_fields = all_child_grid_fields.filter((f) => f.attributes?.omit_index !== true);
		child_grid_commented = all_child_grid_fields.filter((f) => f.attributes?.omit_index === true);

		if (child_grid_fields.length > MAX_CHILD_GRID_FIELDS) { child_grid_fields = child_grid_fields.slice(0, MAX_CHILD_GRID_FIELDS); }
	}
	let child_fields_for_dialog = entry_fields(fields, false).filter((f) => f.name !== parent_info.fk_column);

	if (child_fields_for_dialog.length > MAX_CHILD_DIALOG_FIELDS) { child_fields_for_dialog = child_fields_for_dialog.slice(0, MAX_CHILD_DIALOG_FIELDS); }

	// The column-configured template helper (from the config.ts columns map), if any.
	const helper_for = (name: string): string => (columns?.[name]?.helper ? String(columns[name]!.helper) : "");

	// Render headers and cells with dynamic classes from the parent render props.
	let child_headers_html = child_grid_fields.map((f) => {
		const label = `{_ children.${table_name}.child_fields.${f.name}}`;
		return render_field_header(f, label, "child", "\t\t\t", child_columns_var);
	}).join("\n");

	let child_cells_html = child_grid_fields.map((f) => render_field_cell(
		f,
		"child",
		"child",
		"\t\t\t\t",
		child_columns_var,
		helper_for(f.name)
	)).join("\n");

	if (child_grid_commented.length > 0) {
		child_headers_html += `\n\t\t\t<!-- CU fields - uncomment to show in child grid -->\n${child_grid_commented.map((f) => {
			const label = `{_ children.${table_name}.child_fields.${f.name}}`;
			const rendered = render_field_header(f, label, "child", "\t\t\t", child_columns_var);
			return `\t\t\t<!-- ${rendered.trimStart()} -->`;
		}).join("\n")}`;
		child_cells_html += `\n\t\t\t<!-- CU fields -- uncomment to show in child grid -->\n${child_grid_commented.map((f) => render_field_cell(
			f,
			"child",
			"child",
			"\t\t\t\t",
			child_columns_var,
			helper_for(f.name)
		)).map((line) => `\t\t\t<!-- ${line.trimStart()} -->`).join("\n")}`;
	}

	// Grid cols are now dynamic via props.{child_columns_var}_grid_cols at runtime
	const child_grid_cols_expr = `style="grid-template-columns: {= props.${child_columns_var}_grid_cols }"`;

	const localized_names = new Set(localized_fields.map((field) => field.field_name));
	const child_input_promises = child_fields_for_dialog.map((f) => generate_field_block(
		f,
		foreign_keys,
		table_name,
		route_prefix,
		false,
		null,
		"flat",
		localized_names,
	).then((html: string) => {
		for (const cf of child_fields_for_dialog) {
			html = html.replaceAll(`{_ labels.${cf.name}}`, `{_ children.${table_name}.child_fields.${cf.name}}`);
			const child_field_id = `child-${table_name}-${cf.name}`;
			html = html.replaceAll(`id="${cf.name}"`, `id="${child_field_id}"`);
			html = html.replaceAll(`for="${cf.name}"`, `for="${child_field_id}"`);
			html = html.replaceAll(`id="error-${cf.name}"`, `id="error-${child_field_id}"`);
		}
		html = html.replaceAll("<localized-field-tabs ", `<localized-field-tabs id-scope="child-${table_name}" `);
		html = html.replaceAll("<localized-input-text ", `<localized-input-text id-scope="child-${table_name}" `);
		html = html.replace(/value="\{= record\.[^}]+}"/g, "value=\"\"");
		html = html.replace(/value="\{= props\.record\.[^}]+}"/g, "value=\"\"");
		html = html.replace(/\.\.\.record\.[^}]+}/g, "\"\"");
		html = html.replaceAll('localization="{= props.localization }"', `localization="{= props.${child_localization_var} }"`);
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
		"child.records": child_records_var,
		"child.localization": child_localization_var,
		"child.translation_namespace": `children.${table_name}`,
	});

	child_section = child_section.replaceAll(`{= ${child_columns_var}.`, `{= props.${child_columns_var}.`);

	return { child_section, child_grid_fields, child_fields_for_dialog };
}
