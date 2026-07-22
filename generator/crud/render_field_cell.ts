import { CURRENCY_FIELD } from "$config/db_structure";

import { is_boolean_field } from "../validation_generator";
import type { FieldDef } from "./types";

/**
 * Builds a dynamic class expression for a field.
 *
 * - use_props_prefix=true:   `{= props.{col_prop}.{name}.class }` - local `props` wins
 * - use_props_prefix=false,
 * bare_field=false:        `{= {col_prop}.{name}.class }` - inside {#with props} (headers)
 * - use_props_prefix=false,
 * bare_field=true:         `{= {name}.class }`            - inside {#with props.{col_prop}} (cells)
 */
function columns_class_expr(field: FieldDef, col_prop: string, use_props_prefix: boolean = true, bare_field: boolean = false): string {
	if (bare_field) { return `{= ${field.name}.class }`; }
	const prefix = use_props_prefix ? "props." : "";
	return `{= ${prefix}${col_prop}.${field.name}.class }`;
}

/**
 * Renders a field cell as a REE template <div>.
 * Class comes from props at runtime via the specified columns prop.
 *
 * @param field       - field definition object
 * @param record_var  - record variable prefix, e.g. "record" or "child"
 * @param ctx         - 'default' for standard grids, 'child' for nested grids
 * @param indent      - indentation string (default: 4 tabs)
 * @param col_prop    - prop name for the columns map (default "columns" for index, "child_columns" for child)
 */
/**
 * Renders a field cell as a REE template <div>.
 *
 * Cells are scoped under `{#with props}` at the top level, so class expressions
 * use `{col_prop.}` prefix (e.g. `{= columns.fieldName.class }`). Values use the
 * explicit `{record_var}.` prefix (e.g. `{= record.name }`).
 */
export function render_field_cell(
	field: FieldDef,
	record_var: string = "record",
	ctx: "default" | "child" = "default",
	indent: string = "\t\t\t\t",
	col_prop: string = "columns",
): string {
	// Cells use {props.col_prop.field.class} prefix so they work both inside {#with props}
	// (where `props` falls through to the function parameter) and in standalone partials
	// like index_rows.ree (where `props` is the function parameter directly).
	const cls_expr = columns_class_expr(field, col_prop, true);
	const base_class = ctx === "child" ? "child-field" : "";
	const cls_attr = base_class ? ` class="${base_class} ${cls_expr}"` : ` class="${cls_expr}"`;

	// Use explicit record_var prefix (e.g. record.name, child.name) since {#with} context covers only columns
	const record_val = `${record_var}.`;

	switch (true) {
		case is_boolean_field(field.name):
			return `${indent}<div${cls_attr}>{~ yes_no(${record_val}${field.name}) }</div>`;
		case field.attributes?.column_type === CURRENCY_FIELD:
			return `${indent}<div${cls_attr}>{~ display_currency(${record_val}${field.name}) }</div>`;
		case field.type === "tags":
			return `${indent}<div${cls_attr}>{~ tags(${record_val}${field.name}, "pill-default", props.${field.name}) }</div>`;
		case field.type === "datetime" || field.type === "timestamp":
			return `${indent}<div${cls_attr}>{~ js_datetime_to_locale_string(${record_val}${field.name}) }</div>`;
		case field.type === "date":
			return `${indent}<div${cls_attr}>{~ js_date_to_locale_string(${record_val}${field.name}) }</div>`;
		case field.type === "image":
			return `${indent}<div${cls_attr}>{~ image_thumbnail(${record_val}${field.name}) }</div>`;
		default:
			return `${indent}<div${cls_attr}>{= ${record_val}${field.name} }</div>`;
	}
}

/**
 * Renders a field header <div>.
 * Class comes from props at runtime via the specified columns prop.
 *
 * @param field       - field definition object
 * @param label_expr  - REE expression for the label, e.g. "{_ props.labels.name }"
 * @param ctx         - 'default' for standard grids, 'child' for nested grids
 * @param indent      - indentation string
 * @param col_prop    - prop name for the columns map (default "columns" for index, "child_columns" for child)
 */
/**
 * Renders a field header <div>.
 * Headers are wrapped with `{#with props}` in the template, so class and label
 * use bare names (no `props.` prefix).
 *
 * @param field       - field definition object
 * @param label_expr  - REE expression for the label, e.g. "{_ labels.name }"
 * @param ctx         - 'default' for standard grids, 'child' for nested grids
 * @param indent      - indentation string
 * @param col_prop    - prop name for the columns map (default "columns" for index, "child_columns" for child)
 */
export function render_field_header(
	field: FieldDef,
	label_expr: string,
	ctx: "default" | "child" = "default",
	indent: string = "\t\t\t\t",
	col_prop: string = "columns",
): string {
	// Headers use bare names - wrapped with {#with props} in the template
	const cls_expr = columns_class_expr(field, col_prop, false);

	if (ctx === "child") { return `${indent}<div class="child-header ${cls_expr}">${label_expr}</div>`; }

	return `${indent}<div class="${cls_expr}">${label_expr}</div>`;
}
