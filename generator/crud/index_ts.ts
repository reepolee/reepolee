import { join } from "node:path";

import { entry_fields, is_boolean_field } from "../validation_generator";
import { capitalize_first } from "../naming";
import { get_autocomplete_fk_tables, has_archive_column, unique_fk_tables, user_fields } from "./helpers";
import { apply_template } from "./template_substitutor";
import { select_templates } from "./template_selector";
import type { LocalizedFieldMeta } from "./types";
import type { FieldDef, ForeignKeyMap, ParentInfo } from "./types";
import type { NavigationConfig } from "./schema_reader";

// ---------------------------------------------------------------------------
// Tags fields helpers
// ---------------------------------------------------------------------------

function generate_tags_fields(fields: FieldDef[]): FieldDef[] { return entry_fields(fields, false).filter((f) => f.type === "tags" && f.attributes?.tags?.table); }

function generate_tags_loader(tags_fields: FieldDef[]): string {
	if (tags_fields.length === 0) return "";
	return tags_fields.map((f) => `\tconst ${f.name}_options = await get_${f.name}_options();`).join("\n");
}

function generate_tags_options(tags_fields: FieldDef[]): string {
	if (tags_fields.length === 0) return "";
	return tags_fields.map((f) => `\t\t${f.name}_options,`).join("\n");
}

function load_tags_imports(tags_fields: FieldDef[]): string {
	if (tags_fields.length === 0) return "";
	return `${tags_fields.map((f) => `import { get_${f.name}_options } from "./sql";`).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// index.ts controller generator helpers
// ---------------------------------------------------------------------------

function generate_form_params(fields: FieldDef[]): string { return entry_fields(fields, false).map((f) => `\t\t${f.name}: params.get(\`${f.name}\`)?.trim() || "",`).join("\n"); }
function generate_original_form_params(fields: FieldDef[]): string { return entry_fields(fields, false).map((f) => `\t\t${f.name}: params.get(\`_original_${f.name}\`)?.trim() || "",`).join("\n"); }
function generate_readonly_record_values(readonly_fields: ReadonlySet<string>): string {
	if (readonly_fields.size === 0) return "";
	return `\n\tObject.assign(data, {\n${[...readonly_fields].map((field_name) => `\t\t${field_name}: String(current_record.${field_name} ?? ""),`).join("\n")}\n\t});`;
}

function generate_validate_params(fields: FieldDef[]): string { return entry_fields(fields, false).map((f) => `\t\t${f.name}: body.${f.name} || "",`).join("\n"); }

function generate_empty_record(fields: FieldDef[]): string {
	const props = entry_fields(fields, false).map((f) => is_boolean_field(f.name) ? `${f.name}: -1` : `${f.name}: ''`);
	return `{ ${props.join(", ")} }`;
}

function generate_empty_errors(fields: FieldDef[]): string {
	const props = user_fields(fields).map((f) => `${f.name}: ''`);
	return `{ ${props.join(", ")} }`;
}

// ---------------------------------------------------------------------------
// Select options helpers
// ---------------------------------------------------------------------------

function generate_select_fields_loader(foreign_keys: ForeignKeyMap): string {
	const loaders: string[] = [];

	for (const fk_info of unique_fk_tables(foreign_keys)) {
		const locale_arg = fk_info.localized ? "ctx.locale" : "";
		loaders.push(`\tconst ${fk_info.table}_options_by_${fk_info.column} = await get_${fk_info.table}_options_by_${fk_info.column}(${locale_arg});`);
	}

	return loaders.join("\n");
}

function generate_select_options(foreign_keys: ForeignKeyMap): string {
	const opts: string[] = [];

	for (const fk_info of unique_fk_tables(foreign_keys)) {
		opts.push(`\t\t${fk_info.table}_options_by_${fk_info.column},`);
	}

	return opts.join("\n");
}

