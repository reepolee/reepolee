import { join } from "node:path";

import { resolve_option_display_field } from "../schema/display_contract";
import { entry_fields } from "../validation_generator";
import { field_interface_prop, get_autocomplete_fk_tables, log_step, unique_fk_tables, user_fields } from "./helpers";
import { get_view_dependencies, resolve_display_source } from "./sql_introspector";
import { select_templates } from "./template_selector";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ForeignKeyMap, LocalizedFieldMeta, ParentInfo } from "./types";

/**
 * Generate self-contained select options functions for foreign key tables.
 * These are generated inline in the local sql.ts, with no cross-folder imports at runtime.
 */
async function generate_foreign_key_select_functions(foreign_keys: ForeignKeyMap): Promise<string> {
	const fk_tables = unique_fk_tables(foreign_keys);
	log_step(`generate_foreign_key_select_functions: ${fk_tables.length} unique FK tables: [${fk_tables.map((f) => f.table).join(", ")}]`);
	if (fk_tables.length === 0) return "";

	const functions: string[] = [];

	for (let i = 0; i < fk_tables.length; i++) {
		const fk_info = fk_tables[i]!;
		const fk_table = fk_info.table;
		const display_source = await resolve_display_source(fk_table, false);
		const option_text_field = display_source.option_field;
		log_step(`generate_foreign_key_select_functions: option field for ${fk_table} = "${option_text_field}"`);

		functions.push(`export async function get_${fk_table}_options_by_${fk_info.column}(): Promise<Options[]> {
\ttry {
\t\treturn await timed_query("${fk_table}", "get_${fk_table}_options_by_${fk_info.column}", async () => {
\t\t\tconst records = await db\`SELECT ${fk_info.column} as option_value, ${option_text_field} as option_text FROM ${fk_table} ORDER BY ${option_text_field} ASC LIMIT 50\`;
\t\t\treturn records as Options[];
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching ${fk_table} options:", error);
\t\treturn [];
\t}
}`);
	}

	log_step(`generate_foreign_key_select_functions: all ${fk_tables.length} FK function(s) generated`);
	return functions.join("\n\n");
}

interface AutocompleteFunctions {
	search: string;
	lookup: string;
}

async function generate_autocomplete_functions(
	fields: FieldDef[],
	foreign_keys: ForeignKeyMap
): Promise<AutocompleteFunctions> {
	const autocomplete_fks = get_autocomplete_fk_tables(fields, foreign_keys);
	const search_functions: string[] = [];
	const lookup_functions: string[] = [];

	for (const fk of autocomplete_fks) {
		const display_source = await resolve_display_source(fk.table, true);
		const search_lines = display_source.search_field === "search_text"
			? `const search_term = get_fulltext_param(query);
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, ${display_source.option_field} as option_text FROM ${display_source.source_name} WHERE \${get_fulltext_clause()} ORDER BY ${display_source.option_field} ASC LIMIT 20\`;`
			: `const search_term = '%' + query + '%';
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, ${display_source.option_field} as option_text FROM ${display_source.source_name} WHERE ${display_source.search_field} LIKE \${search_term} ORDER BY ${display_source.option_field} ASC LIMIT 20\`;`;
		search_functions.push(`export async function search_${fk.table}_options(query: string): Promise<Options[]> {
\ttry {
\t\treturn await timed_query("${fk.table}", "search_${fk.table}_options", async () => {
\t\t\t${search_lines}
\t\t\treturn records as Options[];
\t\t});
\t} catch (error) {
\t\tconsole.error("Error searching ${fk.table} options:", error);
\t\treturn [];
\t}
}`);
		lookup_functions.push(`export async function get_${fk.table}_option_by_${fk.column}(value: string): Promise<{ option_value: string; option_text: string } | null> {
\ttry {
\t\treturn await timed_query("${fk.table}", "get_${fk.table}_option_by_${fk.column}", async () => {
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, ${display_source.option_field} as option_text FROM ${display_source.source_name} WHERE ${fk.column} = \${value} LIMIT 1\`;
\t\t\treturn records[0] || null;
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching ${fk.table} option by value:", error);
\t\treturn null;
\t}
}`);
	}

	return {
		search: search_functions.join("\n\n"),
		lookup: lookup_functions.join("\n\n"),
	};
}

