import { join } from "node:path";

import { entry_fields, is_boolean_field } from "../validation_generator";
import { capitalize_first } from "../naming";
import { get_autocomplete_fk_tables, unique_fk_tables, user_fields } from "./helpers";
import { apply_template } from "./template_substitutor";
import { select_templates } from "./template_selector";
import type { FieldDef, ForeignKeyMap, ParentInfo } from "./types";

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
		loaders.push(`\tconst ${fk_info.table}_options_by_${fk_info.column} = await get_${fk_info.table}_options_by_${fk_info.column}();`);
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

async function load_list_strategy(has_view: boolean, view_name: string, pagination_strategy: string = "cursor"): Promise<string> {
	const parts_dir = join(process.cwd(), "generator", "templates", "index");
	const suffix = pagination_strategy === "offset" ? "_offset.ts" : ".ts";
	if (has_view) { return apply_template(await Bun.file(join(parts_dir, `query_view${suffix}`)).text(), { "view.name": view_name }); }
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

function generate_filter_fk_loader(fields: FieldDef[]): string {
	const filter_fks = fields.filter((f) => f.type === "select" && f.attributes?.filter === true && f.attributes?.foreign_key);

	if (filter_fks.length === 0) return "";

	return filter_fks.map((f) => {
		const fk = f.attributes.foreign_key;
		return `\tconst filter_${f.name}_options = await get_${fk.table}_options_by_${fk.column}();`;
	}).join("\n");
}

function generate_filter_fk_options(fields: FieldDef[]): string {
	const filter_fks = fields.filter((f) => f.type === "select" && f.attributes?.filter === true && f.attributes?.foreign_key);

	if (filter_fks.length === 0) return "";

	return filter_fks.map((f) => `${f.name}: filter_${f.name}_options`).join(", ");
}

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface GenerateIndexConfig {
	table_name: string;
	fields: FieldDef[];
	sort_options: string;
	view_name: string;
	has_view: boolean;
	first_field: string;
	foreign_keys: ForeignKeyMap;
	route_prefix?: string;
	crud_name?: string;
	route_param_value?: string;
	is_nested?: boolean;
	parent_info?: ParentInfo;
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	route_name?: string;
}

// ---------------------------------------------------------------------------
// Main index.ts generation
// ---------------------------------------------------------------------------

export async function generate_index_ts(config: GenerateIndexConfig): Promise<string> {
	const { table_name, fields, sort_options, view_name, has_view, first_field, foreign_keys, route_prefix = "", crud_name = "", route_param_value = "id", is_nested = false, parent_info = null, pagination_strategy = "cursor", render_strategy = "load", route_name = "" } = config;
	const parts_dir = join(process.cwd(), "generator", "templates", "index");
	const tmpl = select_templates({ pagination_strategy, render_strategy, is_nested, has_view });

	const read = (name: string) => Bun.file(join(parts_dir, name)).text();

	const [header_imports, route_export, header, validate, index_get, index_post, new_get, edit_get, edit_post, list_strategy, view_import, select_imports, index_bulk_delete] = await Promise.all([
		read("header_imports.ts"),
		read(tmpl.route_export),
		read(tmpl.header),
		read("validate.ts"),
		tmpl.index_get ? read(tmpl.index_get) : Promise.resolve(""),
		read(tmpl.index_post),
		tmpl.new_get ? read(tmpl.new_get) : Promise.resolve(""),
		read(tmpl.edit_get),
		read(tmpl.edit_post),
		load_list_strategy(has_view, view_name, pagination_strategy),
		load_view_import(has_view),
		load_select_imports(foreign_keys),
		tmpl.index_bulk_delete ? read(tmpl.index_bulk_delete) : Promise.resolve(""),
	]);

	const effective_route_name = route_name || table_name;
	const table_crud_name = crud_name || `${effective_route_name}_crud`;
	const tags_fields = generate_tags_fields(fields);

	// Conditional imports - build only what's needed per route type
	const conditional_helpers = is_nested ? "" : "import { create_toast_cookie } from \"$lib/cookies\";\n";
	const crud_routes_import = is_nested ? "" : "import { feature_paths, redirect_from_referer, run_bulk_delete } from \"$lib/crud_routes\";\n";
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
			"validate.params": generate_validate_params(fields),
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
			"autocomplete.options_route": autocomplete_options_route,
			"new.get_autocomplete_display": has_autocomplete ? "\n\n\tconst autocomplete_display_values: Record<string, string> = {};" : "",
			"edit.get_autocomplete_display": has_autocomplete ? `\n\n\tconst autocomplete_display_values: Record<string, string> = {};\n${autocomplete_display_fetch}` : "",
			"new.autocomplete_display_options": autocomplete_display_options,
			"edit.autocomplete_display_options": autocomplete_display_options,
			"filter.fk_loader": generate_filter_fk_loader(fields),
			"filter.fk_options": generate_filter_fk_options(fields),
			"import.conditional_helpers": conditional_helpers,
			"import.crud_routes": crud_routes_import,
			"import.pagination": pagination_import,
			"import.bun": bun_import,
			route_param: route_param_value,
			"route.param_imports": has_custom_route_param ? `import { get_record_by_route_param, delete_record_by_route_param } from "./sql";\n` : "",
			"edit.get_lookup": has_custom_route_param ? `const ${route_param_value} = req.params.${route_param_value} || "";\n\tconst record = await get_record_by_route_param(${route_param_value});` : `const id = req.params.id ? String(req.params.id) : "";\n\tconst record = await get_record_by_id(id);`,
			"edit.post_lookup": has_custom_route_param ? `const ${route_param_value} = req.params.${route_param_value} || "";\n\tconst lookup_record = await get_record_by_route_param(${route_param_value});\n\tconst id = lookup_record?.id || "";` : `const id = req.params.id ? String(req.params.id) : "";`,
			"edit.post_delete_call": has_custom_route_param ? `await delete_record_by_route_param(${route_param_value})` : `await delete_record(id)`,
			"edit.post_delete_catch_lookup": has_custom_route_param ? `await get_record_by_route_param(${route_param_value})` : `await get_record_by_id(id)`,
			"nested.delete_call": `await delete_record(child_id)`,
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
		content += `\nexport const route_definitions: RouteDefinition[] = [\n\t{ url: "${route_url}", crud: ${table_crud_name}, nav_title_key: "${nav_key}"${nav_module} },\n];\n`;
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
