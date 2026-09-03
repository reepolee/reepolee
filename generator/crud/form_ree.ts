import { join } from "node:path";

import { configured_form_fields, entry_fields } from "../validation_generator";
import { has_archive_column } from "./helpers";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ForeignKeyMap, LocalizedFieldMeta, ParentInfo } from "./types";

// Map semantic field types to HTML input types
const FIELD_TO_HTML_TYPE: Record<string, string> = {
	datetime: "datetime-local",
	timestamp: "datetime-local",
};

// field.type -> fields/<file>.ree filename (flat mode). field.type is now fully
// resolved in field_generator.ts::generate_fields_object() - no re-derivation needed
// here (previously this branched on field.type plus fk_info/attributes.options/
// is_boolean_field side-channels; those are now folded into the persisted type).
const FIELD_TYPE_TEMPLATE: Record<string, string> = {
	autocomplete: "autocomplete.ree",
	foreign_key: "foreign_key.ree",
	select: "select.ree",
	checkbox: "checkbox.ree",
	radio: "radio.ree",
	date: "date.ree",
	datetime: "datetime.ree",
	timestamp: "datetime.ree",
	markdown: "markdown.ree",
	textarea: "textarea.ree",
	yes_no: "yes_no.ree",
	tags: "tags.ree",
	image: "image.ree",
	file: "file.ree",
};

// Tags-mode ReeTag call, per field.type - built in-memory rather than loaded from a
// fields_tags/*.ree file on disk. Each entry describes the tag name plus the value
// expression forwarded as the `value` attribute; `name`/`label` are always forwarded
// identically. Extra per-type attributes (options, fk-table, folder, etc.) are appended
// by generate_input_field below where they need field-specific data (fk_info, table_name).
const TAGS_MODE_TAG: Record<string, { tag: string; value_expr: (name: string) => string; }> = {
	text: { tag: "input-text", value_expr: (n) => `{= record.${n} }` },
	checkbox: { tag: "input-checkbox", value_expr: (n) => `{= record.${n} }` },
	textarea: { tag: "input-textarea", value_expr: (n) => `{= record.${n} }` },
	select: { tag: "input-select", value_expr: (n) => `{= record.${n} }` },
	foreign_key: { tag: "input-foreign-key", value_expr: (n) => `{= record.${n} }` },
	yes_no: { tag: "input-yes-no", value_expr: (n) => `{= record.${n} }` },
	tags: { tag: "input-tags-select", value_expr: (n) => `{= record.${n} }` },
	date: { tag: "input-date-masked", value_expr: (n) => `{~ js_date_to_iso_string(record.${n})}` },
	datetime: { tag: "input-datetime-local", value_expr: (n) => `{~ js_datetime_to_iso_string(record.${n})}` },
	timestamp: { tag: "input-datetime-local", value_expr: (n) => `{~ js_datetime_to_iso_string(record.${n})}` },
	markdown: { tag: "input-markdown", value_expr: (n) => `{= record.${n} }` },
	image: { tag: "image-upload", value_expr: (n) => `{= record.${n} }` },
	file: { tag: "file-upload", value_expr: (n) => `{= record.${n} }` },
};

// Builds the tags-mode ReeTag call in-memory (no fields_tags/*.ree file on disk -
// see decision 2 in .agents/PLAN_field_kind_consolidation.md).
function generate_tags_mode_field(field: FieldDef, fk_info: { table: string; column: string; } | undefined, table_name: string, route_prefix: string): string {
	if (field.type === "autocomplete" && fk_info) {
		const rows = String(field.attributes?.rows || 6);
		return `<auto-complete\n\tfield-name="${field.name}"\n\tfk-table="${fk_info.table}"\n\tfk-column="${fk_info.column}"\n\tbase-url="${route_prefix}/${table_name}"\n\trows="${rows}"\n></auto-complete>`;
	}

	const spec = TAGS_MODE_TAG[field.type];
	if (!spec) { return `<input-text name="${field.name}" label="{_ labels.${field.name}}" value="{= record.${field.name} }"></input-text>`; }

	const label = `{_ labels.${field.name}}`;
	const value = spec.value_expr(field.name);
	let extra_attrs = "";

	if (field.type === "foreign_key" && fk_info) {
		extra_attrs = ` options="{= ${fk_info.table}_options_by_${fk_info.column} }"`;
	} else if (field.type === "select") {
		extra_attrs = ` options="{= select_fields?.${field.name} }"`;
	} else if (field.type === "tags") {
		extra_attrs = ` options="{= ${field.name}_options }"`;
	} else if (field.type === "image" || field.type === "file") {
		return `<${spec.tag} name="${field.name}" value="${value}" folder="${table_name}" label="${label}"></${spec.tag}>`;
	}

	return `<${spec.tag} name="${field.name}" label="${label}" value="${value}"${extra_attrs}></${spec.tag}>`;
}