// ---------------------------------------------------------------------------
// Main sql.ts generation
// ---------------------------------------------------------------------------
export interface SqlTsOptions {
	table_name: string;
	fields: FieldDef[];
	search_field: string;
	tags_fields?: FieldDef[];
	foreign_keys?: ForeignKeyMap;
	id_type?: string;
	id_type_interface?: string;
	is_auto_increment_pk?: boolean;
	route_param_value?: string;
	is_nested?: boolean;
	parent_info?: ParentInfo | null;
	route_prefix?: string;
	pagination_strategy?: "cursor" | "offset";
	route_name?: string;
	column_names?: string[];
	localization_enabled?: boolean;
	localized_fields?: LocalizedFieldMeta[];
}

export async function generate_sql_ts(options: SqlTsOptions): Promise<string> {
	const {
		table_name,
		fields,
		search_field,
		tags_fields = [],
		foreign_keys = new Map(),
		id_type = "number",
		id_type_interface = "number",
		is_auto_increment_pk = true,
		route_param_value = "id",
		is_nested = false,
		parent_info = null,
		route_prefix = "",
		pagination_strategy = "cursor",
		route_name = "",
		column_names = [],
		localization_enabled = false,
		localized_fields = [],
	} = options;

	// Content localization only reaches search_records for plain (non-nested)
	// tables - a nested child is scoped to its parent record and is localized
	// through that parent, never independently.
	const localized = !is_nested && localization_enabled;
	const locale_param = localized ? ", locale_code: string = \"\"" : "";
	const locale_arg = localized ? ", locale_code" : "";
	const cache_key_locale = localized ? ", locale_code" : "";
	const localized_column_names = localized_fields.map((field) => field.field_name);
	const localized_import = localized
		? `import { all_locale_tables, locale_table } from "$lib/locale_tables";\nimport { fan_out_create, fan_out_delete, fan_out_update, invalidate_all_locales } from "$lib/locale_write";\n`
		: "";
	// LOCALIZED_COLUMNS is read by the runtime locale-table guard and by the
	// write fan-out, which needs to know which columns must NOT be copied
	// across locales.
	const localized_config = localized
		? `\nexport const LOCALIZED_COLUMNS = ${JSON.stringify(localized_column_names)} as const;\nexport const WRITE_COLUMNS = ${JSON.stringify(entry_fields(fields, false).map((f) => f.name))} as const;\nconst FAN_OUT = { table_name: TABLE_NAME, localized_columns: LOCALIZED_COLUMNS as readonly string[], write_columns: WRITE_COLUMNS as readonly string[] };\n`
		: "";
	// The physical table for a request's locale (D3): the base table for the
	// default locale, `<table>_<locale>` otherwise. Resolved once per call
	// rather than threaded into every query as a parameter.
	const locale_resolver = localized
		? `\n/** Physical table holding this locale's rows - base table for the default locale. */\nfunction resolve_table(locale_code: string): string {\n\treturn locale_table(TABLE_NAME, locale_code);\n}\n`
		: "";
	const from_source_setup = localized
		? `const from_source = resolve_table(locale_code);\n\t\t\t\t\tconst from_params: string[] = [];`
		: `const from_source = TABLE_NAME;\n\t\t\t\t\tconst from_params: string[] = [];`;
	// Single-record reads (get_record_by_id) resolve the same physical table as
	// a search does, so an edit page and its JSON view answer in the locale the
	// request asked for instead of always serving the base table.
	const read_source = localized ? "resolve_table(locale_code)" : "TABLE_NAME";
	// A localized search depends on every locale table, since a write fans out
	// to all of them (D6a). Non-localized tables keep the introspected list.
	const cache_dependencies = localized ? "all_locale_tables(TABLE_NAME)" : "VIEW_DEPENDENCIES";
	const write_locale_param = localized ? ", locale_code: string = \"\"" : "";
	const filtered = user_fields(fields);
	const editable = entry_fields(fields, false);
	const field_names = fields.map((field) => field.name);
	const option_text_field = resolve_option_display_field(field_names);
	const display_field_names = option_text_field === "option_display" ? ["display", "option_display"] : ["display"];

	// For non-auto-increment PKs, id is in the fields, so don't duplicate it
	const has_id_in_fields = fields.some((f) => f.name === "id");
	const interface_fields = has_id_in_fields ? filtered.filter((f) => f.name !== "id")
		.map((f) => field_interface_prop(f))
		.join("\n") : [
			"\tid: number;",
			...filtered.map((f) => field_interface_prop(f)),
		].join("\n");
	// For non-auto-increment PKs, include id in insert fields since user provides it
	const insert_fields = editable.map((f) => f.name).join(", ");
	const insert_values = editable.map((f) => `\${record.${f.name}}`).join(", ");
	const update_set = editable.filter((f) => f.name !== "id")
		.map((f) => `${f.name} = \${record.${f.name}}`)
		.join(", ");

	// Write bodies. A localized table fans out across every locale table and
	// owns its own cache invalidation (D6a) - the route handler no longer
	// touches the cache at all. A non-localized table keeps today's single
	// statement, so its generated output is unchanged.
	const create_fan_out = localized
		? `await fan_out_create(FAN_OUT, insert_result.lastInsertRowid as number, record as unknown as { [key: string]: unknown });\n\t\t\tawait invalidate_all_locales(TABLE_NAME);`
		: "";
	const update_fan_out = localized
		? `await fan_out_update(FAN_OUT, id, record as unknown as { [key: string]: unknown }, locale_code);\n\t\t\tawait invalidate_all_locales(TABLE_NAME);`
		: `await db\`UPDATE ${table_name} SET ${update_set} WHERE id = \${id}\`;`;
	const delete_fan_out = localized
		? `const affected = await fan_out_delete(TABLE_NAME, id);\n\t\t\tawait invalidate_all_locales(TABLE_NAME);\n\t\t\treturn affected > 0;`
		: `const result = await db\`DELETE FROM ${table_name} WHERE id = \${id}\`;\n\t\t\treturn (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;`;

	// Generate route_param lookup and delete functions
	// Nested tables always look up via get_record_by_id_and_parent, keyed on the
	// real "id" column - never on route_param_value (which is only a URL segment
	// name for nested tables, not a SQL column).
	const _has_route_param = !is_nested && route_param_value !== "id";
	const route_param_lookup = _has_route_param ? `export async function get_record_by_route_param(value: string): Promise<Record | undefined> {
\ttry {
\t\treturn await timed_query("${table_name}", "get_record_by_route_param", async () => {
\t\t\tconst records = await db\`SELECT * FROM ${table_name} WHERE ${route_param_value} = \${value} LIMIT 1\`;
\t\t\treturn records[0] as Record | undefined;
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching record by route param:", error);
\t\treturn undefined;
\t}
}

export async function delete_record_by_route_param(value: string): Promise<boolean> {
\ttry {
\t\treturn await timed_query("${table_name}", "delete_record_by_route_param", async () => {
\t\t\tconst result = await db\`DELETE FROM ${table_name} WHERE ${route_param_value} = \${value}\`;
\t\t\treturn (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
\t\t});
\t} catch (error) {
\t\tconsole.error("Error deleting record:", error);
\t\tconst error_msg = error instanceof Error ? error.message : String(error);
\t\tif (error_msg.includes("foreign key")) {
\t\t\tthrow error;
\t\t}
\t\treturn false;
\t}
}` : "";

	const create_omit_fields = is_auto_increment_pk ? ["id", ...display_field_names] : display_field_names;
	const update_omit_fields = ["id", ...display_field_names];
	const create_omit_union = create_omit_fields.map((field_name) => `"${field_name}"`).join(" | ");
	const update_omit_union = update_omit_fields.map((field_name) => `"${field_name}"`).join(" | ");
	const create_record_arg = create_omit_union ? `Omit<Record, ${create_omit_union}>` : "Record";
	const update_record_arg = `Omit<Record, ${update_omit_union}>`;
	const create_record_return = is_auto_increment_pk ? `const get_result = await db\`SELECT * FROM ${table_name} WHERE id = \${insert_result.lastInsertRowid} LIMIT 1\`;
\t\treturn get_result[0] as Record;` : `const get_result = await db\`SELECT * FROM ${table_name} WHERE id = \${record.id} LIMIT 1\`;
\t\treturn get_result[0] as Record;`;

	// Generate tag option functions
	const tag_functions = tags_fields.map((f) => {
		const table = f.attributes!.tags!.table;
		return `export async function get_${f.name}_options(): Promise<{ tag_key: string; tag_value: string }[]> {
\ttry {
\t\treturn await timed_query("${table_name}", "get_${f.name}_options", async () => {
\t\t\tconst records = await db\`SELECT code as tag_key, name as tag_value FROM ${table} ORDER BY name ASC\`;
\t\t\treturn records as { tag_key: string; tag_value: string }[];
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching ${f.name} options:", error);
\t\treturn [];
\t}
}`;
	}).join("\n\n");

	const fk_select = await generate_foreign_key_select_functions(foreign_keys);
	const autocomplete_functions = await generate_autocomplete_functions(fields, foreign_keys);
	const combined_fk_functions = [fk_select, autocomplete_functions.search].filter(Boolean).join("\n\n");

	// Build search blocks: FULLTEXT MATCH/AGAINST for search_text, LIKE for other fields
	const is_search_text = search_field === "search_text";

	const search_block = is_search_text ? `if (search) {
\t\tconst search_term = search;
\t\twhere_clauses.push(get_fulltext_clause());
\t\tparams.push(get_fulltext_param(search_term));
\t}` : `if (search) {
\t\tconst search_term = '%' + search + '%';
\t\twhere_clauses.push('${search_field} LIKE ?');
\t\tparams.push(search_term);
\t}`;

	const search_count_block = is_search_text ? `if (search) {
\t\tconst count_params: any[] = [get_fulltext_param(search)];
\t\tconst count_query = \`SELECT COUNT(*) as count FROM \${from_source} WHERE \${get_fulltext_clause()}\`;
\t\tconst count_result = await db.unsafe(count_query, [...from_params, ...count_params]);
\t\ttotal = (count_result[0] as any)?.count || 0;
\t}` : `if (search) {
\t\tconst count_params: any[] = ['%' + search + '%'];
\t\tconst count_query = \`SELECT COUNT(*) as count FROM \${from_source} WHERE ${search_field} LIKE ?\`;
\t\tconst count_result = await db.unsafe(count_query, [...from_params, ...count_params]);
\t\ttotal = (count_result[0] as any)?.count || 0;
\t}`;

	// Compute cache dependencies
	const view_deps = await get_view_dependencies(table_name);
	const view_deps_json = JSON.stringify(view_deps);
	const effective_route_name = route_name || table_name;
	const route_path = route_prefix ? `/${route_prefix}/${effective_route_name}` : `/${effective_route_name}`;

	const { sql: sql_template_name } = select_templates({
		pagination_strategy,
		render_strategy: "load",
		is_nested,
		has_view: false,
	});
	const template_path = join(process.cwd(), "generator", "templates", sql_template_name);
	const template = await Bun.file(template_path).text();
	return apply_template(template, {
		"table.exact": table_name,
		"search.field": search_field,
		"search.block": search_block,
		"search.count_block": search_count_block,
		"interface.fields": interface_fields,
		"insert.fields": insert_fields,
		"insert.values": insert_values,
		"update.set": update_set,
		"table.option_text_field": option_text_field,
		"sql.tag_functions": tag_functions,
		"sql.fk_select_functions": combined_fk_functions,
		"sql.autocomplete_display_functions": autocomplete_functions.lookup,
		"sql.id_type": id_type,
		"sql.create_record_arg": create_record_arg,
		"sql.update_record_arg": update_record_arg,
		"sql.create_record_return": create_record_return,
		"sql.route_param_functions": route_param_lookup,
		"sql.view_dependencies": view_deps_json,
		"sql.route": route_path,
		"parent.fk_column": parent_info?.fk_column || "",
		"sql.locale_param": locale_param,
		"sql.locale_arg": locale_arg,
		"sql.cache_key_locale": cache_key_locale,
		"sql.localized_import": localized_import,
		"sql.localized_config": localized_config,
		"sql.locale_resolver": locale_resolver,
		"sql.from_source_setup": from_source_setup,
		"sql.read_source": read_source,
		"sql.cache_dependencies": cache_dependencies,
		"sql.write_locale_param": write_locale_param,
		"sql.create_fan_out": create_fan_out,
		"sql.update_fan_out": update_fan_out,
		"sql.delete_fan_out": delete_fan_out,
	});
}
