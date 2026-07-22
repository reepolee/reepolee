import { join } from "node:path";

import { entry_fields } from "../validation_generator";
import { get_autocomplete_fk_tables, log_step, unique_fk_tables, user_fields } from "./helpers";
import { check_view_exists, get_text_field_from_db, get_view_dependencies } from "./sql_introspector";
import { select_templates } from "./template_selector";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ForeignKeyMap, ParentInfo } from "./types";

// ---------------------------------------------------------------------------
// Helper: Get first non-integer field for SQL text selection
// ---------------------------------------------------------------------------

export function get_first_non_integer_field_from_fields(fields: FieldDef[]): string | null {
	for (const field of fields) {
		if (field.type !== "number" && field.name !== "id") { return field.name; }
	}
	return null;
}

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
		const fk_info = fk_tables[i];
		const fk_table = fk_info.table;
		log_step(`generate_foreign_key_select_functions: querying title field for FK table ${i + 1}/${fk_tables.length}: ${fk_table}`);
		const option_text_field = await get_text_field_from_db(fk_table);
		log_step(`generate_foreign_key_select_functions: text field for ${fk_table} = "${option_text_field}"`);

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

async function generate_autocomplete_search_functions(fields: FieldDef[], foreign_keys: ForeignKeyMap): Promise<string> {
	const autocomplete_fks = get_autocomplete_fk_tables(fields, foreign_keys);
	if (autocomplete_fks.length === 0) return "";

	const functions: string[] = [];

	for (const fk of autocomplete_fks) {
		const has_view = await check_view_exists(fk.table);

		if (has_view) {
			// Table has a view - use dialect-aware fulltext search on search_text
			functions.push(`export async function search_${fk.table}_options(query: string): Promise<Options[]> {
\ttry {
\t\treturn await timed_query("${fk.table}", "search_${fk.table}_options", async () => {
\t\t\tconst search_term = get_fulltext_param(query);
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, name as option_text FROM v_${fk.table} WHERE \${get_fulltext_clause()} ORDER BY name ASC LIMIT 20\`;
\t\t\treturn records as Options[];
\t\t});
\t} catch (error) {
\t\tconsole.error("Error searching ${fk.table} options:", error);
\t\treturn [];
\t}
}`);
		} else {
			const text_field = await get_text_field_from_db(fk.table);
			functions.push(`export async function search_${fk.table}_options(query: string): Promise<Options[]> {
\ttry {
\t\treturn await timed_query("${fk.table}", "search_${fk.table}_options", async () => {
\t\t\tconst search_term = '%' + query + '%';
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, ${text_field} as option_text FROM ${fk.table} WHERE ${text_field} LIKE \${search_term} ORDER BY ${text_field} ASC LIMIT 20\`;
\t\t\treturn records as Options[];
\t\t});
\t} catch (error) {
\t\tconsole.error("Error searching ${fk.table} options:", error);
\t\treturn [];
\t}
}`);
		}
	}

	return functions.join("\n\n");
}

