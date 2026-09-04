import { join } from "node:path";

import { ARCHIVE_TIMESTAMP_FIELD, ARCHIVE_USER_FIELD } from "$config/db_structure";

import { resolve_option_display_field } from "../schema/display_contract";
import { configured_form_fields } from "../validation_generator";
import { field_interface_prop, get_autocomplete_fk_tables, has_archive_column, log_step, unique_fk_tables, user_fields } from "./helpers";
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
		// The archive filter here depends on the *referenced* table, not the one
		// being generated. Skip it and archived rows keep appearing in every
		// dropdown that points at them.
		const fk_archive_where = display_source.has_archive ? ` WHERE ${ARCHIVE_TIMESTAMP_FIELD} IS NULL` : "";

		functions.push(`export async function get_${fk_table}_options_by_${fk_info.column}(): Promise<Options[]> {
\ttry {
\t\treturn await timed_query("${fk_table}", "get_${fk_table}_options_by_${fk_info.column}", async () => {
\t\t\tconst records = await db\`SELECT ${fk_info.column} as option_value, ${option_text_field} as option_text FROM ${fk_table}${fk_archive_where} ORDER BY ${option_text_field} ASC\`;
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
		// Same rule as the FK dropdowns: the referenced source decides.
		const ac_archive_and = display_source.has_archive ? ` AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL` : "";
		const search_lines = display_source.search_field === "search_text"
			? `const search_term = get_fulltext_param(query);
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, ${display_source.option_field} as option_text FROM ${display_source.source_name} WHERE \${get_fulltext_clause()}${ac_archive_and} ORDER BY ${display_source.option_field} ASC LIMIT 20\`;`
			: `const search_term = '%' + query + '%';
\t\t\tconst records = await db\`SELECT ${fk.column} as option_value, ${display_source.option_field} as option_text FROM ${display_source.source_name} WHERE ${display_source.search_field} LIKE \${search_term}${ac_archive_and} ORDER BY ${display_source.option_field} ASC LIMIT 20\`;`;
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
		// Deliberately NOT archive-filtered, unlike the search above: this
		// resolves a value the record already stores. If the referenced row was
		// archived after being picked, the edit form must still render what the
		// field points at rather than silently blanking it.
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
	readonly_fields?: ReadonlySet<string>;
	/** Per-column form settings from config.ts; absent form means included. */
	form_columns?: Record<string, { form?: boolean; }> | null;
}

/**
 * A locale table supplies translations, never record existence or shared
 * state. The base table remains the query source so lifecycle fields such as
 * archived_at have one authoritative value across every locale.
 */