async function load_list_strategy(has_view: boolean, view_name: string, pagination_strategy: string = "cursor", localized: boolean = false): Promise<string> {
	const parts_dir = join(process.cwd(), "generator", "templates", "index");
	const suffix = pagination_strategy === "offset" ? "_offset.ts" : ".ts";
	if (has_view) { return apply_template(await Bun.file(join(parts_dir, `query_view${suffix}`)).text(), { "view.name": view_name, "sql.locale_arg": localized ? ", ctx.locale" : "" }); }
	return await Bun.file(join(parts_dir, `query_table${suffix}`)).text();
}

async function load_view_import(has_view: boolean): Promise<string> {
	if (!has_view) return "";
	const parts_dir = join(process.cwd(), "generator", "templates", "index");
	return await Bun.file(join(parts_dir, "import_view.ts")).text();
}

async function load_select_imports(foreign_keys: ForeignKeyMap): Promise<string> {
	const parts_dir = join(process.cwd(), "generator", "templates", "index");
	const fk_tables = unique_fk_tables(foreign_keys);
	if (fk_tables.length === 0) return "";
	const template = await Bun.file(join(parts_dir, "import_select_fk.ts")).text();
	return fk_tables.map((fk) => apply_template(template, {
		"fk.table": fk.table,
		"fk.column": fk.column,
	})).join("\n");
}

// ---------------------------------------------------------------------------
// Filter FK options helpers
// ---------------------------------------------------------------------------

// A column is filterable either via the DDL comment `F` flag (synced into
// fields[name].attributes.filter at schema-generation time) or via a manual
// `filter: true` added to the `columns` map in table.ts after generation.
// Both sources must be checked - table.ts customizations never round-trip
// back into attributes.filter.
function is_filterable_fk_field(f: FieldDef, columns?: Record<string, any> | null): boolean {
	if (f.type !== "foreign_key" || !f.attributes?.foreign_key) return false;
	return f.attributes?.filter === true || columns?.[f.name]?.filter === true;
}

function generate_filter_fk_loader(fields: FieldDef[], columns?: Record<string, any> | null, foreign_keys: ForeignKeyMap = new Map()): string {
	const filter_fks = fields.filter((f) => is_filterable_fk_field(f, columns));

	if (filter_fks.length === 0) return "";

	return filter_fks.map((f) => {
		const fk = f.attributes!.foreign_key!;
		const locale_arg = foreign_keys.get(f.name)?.localized ? "ctx.locale" : "";
		return `\tconst filter_${f.name}_options = await get_${fk.table}_options_by_${fk.column}(${locale_arg});`;
	}).join("\n");
}

function generate_filter_fk_options(fields: FieldDef[], columns?: Record<string, any> | null): string {
	const filter_fks = fields.filter((f) => is_filterable_fk_field(f, columns));

	if (filter_fks.length === 0) return "";

	return filter_fks.map((f) => `${f.name}: filter_${f.name}_options`).join(", ");
}

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface GenerateIndexConfig {
	table_name: string;
	fields: FieldDef[];
	/** Physical table columns - the only reliable source for archive detection. */
	column_names?: string[];
	/** The view's physical columns, when the route reads through `v_<table>`.
	 * Only a view that selects `archived_at` through can be filtered by
	 * archive state. */
	view_column_names?: string[];
	sort_options: string;
	view_name: string;
	has_view: boolean;
	first_field: string;
	foreign_keys: ForeignKeyMap;
	columns?: Record<string, any> | null;
	route_prefix?: string;
	crud_name?: string;
	route_param_value?: string;
	is_nested?: boolean;
	parent_info?: ParentInfo;
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	route_name?: string;
	is_auto_increment_pk?: boolean;
	localization_enabled?: boolean;
	localized_fields?: LocalizedFieldMeta[];
	/** Fields displayed on edit forms but never accepted from the request. */
	readonly_fields?: ReadonlySet<string>;
	navigation?: NavigationConfig;
}

// ---------------------------------------------------------------------------
// Main index.ts generation
// ---------------------------------------------------------------------------