async function generate_autocomplete_lookup_functions(fields: FieldDef[], foreign_keys: ForeignKeyMap): Promise<string> {
	const autocomplete_fks = get_autocomplete_fk_tables(fields, foreign_keys);
	if (autocomplete_fks.length === 0) return "";

	const functions: string[] = [];

	for (const fk of autocomplete_fks) {
		const has_view = await check_view_exists(fk.table);

		if (has_view) {
			// Table has a view - use search_text for WHERE, name for display
			functions.push(`export async function get_${fk.table}_option_by_${fk.column}(value: string): Promise<{ option_value: string; option_text: string } | null> {
\ttry {
\t\treturn await timed_query("${fk.table}", "get_${fk.table}_option_by_${fk.column}", async () => {
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, name as option_text FROM v_${fk.table} WHERE ${fk.column} = \${value} LIMIT 1\`;
\t\t\treturn records[0] || null;
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching ${fk.table} option by value:", error);
\t\treturn null;
\t}
}`);
		} else {
			const text_field = await get_text_field_from_db(fk.table);
			functions.push(`export async function get_${fk.table}_option_by_${fk.column}(value: string): Promise<{ option_value: string; option_text: string } | null> {
\ttry {
\t\treturn await timed_query("${fk.table}", "get_${fk.table}_option_by_${fk.column}", async () => {
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, ${text_field} as option_text FROM ${fk.table} WHERE ${fk.column} = \${value} LIMIT 1\`;
\t\t\treturn records[0] || null;
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching ${fk.table} option by value:", error);
\t\treturn null;
\t}
}`);
		}
	}

	return functions.join("\n\n");
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
	} = options;
	const filtered = user_fields(fields);
	const editable = entry_fields(fields, false);
	const first_text_field = get_first_non_integer_field_from_fields(fields);

	// For non-auto-increment PKs, id is in the fields, so don't duplicate it
	const has_id_in_fields = fields.some((f) => f.name === "id");
	const interface_fields = has_id_in_fields ? filtered.filter((f) => f.name !== "id")
		.map((f) => `\t${f.name}: ${f.type === "number" ? "number" : "string"};`)
		.join("\n") : [
			"\tid: number;",
			...filtered.map((f) => `\t${f.name}: ${f.type === "number" ? "number" : "string"};`),
		].join("\n");
	// For non-auto-increment PKs, include id in insert fields since user provides it
	const insert_fields = editable.map((f) => f.name).join(", ");
	const insert_values = editable.map((f) => `\${record.${f.name}}`).join(", ");
	const update_set = editable.filter((f) => f.name !== "id")
		.map((f) => `${f.name} = \${record.${f.name}}`)
		.join(", ");

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
\t\t\treturn (result.affectedRows ?? result.changes ?? 0) > 0;
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

	const create_record_arg = is_auto_increment_pk ? "Omit<Record, \"id\">" : "Record";
	const update_record_arg = "Omit<Record, \"id\">";
	const create_record_return = is_auto_increment_pk ? `const get_result = await db\`SELECT * FROM ${table_name} WHERE id = \${insert_result.lastInsertRowid} LIMIT 1\`;
\t\treturn get_result[0] as Record;` : `const get_result = await db\`SELECT * FROM ${table_name} WHERE id = \${record.id} LIMIT 1\`;
\t\treturn get_result[0] as Record;`;

	// Generate tag option functions
	const tag_functions = tags_fields.map((f) => {
		const table = f.attributes.tags.table;
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
	const autocomplete_search = await generate_autocomplete_search_functions(fields, foreign_keys);
	const combined_fk_functions = [fk_select, autocomplete_search].filter(Boolean).join("\n\n");

	const autocomplete_lookup_functions = await generate_autocomplete_lookup_functions(fields, foreign_keys);

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
\t\tconst count_query = \`SELECT COUNT(*) as count FROM ${table_name} WHERE \${get_fulltext_clause()}\`;
\t\tconst count_result = await db.unsafe(count_query, count_params);
\t\ttotal = (count_result[0] as any)?.count || 0;
\t}` : `if (search) {
\t\tconst count_params: any[] = ['%' + search + '%'];
\t\tconst count_query = \`SELECT COUNT(*) as count FROM ${table_name} WHERE ${search_field} LIKE ?\`;
\t\tconst count_result = await db.unsafe(count_query, count_params);
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
		"table.option_text_field": first_text_field || search_field,
		"sql.tag_functions": tag_functions,
		"sql.fk_select_functions": combined_fk_functions,
		"sql.autocomplete_display_functions": autocomplete_lookup_functions,
		"sql.id_type": id_type,
		"sql.create_record_arg": create_record_arg,
		"sql.update_record_arg": update_record_arg,
		"sql.create_record_return": create_record_return,
		"sql.route_param_functions": route_param_lookup,
		"sql.view_dependencies": view_deps_json,
		"sql.route": route_path,
		"parent.fk_column": parent_info?.fk_column || "",
	});
}
