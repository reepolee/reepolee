import { join } from "node:path";

import { entry_fields, is_boolean_field } from "../validation_generator";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ForeignKeyMap, ParentInfo } from "./types";

// Map semantic field types to HTML input types
const FIELD_TO_HTML_TYPE: Record<string, string> = {
	datetime: "datetime-local",
	timestamp: "datetime-local",
};

export async function generate_input_field(
	field: FieldDef,
	foreign_keys: ForeignKeyMap,
	table_name: string = "",
	route_prefix: string = "",
	is_nested: boolean = false,
	parent_info: ParentInfo | null = null,
): Promise<string> {
	const fk_info = foreign_keys.get(field.name);
	const template_base = join(process.cwd(), "generator", "templates", "fields");

	const html_type = FIELD_TO_HTML_TYPE[field.type] || field.type || "text";

	let template_path: string;
	const replacements: Record<string, string> = {
		"field.name": field.name,
		"field.label": field.label,
		"field.type": html_type,
		"table.exact": table_name,
	};

	// For nested CRUD, render parent FK field as hidden input
	if (is_nested && parent_info && field.name === parent_info.fk_column) { return `<input type="hidden" name="${field.name}" value="{= props.record.${field.name} }" />`; }

	if (fk_info && field.type === "autocomplete") {
		template_path = join(template_base, "autocomplete.ree");
		replacements["fk.table"] = fk_info.table;
		replacements["fk.column"] = fk_info.column;
		replacements["table.exact"] = table_name;
		replacements.route_prefix = route_prefix;
		replacements["autocomplete.rows"] = String(field.attributes?.rows || 6);
	} else if (fk_info) {
		template_path = join(template_base, "foreign_key.ree");
		replacements["fk.table"] = fk_info.table;
		replacements["fk.column"] = fk_info.column;
	} else if (field.type === "select" && field.attributes?.options) {
		template_path = join(template_base, "select.ree");
	} else if (field.type === "checkbox") {
		template_path = join(template_base, "checkbox.ree");
	} else if (field.type === "date") {
		template_path = join(template_base, "date.ree");
	} else if (field.type === "datetime") {
		template_path = join(template_base, "datetime.ree");
	} else if (field.type === "timestamp") {
		template_path = join(template_base, "datetime.ree");
	} else if (field.type === "textarea") {
		template_path = join(template_base, "textarea.ree");
	} else if (field.type === "number" && is_boolean_field(field.name)) {
		template_path = join(template_base, "select_yes_no.ree");
	} else if (field.type === "tags") {
		template_path = join(template_base, "tags.ree");
	} else if (field.type === "image") {
		template_path = join(template_base, "image.ree");
	} else {
		template_path = join(template_base, "input.ree");
	}

	return apply_template(await Bun.file(template_path).text(), replacements);
}
export interface FormReeOptions {
	table_name: string;
	fields: FieldDef[];
	foreign_keys: ForeignKeyMap;
	route_prefix?: string;
	route_param_value?: string;
	is_nested?: boolean;
	parent_info?: ParentInfo | null;
	route_name?: string;
}

export async function generate_form_ree(options: FormReeOptions): Promise<string> {
	const { table_name, fields, foreign_keys, route_prefix = "", route_param_value = "id", is_nested = false, parent_info = null, route_name = "" } = options;
	// For nested CRUD, exclude parent FK from visible form fields, but include it as hidden
	let filtered = entry_fields(fields, false);
	let parent_fk_field: FieldDef | null = null;
	if (is_nested && parent_info) {
		parent_fk_field = filtered.find((f) => f.name === parent_info.fk_column) || null;
		filtered = filtered.filter((f) => f.name !== parent_info.fk_column);
	}
	// Re-add parent FK field to the end so generate_input_field renders it as hidden input
	if (parent_fk_field) { filtered.push(parent_fk_field); }

	const values_init = filtered.map((f) => `${f.name}: '{= props.record.${f.name} }'`).join(", ");
	const errors_init = filtered.map((f) => `${f.name}: '{= props.errors.${f.name} || \`\` }'`).join(", ");

	const input_fields_promises = filtered.map((f) => generate_input_field(
		f,
		foreign_keys,
		table_name,
		route_prefix,
		is_nested,
		parent_info
	));
	const input_fields = (await Promise.all(input_fields_promises)).join("\n\n");

	const form_template_path = join(process.cwd(), "generator", "templates", "form.ree");
	const html = await Bun.file(form_template_path).text();

	const effective_route_name = route_name || table_name;
	return apply_template(html, {
		"table.exact": effective_route_name,
		"form.input_fields": input_fields,
		route_prefix: route_prefix,
		route_param: route_param_value,
	});
}