export async function generate_index_ts(config: GenerateIndexConfig): Promise<string> {
	const { table_name, fields, column_names = [], view_column_names = [], sort_options, view_name, has_view, first_field, foreign_keys, columns = null, route_prefix = "", crud_name = "", route_param_value = "id", is_nested = false, parent_info = null, pagination_strategy = "cursor", render_strategy = "load", route_name = "", is_auto_increment_pk = true, localization_enabled = false, localized_fields = [], readonly_fields = new Set<string>() } = config;
	const parts_dir = join(process.cwd(), "generator", "templates", "index");
	const tmpl = select_templates({ pagination_strategy, render_strategy, is_nested, has_view });

	const read = (name: string) => Bun.file(join(parts_dir, name)).text();

	// Localization: which FIELDS are localizable is baked here (schema
	// structure); which LOCALES exist is resolved per request from config, so
	// adding a locale never requires regenerating a CRUD.
	const localized = localization_enabled && !is_nested;

	const [header_imports, route_export, header, validate, index_get, index_post, new_get, edit_get, edit_post, list_strategy, view_import, select_imports, index_bulk_delete, copy_locale_post, generate_locale_post] = await Promise.all([
		read("header_imports.ts"),
		read(tmpl.route_export),
		read(tmpl.header),
		read("validate.ts"),
		tmpl.index_get ? read(tmpl.index_get) : Promise.resolve(""),
		read(tmpl.index_post),
		tmpl.new_get ? read(tmpl.new_get) : Promise.resolve(""),
		read(tmpl.edit_get),
		read(tmpl.edit_post),
		load_list_strategy(has_view, view_name, pagination_strategy, localized),
		load_view_import(has_view),
		load_select_imports(foreign_keys),
		tmpl.index_bulk_delete ? read(tmpl.index_bulk_delete) : Promise.resolve(""),
		localization_enabled && !is_nested ? read("copy_locale_post.ts") : Promise.resolve(""),
		localization_enabled && !is_nested ? read("generate_locale_post.ts") : Promise.resolve(""),
	]);

	// Archive-aware routes must tell the SQL layer who is archiving. `ctx` is in
	// scope at every delete call site, so the id threads through without any
	// change to the route signatures themselves.
	const has_archive = has_archive_column(column_names);
	const archive_delete_arg = has_archive ? ", ctx.user?.id ?? null" : "";
	const archive_bulk_mode = has_archive ? "\n\t\tmode: \"archive\"," : "";
	// The record-removal function, _action value, and sql_log verb all follow
	// the schema: "archive" for a table carrying archived_at, "delete" for a
	// real hard DELETE.
	const archive_record_fn = has_archive ? "archive_record" : "delete_record";
	const archive_record_by_route_param_fn = has_archive ? "archive_record_by_route_param" : "delete_record_by_route_param";
	const archive_action_value = has_archive ? "archive" : "delete";
	const archive_log_verb = has_archive ? "Archive" : "Delete";
	// User-facing error prose follows the same split: an archivable table is
	// "archived", a hard-deleting one is "deleted".
	const archive_disabled_error = has_archive ? "Archive is disabled." : "Delete is disabled.";
	const archive_bulk_disabled_error = has_archive ? "Bulk archive is disabled." : "Bulk delete is disabled.";
	const archive_fk_error = has_archive ? "Cannot archive this record because it's referenced by other records." : "Cannot delete this record because it's referenced by other records.";
	const archive_record_error = has_archive ? "Error archiving record." : "Error deleting record.";
	// The index page's archive UI (scope-driven filter, count breakdown, restore)
	// only exists on a top-level route: a nested child grid never calls
	// search_records, so a scope key would reach nothing there. M8 covers the
	// nested case separately.
	const index_has_archive = has_archive && !is_nested;
	// The list read goes through the view when there is one, and only a view
	// that selects `archived_at` through can be filtered by archive state.
	// Getting this wrong means the "Archived" scope silently lists live rows.
	const view_has_archive = has_archive_column(view_column_names);
	const archive_import = index_has_archive ? "import { is_archive_scope_key, resolve_archive_filter } from \"$lib/archive\";\n" : "";
	const archive_sql_imports = index_has_archive ? ", get_archive_counts, restore_record" : "";
	// The reserved keys carry an empty where_clause by design - they are read as
	// an archive_filter, never as SQL - so they must not reach get_scope_clause().
	const archive_scope_guard = index_has_archive ? " && !is_archive_scope_key(scope_key)" : "";
	const archive_filter_setup = index_has_archive
		? "const archive_filter = resolve_archive_filter(scope_key);\n\tconst archive_counts = await get_archive_counts(scope_clause);"
		: "";
	const archive_render_data = index_has_archive ? "archive_counts,\n\t\t\tarchive_filter," : "";
	const archive_filter_arg = index_has_archive ? ", archive_filter" : "";
	const archive_view_filter_arg = index_has_archive && view_has_archive ? ", archive_filter" : "";
	// An archived record stays reachable by URL so the editor can restore it.
	// A localized table's lookup takes locale_code first, so the flag cannot be
	// passed positionally without it.
	const archive_include_arg = has_archive ? (localized ? ", \"\", true" : ", true") : "";
	const archive_route_param_include_arg = has_archive ? ", true" : "";
	// Restore is deliberately not gated on enable_archive: that flag governs
	// whether rows may be archived from this route, and a row that is already
	// archived must stay recoverable either way.
	const archive_restore_branch = index_has_archive
		? `if (action === "restore") {
		const restored = await restore_record(id);

		if (!restored) {
			return render("notfound", {
				data: { title: "404 Not Found" },
				status: 404,
				ctx,
			});
		}

		await cache.invalidate(TABLE_NAME);
		sql_log({s:"Restore", "t":\`\${feature}\`, id}, ctx.user?.username)
		return Response.redirect(redirect_url, 303);
	}`
		: "";

	const effective_route_name = route_name || table_name;
	const table_crud_name = crud_name || `${effective_route_name}_crud`;
	const tags_fields = generate_tags_fields(fields);

	// Conditional imports - build only what's needed per route type
	const conditional_helpers = is_nested ? "" : "import { create_toast_cookie } from \"$lib/cookies\";\n";
	const crud_routes_import = is_nested ? "" : "import { feature_paths, is_list_return_url, redirect_from_referer, run_bulk_remove } from \"$lib/crud_routes\";\n";
	const pagination_import = is_nested ? "" : pagination_strategy === "offset" ? "import { build_pagination_urls as build_offset_pagination_urls, get_limit_options, parse_pagination_params as parse_offset_pagination_params } from \"$lib/pagination\";\n" : "import { build_cursor_pagination_urls, get_limit_options, parse_cursor_pagination_params } from \"$lib/pagination\";\n";
	const bun_import = `import { type BunRequest } from "bun";`;

	// Nested tables' route_param_value is only a URL segment name, never a SQL
	// column - their lookups always go through get_record_by_id_and_parent.
	const has_custom_route_param = !is_nested && route_param_value !== "id";

	// Autocomplete FK support
	const autocomplete_fks = get_autocomplete_fk_tables(fields, foreign_keys);
	const has_autocomplete = autocomplete_fks.length > 0;

	const autocomplete_options_handler = has_autocomplete ? await Bun.file(join(parts_dir, "options_get.ts")).text() : "";

	const autocomplete_dispatch = has_autocomplete ? autocomplete_fks.map((fk: any) => `\tif (fk_table === "${fk.table}") {\n\t\tresults = await search_${fk.table}_options(q);\n\t}`).join(
		" else "
	) : "";

	const autocomplete_options_route = has_autocomplete ? `"/${effective_route_name}/options": get_${effective_route_name}_options,\n` : "";

	const autocomplete_display_fetch = has_autocomplete ? `${autocomplete_fks.map((fk: any) => `\tif (record.${fk.field_name}) {\n\t\tconst _r = await get_${fk.table}_option_by_${fk.column}(record.${fk.field_name});\n\t\tif (_r) autocomplete_display_values.${fk.field_name} = _r.option_text;\n\t}`).join(
		"\n"
	)}\n` : "";

	const autocomplete_display_options = has_autocomplete ? "\tautocomplete_display_values," : "";

	const localization_import = localized
		? `import { enqueue } from "$queue/index";\nimport { copy_localized_values, generate_localized_values, get_locale_rows } from "$lib/localized_copy";\nimport { build_localization_props, localized_input_form_state, parse_changed_localized_form, parse_copy_request, parse_generate_request, parse_localized_form, validate_localized_inputs, validate_touched_localized_inputs } from "$lib/localized_form";\nimport { locales } from "$config/supported_locales";\nimport { invalidate_all_locales, save_locale_values } from "$lib/locale_write";\n`
		: "";
	// The CSS-only tab switcher pre-selects whichever locale tab the visitor
	// last used, read from a plain cookie - no JS is needed to restore it.
	const preferred_locale_arg = localized ? `, preferred_locale: get_cookie(req, "preferred_locale") ?? undefined` : "";
	const localization_config = localized
		? `\nconst LOCALIZED_FIELDS = ${JSON.stringify(localized_fields.map((f) => ({ field_name: f.field_name, label: f.label, input_type: f.input_type, upload_folder: f.upload_folder })))} as const;\nconst LOCALIZED_FIELD_NAMES = LOCALIZED_FIELDS.map((field) => field.field_name);
const LOCALE_PROTECTED_COLUMNS = ${JSON.stringify(fields.filter((field) => !localized_fields.some((localized_field) => localized_field.field_name === field.name)).map((field) => field.name))} as readonly string[];\n`
		: "";
	// Translations are validated against the same Zod rules as the source field.
	const validation_schema_import = localized ? ", schema" : "";
	// The editor's `record` prop is always the default-locale (base table) row -
	// build_localization_props() binds it to the "default_locale" tab and reads
	// every other locale separately via locale_rows. Passing ctx.locale here
	// would fetch the *visitor's* UI-locale row instead, so browsing the editor
	// in a non-default locale would show that locale's text in both tabs.
	// The localization editor must always receive the base/default-locale row.
	// Non-default values are loaded separately into locale_rows; passing
	// ctx.locale here makes the selected UI locale appear as the Original tab.
	const read_locale_arg = "";
	// entity_path() points at the edit page (/products/1/edit); the copy route
	// hangs off the record itself, so build it from base_path().
	const copy_action_expr = `\`\${base_path()}/\${record.${route_param_value}}/copy-locale\``;

	const load_localization = localized
		? `const locale_rows = await get_locale_rows(TABLE_NAME, Number(record.id), locales);\n\tconst localization = build_localization_props({ fields: LOCALIZED_FIELDS, record, locale_rows, copy_action: ${copy_action_expr}${preferred_locale_arg} });`
		: "";
	const localization_data = localized ? "localization," : "";
	// New forms have no database row to load, but still need the localization
	// metadata that makes localized-field-tabs render its labels and locale tabs.
	const new_localization_data = localized
		? `localization: build_localization_props({ fields: LOCALIZED_FIELDS, record: ${generate_empty_record(fields)}, copy_action: ""${preferred_locale_arg} }),`
		: "";
	const new_post_localization_data = localized
		? `localization: build_localization_props({ fields: LOCALIZED_FIELDS, record: data, copy_action: ""${preferred_locale_arg} }),`
		: "";
	const parse_localization = localized
		? `const localized_inputs = parse_changed_localized_form(params, LOCALIZED_FIELDS);\n\tconst localized_values = localized_input_form_state(localized_inputs);`
		: "";
	const validate_localization = localized
		? `const localized_errors = validate_localized_inputs(localized_inputs, schema, ctx.translations.errors);`
		: "";
	// Per-field blur validation: a user leaving a translation input sends
	// `touched: ["_lv[field][locale]"]` to */validate. The client has no schema
	// locally, so the endpoint mirrors the base validation and also validates
	// the touched <field>|<locale> pair(s), returning errors keyed the same way
	// the localized panel's per-locale `#error-<field>|<locale>` elements expect.
	const validate_localized_touched = localized
		? `	const localized_errors = validate_touched_localized_inputs(body, touched, LOCALIZED_FIELDS, schema, ctx.translations.errors);
	Object.assign(errors, localized_errors);`
		: "";
	const localization_errors_check = localized ? " || Object.keys(localized_errors).length > 0" : "";
	const localization_error_data = localized
		? `localization: build_localization_props({ fields: LOCALIZED_FIELDS, record: { ...existing_record, ...data }, values: localized_values, errors: localized_errors, copy_action: \`\${base_path()}/\${__route_param__}/copy-locale\`${preferred_locale_arg} }),`
		: "";
	// Each non-default locale's row takes its own submitted values. Editing a
	// value by hand clears its provenance - it is no longer a copy.
	const save_localization = localized ? `await save_locale_values(TABLE_NAME, Number(id), localized_inputs, LOCALE_PROTECTED_COLUMNS);` : "";
	// Save-time failures (e.g. update_record throwing) must still re-render the
	// full editor - including per-field language controls and panels - rather
	// than falling back to a bare English-only form. Re-fetch the record fresh
	// so the error page reflects the same state the user was looking at.
	const catch_existing_record = localized ? `const existing_record = await get_record_by_id(id${read_locale_arg});\n\t\t` : "";
	const catch_title_data = localized ? `title: existing_record ? \`Edit \${existing_record.${first_field}}\` : undefined,\n\t\t\t\t` : "";
	const catch_record_data = localized ? `record: existing_record ? { ...existing_record, ...data } : data,` : `record: data,`;
	const catch_localization_data = localized
		? `\n\t\t\t\tlocalization: build_localization_props({ fields: LOCALIZED_FIELDS, record: existing_record ? { ...existing_record, ...data } : data, values: localized_values, errors: {}, copy_action: \`\${base_path()}/\${__route_param__}/copy-locale\`${preferred_locale_arg} }),`
		: "";
	const copy_locale_route = localized ? `"/${effective_route_name}/:${route_param_value}/copy-locale": { POST: post_${effective_route_name}_copy_locale },\n\t` : "";
	// The generate-locale route mirrors copy-locale but enqueues a translate_record
	// job instead of copying: the AI call runs in the queue worker.
	const generate_locale_route = localized ? `"/${effective_route_name}/:${route_param_value}/generate-locale": { POST: post_${effective_route_name}_generate_locale },\n\t` : "";

	const autocomplete_imports = has_autocomplete ? `${autocomplete_fks.map((fk: any) => `import { search_${fk.table}_options, get_${fk.table}_option_by_${fk.column} } from "./sql";`).join(
		"\n"
	)}\n` : "";

	let content = [
		header_imports,
		route_export,
		header,
		validate,
		index_get,
		index_post,
		new_get,
		edit_get,
		edit_post,
		index_bulk_delete,
		copy_locale_post,
		generate_locale_post,
		autocomplete_options_handler,
	].filter(Boolean).join("\n\n");

	// Build parent path for nested CRUD placeholder substitution
	const parent_path = is_nested && parent_info ? `${parent_info.table}/:${parent_info.route_param}` : "";

	content = apply_template(
		content,
		{
			"table.exact": effective_route_name,
			"table.crud_name": table_crud_name,
			"table.title": capitalize_first(table_name),
			"sort.options": sort_options,
			"parent.path": parent_path,
			"parent.table": parent_info?.table || "",
			"parent.fk_column": parent_info?.fk_column || "",
			"parent.route_param": parent_info?.route_param || "",
			"list.strategy": list_strategy,
			"import.ree_icon": render_strategy === "stream" ? "import { ICONS } from \"$lib/ree_icon\";\n" : "",
			"import.view": view_import,
			"view.name": view_name,
			"field.first": first_field,
			"create.params": generate_form_params(fields),
			"update.params": generate_form_params(fields),
			"update.original_params": generate_original_form_params(fields),
			"update.readonly_values": generate_readonly_record_values(readonly_fields),
			"validate.params": generate_validate_params(fields),
			"validate.localized": validate_localized_touched,
			"empty.record": generate_empty_record(fields),
			"empty.errors": generate_empty_errors(fields),
			"new.get_foreign_key_options": generate_select_fields_loader(foreign_keys),
			"new.foreign_key_options": generate_select_options(foreign_keys),
			"edit.get_foreign_key_options": generate_select_fields_loader(foreign_keys),
			"edit.foreign_key_options": generate_select_options(foreign_keys),
			"import.select_functions": select_imports + autocomplete_imports,
			"import.tags": load_tags_imports(tags_fields),
			"nested.import": is_nested ? ", get_record_by_id_and_parent" : "",
			"parent.fk_init": is_nested ? `\t// Preserve parent FK before validation (required by Zod schema)\n\tdata.${parent_info?.fk_column || "parent_id"} = req.params.${parent_info?.route_param || "id"};` : "",
			"new.get_tags_options": generate_tags_loader(tags_fields),
			"new.tags_options": generate_tags_options(tags_fields),
			"edit.get_tags_options": generate_tags_loader(tags_fields),
			"edit.tags_options": generate_tags_options(tags_fields),
			route_prefix: route_prefix,
			"autocomplete.dispatch": autocomplete_dispatch,
			"autocomplete.options_route": autocomplete_options_route + copy_locale_route + generate_locale_route,
			"import.localization": localization_import,
			"import.validation_schema": validation_schema_import,
			"sql.locale_arg": localized ? ", ctx.locale" : "",
			// The edit form's own fields (`data`/`valid_data`) are always the
			// default-locale content - other locales are saved separately via
			// save_locale_values() from `localized_inputs`. Passing ctx.locale here
			// would tell fan_out_update the visitor's UI locale is "the edited
			// locale", writing the base form's fields into that locale's table as
			// full localized columns and overwriting its real translation.
			// The ordinary form fields are always the default-locale row. Localized
			// values from the other tabs are saved separately below, so passing the
			// visitor's UI locale here would write the Original fields to a clone.
			"sql.edit_locale_arg": "",
			"localization.config": localization_config,
			"edit.load_localization": load_localization,
			"edit.localization_data": localization_data,
			"new.localization_data": new_localization_data,
			"new.post_localization_data": new_post_localization_data,
			"edit.parse_localization": parse_localization,
			"edit.validate_localization": validate_localization,
			"edit.localization_errors_check": localization_errors_check,
			"edit.localization_error_data": localization_error_data,
			"edit.save_localization": save_localization,
			"edit.catch_existing_record": catch_existing_record,
			"edit.catch_title_data": catch_title_data,
			"edit.catch_record_data": catch_record_data,
			"edit.catch_localization_data": catch_localization_data,
			"new.get_autocomplete_display": has_autocomplete ? "\n\n\tconst autocomplete_display_values: Record<string, string> = {};" : "",
			"edit.get_autocomplete_display": has_autocomplete ? `\n\n\tconst autocomplete_display_values: Record<string, string> = {};\n${autocomplete_display_fetch}` : "",
			"new.autocomplete_display_options": autocomplete_display_options,
			"edit.autocomplete_display_options": autocomplete_display_options,
			"filter.fk_loader": generate_filter_fk_loader(fields, columns, foreign_keys),
			"filter.fk_options": generate_filter_fk_options(fields, columns),
			"import.conditional_helpers": conditional_helpers,
			"import.crud_routes": crud_routes_import,
			"import.pagination": pagination_import,
			"import.bun": bun_import,
			route_param: route_param_value,
			"route.param_imports": has_custom_route_param ? `import { get_record_by_route_param, ${archive_record_by_route_param_fn} } from "./sql";\n` : "",
			"edit.get_lookup": has_custom_route_param ? `const ${route_param_value} = req.params.${route_param_value} || "";\n\tconst record = await get_record_by_route_param(${route_param_value}${archive_route_param_include_arg});` : is_auto_increment_pk ? `const id = Number((req.params as Record<string, string> | undefined)?.id || 0);\n\tconst record = await get_record_by_id(id${read_locale_arg}${archive_include_arg});` : `const id = req.params.id ? String(req.params.id) : "";\n\tconst record = await get_record_by_id(id${read_locale_arg}${archive_include_arg});`,
			"edit.post_lookup": has_custom_route_param ? `const ${route_param_value} = req.params.${route_param_value} || "";\n\tconst lookup_record = await get_record_by_route_param(${route_param_value}${archive_route_param_include_arg});\n\tconst id = lookup_record?.id || "";` : is_auto_increment_pk ? `const id = Number((req.params as Record<string, string> | undefined)?.id || 0);` : `const id = req.params.id ? String(req.params.id) : "";`,
			"edit.post_delete_call": has_custom_route_param ? `await ${archive_record_by_route_param_fn}(${route_param_value}${archive_delete_arg})` : `await ${archive_record_fn}(id${archive_delete_arg})`,
			"edit.post_delete_catch_lookup": has_custom_route_param ? `await get_record_by_route_param(${route_param_value})` : `await get_record_by_id(id${read_locale_arg})`,
			"sql.read_locale_arg": read_locale_arg,
			"nested.delete_call": `await ${archive_record_fn}(child_id${archive_delete_arg})`,
			"archive.delete_arg": archive_delete_arg,
			"archive.bulk_mode": archive_bulk_mode,
			"archive.record_fn": archive_record_fn,
			"archive.action_value": archive_action_value,
			"archive.log_verb": archive_log_verb,
			"archive.disabled_error": archive_disabled_error,
			"archive.bulk_disabled_error": archive_bulk_disabled_error,
			"archive.fk_error": archive_fk_error,
			"archive.record_error": archive_record_error,
			"import.archive": archive_import,
			"archive.sql_imports": archive_sql_imports,
			"archive.scope_guard": archive_scope_guard,
			"archive.filter_setup": archive_filter_setup,
			"archive.render_data": archive_render_data,
			"archive.filter_arg": archive_filter_arg,
			"archive.view_filter_arg": archive_view_filter_arg,
			"archive.restore_branch": archive_restore_branch,
		}
	);

	// Append route_definitions export for the barrel (routes/system/index.ts) or routes.ts static import
	if (!is_nested) {
		const clean_prefix = route_prefix ? route_prefix.replace(
			/^\//,
			""
		) : "";
		const route_url = route_prefix ? `${route_prefix}/${effective_route_name}` : `/${effective_route_name}`;
		const nav_key = clean_prefix ? `${clean_prefix}.${effective_route_name}` : effective_route_name;
		const nav_module = clean_prefix ? `, module: "${clean_prefix}"` : "";
		const routedef_import = `import type { RouteDefinition } from "$lib/route_builder";`;
		if (!content.includes(routedef_import)) {
			const lines = content.split("\n");
			const last_import = lines.findLastIndex((l) => l.trim().startsWith("import "));
			lines.splice(last_import + 1, 0, routedef_import);
			content = lines.join("\n");
		}
		const navigation_import = `import { navigation } from "./schema/table";`;
		if (!content.includes(navigation_import)) {
			const lines = content.split("\n");
			const last_import = lines.findLastIndex((line) => line.trim().startsWith("import "));
			lines.splice(last_import + 1, 0, navigation_import);
			content = lines.join("\n");
		}
		content += `\nexport const route_definitions: RouteDefinition[] = [\n\t{ url: "${route_url}", crud: ${table_crud_name}, nav_title_key: "${nav_key}"${nav_module}, nav_section_key: navigation.section_key, nav_item_order: navigation.item_order, nav_section_order: navigation.section_order, nav_group_order: navigation.group_order, nav_final_order: navigation.final_order },\n];\n`;
	}

	// Sanitize JS identifiers when route_name has chars invalid in JS identifiers
	// (e.g. hyphens in "my-companies" -> "my_companies" for function/variable names)
	// Route paths (surrounded by quotes/slashes) are NOT affected by this regex
	// because they don't have alphanum/underscore before/after the route name.
	if (effective_route_name.match(/[^a-zA-Z0-9_]/)) {
		const js_safe = effective_route_name.replace(/[^a-zA-Z0-9_]/g, "_");
		const escaped = effective_route_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		content = content.replace(new RegExp(`([a-zA-Z0-9_])${escaped}([a-zA-Z0-9_])`, "g"), `$1${js_safe}$2`);
	}

	return content;
}