export function localized_read_source(table_name: string, column_names: readonly string[], localized_column_names: readonly string[]): string {
	const selected_columns = column_names.map((column_name) => {
		const source = localized_column_names.includes(column_name) ? `COALESCE(localized.${column_name}, canonical.${column_name})` : `canonical.${column_name}`;
		return `${source} AS ${column_name}`;
	});
	const select_list = selected_columns.join(", ");

	return `\n/** Base records are authoritative; locale rows provide only translated columns. */\nfunction resolve_table(locale_code: string): string {\n\tconst localized_table = locale_table(TABLE_NAME, locale_code);\n\tif (localized_table === TABLE_NAME) return TABLE_NAME;\n\treturn \`(SELECT ${select_list} FROM ${table_name} AS canonical LEFT JOIN \${localized_table} AS localized ON localized.id = canonical.id) AS localized_records\`;\n}\n`;
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
		readonly_fields = new Set(),
		form_columns = null,
	} = options;

	const localized = localization_enabled;
	const locale_param = localized ? ", locale_code: string = \"\"" : "";
	const locale_arg = localized ? ", locale_code" : "";
	const cache_key_locale = localized ? ", locale_code" : "";
	const localized_column_names = localized_fields.map((field) => field.field_name);
	// Locale sidecars only own localized content. Every other column remains
	// base-owned and is never writable through a locale form.
	const locale_protected_columns = fields
		.filter((field) => !localized_column_names.includes(field.name))
		.map((field) => field.name);
	const localized_import = localized
		? `import { all_locale_tables, locale_table } from "$lib/locale_tables";\nimport { fan_out_create, fan_out_delete, fan_out_update, invalidate_all_locales } from "$lib/locale_write";\n`
		: "";
	// LOCALIZED_COLUMNS is read by the runtime locale-table guard and by the
	// write fan-out, which needs to know which columns must NOT be copied
	// across locales.
	const write_column_names = configured_form_fields(fields, form_columns).map((field) => field.name);
	const update_column_names = write_column_names.filter((field_name) => !readonly_fields.has(field_name));
	const update_columns_config = `\nexport const UPDATE_COLUMNS = ${JSON.stringify(update_column_names)} as const;`;
	const localized_config = localized
		? `\nexport const LOCALIZED_COLUMNS = ${JSON.stringify(localized_column_names)} as const;\nexport const WRITE_COLUMNS = ${JSON.stringify(write_column_names)} as const;${update_columns_config}\nconst FAN_OUT = { table_name: TABLE_NAME, localized_columns: LOCALIZED_COLUMNS as readonly string[], write_columns: WRITE_COLUMNS as readonly string[], update_columns: UPDATE_COLUMNS as readonly string[] };\n`
		: update_columns_config;
	const read_column_names = column_names.length > 0 ? column_names : ["id", ...fields.map((field) => field.name)];
	// The physical base table is always the read source. A locale table is joined
	// only to overlay explicitly localized values, never to decide which records
	// exist or which lifecycle state they have.
	const locale_resolver = localized
		? localized_read_source(table_name, read_column_names, localized_column_names)
		: "";
	const from_source_setup = localized
		? `const from_source = resolve_table(locale_code);\n\t\t\t\t\tconst from_params: string[] = [];`
		: `const from_source = TABLE_NAME;\n\t\t\t\t\tconst from_params: string[] = [];`;
	// Single-record reads use the same base-plus-translation source as list
	// reads, so locale data can change text without changing record visibility.
	const read_source = localized ? "resolve_table(locale_code)" : "TABLE_NAME";
	// A localized search depends on every locale table, since a write fans out
	// to all of them (D6a). Non-localized tables keep the introspected list.
	const cache_dependencies = localized ? "all_locale_tables(TABLE_NAME)" : "VIEW_DEPENDENCIES";
	const write_locale_param = localized ? ", locale_code: string = \"\"" : "";
	const filtered = user_fields(fields);
	const editable = configured_form_fields(fields, form_columns);
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
	const update_set = editable.filter((f) => f.name !== "id" && !readonly_fields.has(f.name))
		.map((f) => `${f.name} = \${record.${f.name}}`)
		.join(", ");

	// Archive (soft delete) support is decided by the schema, not by config: a
	// table carrying `archived_at` gets the filters and the archive/restore
	// writes, and one that does not generates byte-identical output to before
	// this feature existed. That keeps adoption per-table and reviewable.
	const has_archive = has_archive_column(column_names);
	// The "remove record" function is archive_record for a table carrying
	// archived_at (soft delete) and delete_record otherwise (hard DELETE).
	const archive_record_fn = has_archive ? "archive_record" : "delete_record";
	const archive_record_by_parent_id_fn = has_archive ? "archive_record_by_parent_id" : "delete_record_by_parent_id";
	const archive_record_by_route_param_fn = has_archive ? "archive_record_by_route_param" : "delete_record_by_route_param";
	// The catch-block log message follows the same split.
	const archive_error_log = has_archive ? "Error archiving record:" : "Error deleting record:";
	const archive_helper = has_archive ? `
export type ArchiveFilter = "live" | "archived" | "all";

/** WHERE fragment selecting archive state. Empty string means no restriction. */
function archive_clause(archive_filter: ArchiveFilter): string {
\tif (archive_filter === "all") return "";
\tif (archive_filter === "archived") return "${ARCHIVE_TIMESTAMP_FIELD} IS NOT NULL";
\treturn "${ARCHIVE_TIMESTAMP_FIELD} IS NULL";
}
` : "";
	const archive_where = has_archive ? ` WHERE ${ARCHIVE_TIMESTAMP_FIELD} IS NULL` : "";
	const archive_param = has_archive ? ", archive_filter: ArchiveFilter = \"live\"" : "";
	const archive_arg = has_archive ? ", archive_filter" : "";
	const archive_cache_key = has_archive ? ", archive_filter" : "";
	const archive_push = has_archive ? `const archive_where = archive_clause(archive_filter);
\t\t\t\t\tif (archive_where) {
\t\t\t\t\t\twhere_clauses.push(archive_where);
\t\t\t\t\t}
` : "";
	const archive_count_push = has_archive ? `const count_archive_where = archive_clause(archive_filter);
\t\t\t\t\t\tif (count_archive_where) {
\t\t\t\t\t\t\tcount_where_clauses.push(count_archive_where);
\t\t\t\t\t\t}
` : "";
	// The offset template's searching branch builds a separate `search_where`
	// array that feeds both its data and count query, so it needs its own push.
	const archive_search_push = has_archive ? `const search_archive_clause = archive_clause(archive_filter);
\t\t\t\t\t\tif (search_archive_clause) {
\t\t\t\t\t\t\tsearch_where.push(search_archive_clause);
\t\t\t\t\t\t}
` : "";
	// Nested children keep `where_parts`, a single array feeding both the
	// searching and non-searching branch, so one push covers both.
	const archive_and = has_archive ? ` AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL` : "";
	const archive_parts_push = has_archive ? `const archive_where = archive_clause(archive_filter);
\t\t\t\t\tif (archive_where) {
\t\t\t\t\t\twhere_parts.push(archive_where);
\t\t\t\t\t}` : "";
	const nested_delete_write = has_archive
		? `const result = await db\`UPDATE ${table_name} SET ${ARCHIVE_TIMESTAMP_FIELD} = CURRENT_TIMESTAMP, ${ARCHIVE_USER_FIELD} = \${${ARCHIVE_USER_FIELD}} WHERE id = \${id} AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL\`;`
		: localized
			? `const result: any = { affectedRows: await fan_out_delete(TABLE_NAME, id) };\n\t\t\tawait invalidate_all_locales(TABLE_NAME);`
			: `const result = await db\`DELETE FROM ${table_name} WHERE id = \${id}\`;`;
	const nested_delete_parent_write = has_archive
		? `const result = await db\`UPDATE ${table_name} SET ${ARCHIVE_TIMESTAMP_FIELD} = CURRENT_TIMESTAMP, ${ARCHIVE_USER_FIELD} = \${${ARCHIVE_USER_FIELD}} WHERE id = \${id} AND ${parent_info?.fk_column || "parent_id"} = \${parent_id} AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL\`;`
		: localized
			? `const matches = await db\`SELECT id FROM ${table_name} WHERE id = \${id} AND ${parent_info?.fk_column || "parent_id"} = \${parent_id} LIMIT 1\`;\n\t\t\tconst result: any = { affectedRows: matches.length > 0 ? await fan_out_delete(TABLE_NAME, id) : 0 };\n\t\t\tawait invalidate_all_locales(TABLE_NAME);`
			: `const result = await db\`DELETE FROM ${table_name} WHERE id = \${id} AND ${parent_info?.fk_column || "parent_id"} = \${parent_id}\`;`;
	const include_archived_param = has_archive ? ", include_archived: boolean = false" : "";
	const include_archived_setup = has_archive
		? `const archive_where = include_archived ? "" : " AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL";`
		: "";
	const include_archived_sql = has_archive ? "${archive_where}" : "";
	// The archiving user is a required parameter but a nullable value: every
	// caller must decide explicitly, and NULL honestly records "no authenticated
	// user" rather than inventing a user id 0 that resolves to nobody.
	const archive_by_param = has_archive ? `, ${ARCHIVE_USER_FIELD}: number | null` : "";
	// Index-page count breakdown: total / live / archived for the whole table.
	// Deliberately NOT driven by search or filter_clauses - a narrowed result
	// count is what the pagination already reports, and a headline figure that
	// moves as you type is not a total. `scope_clause` is respected because it
	// is an admin-imposed restriction defining what this user may see at all,
	// not a narrowing the user chose.
	const archive_counts_function = has_archive ? `
export interface ArchiveCounts {
\ttotal: number;
\tlive: number;
\tarchived: number;
}

export async function get_archive_counts(scope_clause: string = ""): Promise<ArchiveCounts> {
\ttry {
\t\treturn await timed_query("${table_name}", "get_archive_counts", async () => {
\t\t\tconst where = scope_clause ? \` WHERE (\${scope_clause})\` : "";
\t\t\tconst counts_query = \`SELECT COUNT(*) as total, SUM(CASE WHEN ${ARCHIVE_TIMESTAMP_FIELD} IS NULL THEN 1 ELSE 0 END) as live, SUM(CASE WHEN ${ARCHIVE_TIMESTAMP_FIELD} IS NOT NULL THEN 1 ELSE 0 END) as archived FROM ${table_name}\${where}\`;
\t\t\tconst counts_result = await db.unsafe(counts_query, []);
\t\t\tconst row = counts_result[0] as any;
\t\t\treturn { total: Number(row?.total ?? 0), live: Number(row?.live ?? 0), archived: Number(row?.archived ?? 0) };
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching archive counts:", error);
\t\treturn { total: 0, live: 0, archived: 0 };
\t}
}
` : "";
	const restore_function = has_archive ? `
${archive_counts_function}
export async function restore_record(id: ${id_type}): Promise<boolean> {
\ttry {
\t\treturn await timed_query("${table_name}", "restore_record", async () => {
\t\t\tconst result = await db\`UPDATE ${table_name} SET ${ARCHIVE_TIMESTAMP_FIELD} = NULL, ${ARCHIVE_USER_FIELD} = NULL WHERE id = \${id} AND ${ARCHIVE_TIMESTAMP_FIELD} IS NOT NULL\`;
\t\t\treturn (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
\t\t});
\t} catch (error) {
\t\tconsole.error("Error restoring record:", error);
\t\treturn false;
\t}
}
` : "";

	// Write bodies. A localized table fans out across every locale table and
	// owns its own cache invalidation (D6a) - the route handler no longer
	// touches the cache at all. A non-localized table keeps today's single
	// statement, so its generated output is unchanged.
	const create_fan_out = localized
		? `await fan_out_create(FAN_OUT, insert_result.lastInsertRowid as number, record as unknown as { [key: string]: unknown });\n\t\t\tawait invalidate_all_locales(TABLE_NAME);`
		: "";
	const update_fan_out = localized
		? `await fan_out_update(FAN_OUT, id, record as unknown as { [key: string]: unknown }, locale_code);\n\t\t\tawait invalidate_all_locales(TABLE_NAME);`
		: `const changed_entries = Object.entries(record).filter(([field_name]) => UPDATE_COLUMNS.includes(field_name as typeof UPDATE_COLUMNS[number]));\n\t\t\tif (changed_entries.length > 0) {\n\t\t\t\tconst assignments = changed_entries.map(([field_name]) => \`\${field_name} = ?\`).join(", ");\n\t\t\t\tconst params = changed_entries.map(([, value]) => value);\n\t\t\t\tawait db.unsafe(\`UPDATE ${table_name} SET \${assignments} WHERE id = ?\`, [...params, id]);\n\t\t\t}`;
	// Archiving is an UPDATE, never a DELETE. The `AND archived_at IS NULL`
	// guard makes re-archiving a no-op instead of overwriting the original
	// audit values with a second, later archiver.
	const archive_write = `const result = await db\`UPDATE ${table_name} SET ${ARCHIVE_TIMESTAMP_FIELD} = CURRENT_TIMESTAMP, ${ARCHIVE_USER_FIELD} = \${${ARCHIVE_USER_FIELD}} WHERE id = \${id} AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL\`;\n\t\t\treturn (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;`;
	const hard_delete_write = `const result = await db\`DELETE FROM ${table_name} WHERE id = \${id}\`;\n\t\t\treturn (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;`;
	// A localized table archives its base row only - `archived_at` never exists
	// on the `<table>_<locale>` overlays, where a missing row means "no
	// translation", not "deleted". So the locale fan-out is skipped entirely
	// when archiving; only the cache still has to be invalidated.
	const delete_fan_out = has_archive
		? (localized ? `${archive_write.replace("return (result", "await invalidate_all_locales(TABLE_NAME);\n\t\t\treturn (result")}` : archive_write)
		: localized
			? `const affected = await fan_out_delete(TABLE_NAME, id);\n\t\t\tawait invalidate_all_locales(TABLE_NAME);\n\t\t\treturn affected > 0;`
			: hard_delete_write;

	// Generate route_param lookup and delete functions
	// Nested tables always look up via get_record_by_id_and_parent, keyed on the
	// real "id" column - never on route_param_value (which is only a URL segment
	// name for nested tables, not a SQL column).
	const _has_route_param = !is_nested && route_param_value !== "id";
	// The route-param lookup takes the same include_archived escape hatch as
	// get_record_by_id: without it the edit page cannot open an archived record,
	// so its restore button would be unreachable.
	const route_param_read = has_archive
		? `const records = include_archived
\t\t\t\t? await db\`SELECT * FROM ${table_name} WHERE ${route_param_value} = \${value} LIMIT 1\`
\t\t\t\t: await db\`SELECT * FROM ${table_name} WHERE ${route_param_value} = \${value} AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL LIMIT 1\`;`
		: `const records = await db\`SELECT * FROM ${table_name} WHERE ${route_param_value} = \${value} LIMIT 1\`;`;
	const route_param_lookup = _has_route_param ? `export async function get_record_by_route_param(value: string${include_archived_param}): Promise<Record | undefined> {
\ttry {
\t\treturn await timed_query("${table_name}", "get_record_by_route_param", async () => {
\t\t\t${route_param_read}
\t\t\treturn records[0] as Record | undefined;
\t\t});
\t} catch (error) {
\t\tconsole.error("Error fetching record by route param:", error);
\t\treturn undefined;
\t}
}

export async function ${archive_record_by_route_param_fn}(value: string${archive_by_param}): Promise<boolean> {
\ttry {
\t\treturn await timed_query("${table_name}", "${archive_record_by_route_param_fn}", async () => {
\t\t\t${has_archive
			? `const result = await db\`UPDATE ${table_name} SET ${ARCHIVE_TIMESTAMP_FIELD} = CURRENT_TIMESTAMP, ${ARCHIVE_USER_FIELD} = \${${ARCHIVE_USER_FIELD}} WHERE ${route_param_value} = \${value} AND ${ARCHIVE_TIMESTAMP_FIELD} IS NULL\`;`
			: `const result = await db\`DELETE FROM ${table_name} WHERE ${route_param_value} = \${value}\`;`}