export async function generate_input_field(
	field: FieldDef,
	foreign_keys: ForeignKeyMap,
	table_name: string = "",
	route_prefix: string = "",
	is_nested: boolean = false,
	parent_info: ParentInfo | null = null,
	template_tags: "flat" | "tags" = "flat",
): Promise<string> {
	const fk_info = foreign_keys.get(field.name);

	// For nested CRUD, render parent FK field as hidden input
	if (is_nested && parent_info && field.name === parent_info.fk_column) { return `<input type="hidden" name="${field.name}" value="{= props.record.${field.name} }" />`; }

	if (template_tags === "tags") {
		const generated = generate_tags_mode_field(field, fk_info, table_name, route_prefix);
		return generated;
	}

	const template_base = join(process.cwd(), "generator", "templates", "fields");
	const html_type = FIELD_TO_HTML_TYPE[field.type] || field.type || "text";

	const replacements: Record<string, string> = {
		"field.name": field.name,
		"field.label": field.label ?? field.name,
		"field.type": html_type,
		"table.exact": table_name,
	};

	// autocomplete/foreign_key both require fk_info to render their dedicated
	// template - without it (e.g. a user-overridden type with no matching FK
	// column) they fall back to a plain input, same as any other unmapped type.
	let template_file = FIELD_TYPE_TEMPLATE[field.type] ?? "input.ree";

	if (field.type === "autocomplete" && fk_info) {
		replacements["fk.table"] = fk_info.table;
		replacements["fk.column"] = fk_info.column;
		replacements["table.exact"] = table_name;
		replacements.route_prefix = route_prefix;
		replacements["autocomplete.rows"] = String(field.attributes?.rows || 6);
	} else if (field.type === "foreign_key" && fk_info) {
		replacements["fk.table"] = fk_info.table;
		replacements["fk.column"] = fk_info.column;
	} else if (field.type === "autocomplete" || field.type === "foreign_key") {
		template_file = "input.ree";
	}

	const template_path = join(template_base, template_file);

	return apply_template(await Bun.file(template_path).text(), replacements);
}

/**
 * Build one form field's markup, including localization wrapping when the
 * field is in `localized_names`. Shared by the full generator and the
 * fields-only refresh so both produce identical per-field output.
 *
 * Localized text fields are emitted as a dedicated input component. It owns
 * every locale control and keeps them all in the submitted form payload.
 * Other localized field types retain the legacy wrapper while they are moved
 * one-by-one to their own localized input components.
 */
/**
 * A readonly field's form markup: label plus the raw value as a static box,
 * no editor. Wrapped in the standard <field-wrapper> so the grid layout and
 * the smart-merge regex (helpers.ts) treat it like any other field - the box
 * keeps its position on refresh instead of being dropped and re-appended.
 */
function generate_readonly_field_block(field: FieldDef): string {
	return `<field-wrapper class="grid lg:col-span-2 lg:grid-cols-subgrid" data-field="${field.name}">\n\t<div class="grid gap-1">\n\t\t<div class="ml-3">{_ labels.${field.name}}</div>\n\t\t<div class="px-3 py-2 break-all bg-surface-sunken rounded-sm border border-border">{= props.record.${field.name} }</div>\n\t</div>\n</field-wrapper>`;
}

export async function generate_field_block(
	field: FieldDef,
	foreign_keys: ForeignKeyMap,
	table_name: string,
	route_prefix: string,
	is_nested: boolean,
	parent_info: ParentInfo | null,
	template_tags: "flat" | "tags",
	localized_names: ReadonlySet<string>,
	readonly_names: ReadonlySet<string> = new Set(),
): Promise<string> {
	if (readonly_names.has(field.name)) return generate_readonly_field_block(field);
	if (localized_names.has(field.name) && field.type === "text") {
		return `<localized-input-text name="${field.name}" label="{_ labels.${field.name}}" localization="{= props.localization }"></localized-input-text>`;
	}
	const input_field = await generate_input_field(field, foreign_keys, table_name, route_prefix, is_nested, parent_info, template_tags);
	if (!localized_names.has(field.name)) return input_field;
	const slot_safe_input_field = input_field.replace(/\brecord\./g, "props.record.");
	return `<localized-field-tabs field="${field.name}" label="{_ labels.${field.name}}" localization="{= props.localization }">\n${slot_safe_input_field}\n</localized-field-tabs>`;
}

export interface FormReeOptions {
	table_name: string;
	fields: FieldDef[];
	/** Physical table columns - the only reliable source for archive detection. */
	column_names?: string[];
	foreign_keys: ForeignKeyMap;
	route_prefix?: string;
	route_param_value?: string;
	is_nested?: boolean;
	parent_info?: ParentInfo | null;
	route_name?: string;
	localization_enabled?: boolean;
	localized_fields?: readonly LocalizedFieldMeta[];
	template_tags?: "flat" | "tags";
	form_hints?: boolean;
	form_details?: boolean;
	/** Fields whose value is displayed on the form without an editor. */
	readonly_fields?: ReadonlySet<string>;
	/** Per-column form settings from config.ts; absent form means included. */
	form_columns?: Record<string, { form?: boolean; }> | null;
}

// ---------------------------------------------------------------------------
// Archive UI fragments
//
// An archived record stays reachable by URL - the edit GET passes
// include_archived - so the editor needs a way back out. The button posts
// `_action=restore` to the same edit route the index grid's restore button
// uses.
// ---------------------------------------------------------------------------

function archive_form_restore_button(has_archive: boolean): string {
	if (!has_archive) return "";
	return `{#if (record.id) && record.archived_at }
					<button id="action_restore" type="button" command="show-modal" commandfor="action_restore_dialog" class="as-button-secondary">{_ actions.restore}</button>
				{/if}`;
}

function archive_form_restore_ui(has_archive: boolean, route_prefix: string, route_name: string, route_param_value: string): string {
	if (!has_archive) return "";
	return `{#if (record.id) && record.archived_at }
			<form id="restore-form" method="POST" action="{~ localized_path('${route_prefix}/${route_name}/' + record.${route_param_value} + '/edit') }" style="display: none;">
				<input type="hidden" name="_csrf_token" value="{= csrf_token }" />
				<input type="hidden" name="_action" value="restore" />
			</form>

			<dialog id="action_restore_dialog" class="p-0 rounded-xl shadow-2xl w-100">
				<div class="p-6">
					<h2 class="text-lg font-semibold">{_ actions.restore}</h2>
					<div class="mt-6 flex justify-end gap-2">
						<button class="as-button-secondary" type="button" commandfor="action_restore_dialog" command="close">{_ actions.abort_restore}</button>
						<button class="as-button-primary" type="button" command="--confirm" commandfor="action_restore_dialog">{_ actions.confirm_restore}</button>
					</div>
				</div>
			</dialog>

			<script>
				$("#action_restore_dialog").addEventListener("command", (e) => {
					if (e.command !== "--confirm") return;
					e.currentTarget.close();
					$("#restore-form").submit();
				});
			</script>
		{/if}`;
}