\t\t\treturn (result.affectedRows ?? result.count ?? result.changes ?? 0) > 0;
\t\t});
\t} catch (error) {
\t\tconsole.error("${archive_error_log}", error);
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
	const update_record_arg = `Partial<Omit<Record, ${update_omit_union}>>`;
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

	// The searching count query builds its own WHERE rather than reusing
	// count_where_clauses, so it needs the archive filter appended explicitly -
	// miss this and a search reports a total that includes archived rows while
	// the grid below it shows only live ones.
	const count_archive_setup = has_archive
		? `\t\tconst search_archive_where = archive_clause(archive_filter);\n\t\tconst search_archive_and = search_archive_where ? \` AND \${search_archive_where}\` : "";\n`
		: "";
	const count_archive_and = has_archive ? "${search_archive_and}" : "";
	const search_count_block = is_search_text ? `if (search) {
\t\tconst count_params: any[] = [get_fulltext_param(search)];
${count_archive_setup}\t\tconst count_query = \`SELECT COUNT(*) as count FROM \${from_source} WHERE \${get_fulltext_clause()}${count_archive_and}\`;
\t\tconst count_result = await db.unsafe(count_query, [...from_params, ...count_params]);
\t\ttotal = (count_result[0] as any)?.count || 0;
\t}` : `if (search) {
\t\tconst count_params: any[] = ['%' + search + '%'];
${count_archive_setup}\t\tconst count_query = \`SELECT COUNT(*) as count FROM \${from_source} WHERE ${search_field} LIKE ?${count_archive_and}\`;
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
		"sql.archive_helper": archive_helper,
		"sql.archive_where": archive_where,
		"sql.archive_param": archive_param,
		"sql.archive_arg": archive_arg,
		"sql.archive_cache_key": archive_cache_key,
		"sql.archive_push": archive_push,
		"sql.archive_count_push": archive_count_push,
		"sql.archive_search_push": archive_search_push,
		"sql.archive_and": archive_and,
		"sql.archive_parts_push": archive_parts_push,
		"sql.nested_delete_write": nested_delete_write,
		"sql.nested_delete_parent_write": nested_delete_parent_write,
		"sql.archive_by_param": archive_by_param,
		"sql.include_archived_param": include_archived_param,
		"sql.include_archived_setup": include_archived_setup,
		"sql.include_archived_sql": include_archived_sql,
		"sql.restore_function": restore_function,
		"sql.write_locale_param": write_locale_param,
		"sql.create_fan_out": create_fan_out,
		"sql.update_fan_out": update_fan_out,
		"sql.delete_fan_out": delete_fan_out,
		"sql.archive_record_fn": archive_record_fn,
		"sql.archive_record_by_parent_id_fn": archive_record_by_parent_id_fn,
		"sql.archive_error_log": archive_error_log,
	});
}