export async function generate_form_ree(options: FormReeOptions): Promise<string> {
	const { table_name, fields, column_names = [], foreign_keys, route_prefix = "", route_param_value = "id", is_nested = false, parent_info = null, route_name = "", localization_enabled = false, localized_fields = [], template_tags = "flat", form_hints = false, form_details = false } = options;
	// For nested CRUD, exclude parent FK from visible form fields, but include it as hidden
	let filtered = configured_form_fields(fields, options.form_columns);
	let parent_fk_field: FieldDef | null = null;
	if (is_nested && parent_info) {
		parent_fk_field = entry_fields(fields, false).find((f) => f.name === parent_info.fk_column) || null;
		filtered = filtered.filter((f) => f.name !== parent_info.fk_column);
	}
	// Re-add parent FK field to the end so generate_input_field renders it as hidden input
	if (parent_fk_field) { filtered.push(parent_fk_field); }

	const values_init = filtered.map((f) => `${f.name}: '{= props.record.${f.name} }'`).join(", ");
	const errors_init = filtered.map((f) => `${f.name}: '{= props.errors.${f.name} || \`\` }'`).join(", ");

	const localized_names = new Set(localized_fields.map((field) => field.field_name));
	const readonly_names = options.readonly_fields ?? new Set<string>();
	const input_fields_promises = filtered.map(async (field) => generate_field_block(
		field,
		foreign_keys,
		table_name,
		route_prefix,
		is_nested,
		parent_info,
		template_tags,
		localized_names,
		readonly_names
	));
	const input_fields = (await Promise.all(input_fields_promises)).join("\n\n");
	const original_fields = filtered
		.filter((field) => !readonly_names.has(field.name))
		.map((field) => `<input type="hidden" name="_original_${field.name}" value="{= props.record.${field.name} }" />`)
		.join("\n");

	const form_template_path = join(process.cwd(), "generator", "templates", "form.ree");
	const html = await Bun.file(form_template_path).text();

	const effective_route_name = route_name || table_name;

	// Each localized field renders its own tab bar and panels inline, right
	// next to the default-locale input - there is no record-wide locale
	// switcher, since different fields can have different translated locales.
	const form_body = input_fields;

	// Fields and their optional hints occupy the first two tracks. Details are
	// placed in the third track by the aside below; the layout collapses through
	// the responsive Tailwind grid utilities on smaller screens.
	const form_classes = "grid w-full gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(22rem,2fr)] lg:gap-x-6";
	const localization_attribute = localization_enabled ? "data-localized-form" : "";
	const details_classes = form_details ? "grid empty:hidden lg:col-start-3 lg:self-start" : "hidden";

	// Archive UI is decided by the schema, like the SQL layer: a table without
	// `archived_at` gets no restore markup at all.
	const has_archive = has_archive_column(column_names);

	return apply_template(html, {
		"table.exact": effective_route_name,
		"form.input_fields": form_body,
		"form.original_fields": original_fields,
		"form.classes": form_classes,
		"form.localization_attribute": localization_attribute,
		"form.details_classes": details_classes,
		"form.localization_script": localization_enabled ? `<script src="/localized-form.js?v={= version}" defer></script>` : "",
		"archive.form_restore_button": archive_form_restore_button(has_archive),
		"archive.form_restore_ui": archive_form_restore_ui(has_archive, route_prefix, effective_route_name, route_param_value),
		// The destructive action archives when the table carries archived_at and
		// hard-deletes otherwise - ids, labels and the posted _action must match.
		"archive.action_id": has_archive ? "action_archive" : "action_delete",
		"archive.action_dialog_id": has_archive ? "action_archive_dialog" : "action_delete_dialog",
		"archive.action_form_id": has_archive ? "archive-form" : "delete-form",
		"archive.action_value": has_archive ? "archive" : "delete",
		"archive.action_label": has_archive ? "{_ actions.archive}" : "{_ actions.delete}",
		"archive.action_abort": has_archive ? "{_ actions.abort_archive}" : "{_ actions.abort_delete}",
		"archive.action_confirm": has_archive ? "{_ actions.confirm_archive}" : "{_ actions.confirm_delete}",
		route_prefix: route_prefix,
		route_param: route_param_value,
	});
}
