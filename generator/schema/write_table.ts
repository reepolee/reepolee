import {
	BOOLEAN_PREFIXES,
	COL_WIDTH_AUTO,
	COL_WIDTH_INTEGER,
	CURRENCY_FIELD,
	IGNORE_INDEX_FIELDS,
	LOCALIZABLE_STRING_TYPES,
	LOCALIZATION_SYSTEM_FIELDS,
	PERCENT_FIELD,
} from "$config/db_structure";

import { canonical_sql_for_domain, generate_fields_object } from "./field_generator";
import type { TypeMapper } from "./type_mapper";
import type { FormFieldDef, SchemaObject } from "./types";

export async function write_table_generated_file(
	dir: string,
	schema_obj: SchemaObject,
	type_mapper: TypeMapper,
	all_tables_columns?: Map<string, string[]>,
	all_tables_indexes?: Map<string, Set<string>>,
): Promise<void> {
	const fields = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);

	const type_entries = schema_obj.columns.map((col) => {
		const base_type = type_mapper.to_typescript(col.type_string);
		return `  ${col.name}?: ${base_type}${!col.is_nullable ? "" : " | null | undefined"};`;
	});

	const field_interface = `Record<string, FormFieldDef>`;

	const v_fields = schema_obj.view_columns ? generate_fields_object({
		type: "view",
		name: schema_obj.name,
		columns: schema_obj.view_columns,
		foreign_keys: [],
		has_view: false,
	}, type_mapper, all_tables_columns, all_tables_indexes) : null;

	// Build indexed columns list (in original casing by matching against schema columns)
	const table_indexes = all_tables_indexes?.get(schema_obj.name);
	const indexed_columns: string[] = [];
	if (table_indexes) {
		for (const col of schema_obj.columns) {
			if (table_indexes.has(col.name.toLowerCase())) { indexed_columns.push(col.name); }
		}
	}

	const v_fields_export = v_fields === null ? `\n\nexport const v_fields: Record<string, FormFieldDef> | null = null;` : `\n\nexport const v_fields: Record<string, FormFieldDef> = ${JSON.stringify(
		v_fields,
		null,
		2
	)};`;

	const parent_export = schema_obj.parent ? `\n\nexport const parent = ${JSON.stringify(schema_obj.parent, null, 2)};` : "";

	const content = `// This file is auto-generated. Do not modify manually.
import { type FormFieldDef } from "$generator/schema/types";

export type ${schema_obj.name}_type = {
${type_entries.join("\n")}
};

export const fields: Record<string, FormFieldDef> = ${JSON.stringify(fields, null, 2)};
export const indexed_columns: string[] = ${JSON.stringify(indexed_columns)};
${v_fields_export}${parent_export}
`;

	await Bun.write(`${dir}/schema/table.generated.ts`, content);
}

/**
 * How many "usable" columns an index grid shows when no explicit selection is
 * made. Only a fallback now - reeman's interactive flow asks which columns to
 * display and passes them through, which lifts the limit entirely.
 */
const DEFAULT_GRID_COLUMN_CAP = 5;

/**
 * The per-column data the `columns` map is built from, in emission order.
 * Shared by the first-time scaffold and the merge path so both agree on which
 * columns exist, what width/class they get, and whether they are commented out.
 */
interface ColumnLine {
	name: string;
	line: string;
	commented: boolean;
}

/**
 * The field partition an index grid is built from. Split out of build_column_lines()
 * so the interactive column picker can offer exactly the columns the writer will
 * later decide about - one definition, no drift between prompt and output.
 */
interface GridFieldSets {
	source_fields: FormFieldDef[];
	source_commented: FormFieldDef[];
	base_table_field_names: Set<string>;
	has_display_field_for_fk: (f: FormFieldDef) => boolean;
}

function build_grid_field_sets(
	schema_obj: SchemaObject,
	type_mapper: TypeMapper,
	all_tables_columns: Map<string, string[]> | undefined,
	all_tables_indexes: Map<string, Set<string>> | undefined,
): GridFieldSets {
	const fields_obj = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);

	// A locale clone mirrors the base table, so only fields that actually exist on
	// the base table (not view-only joins like FK "_display" columns) are
	// eligible - schema_reader.ts's read_localization() enforces this at CRUD-generation
	// time and throws if a view-only field slips through.
	const base_table_field_names = new Set(Object.values(fields_obj).map((f) => f.name));

	// Split fields into active (shown in index) and commented (CU - hidden, but easy to enable)
	function is_index_field(f: FormFieldDef): boolean { return f.attributes?.omit !== true && !(IGNORE_INDEX_FIELDS as readonly string[]).includes(f.name); }

	const active_fields = Object.values(fields_obj).filter((f) => is_index_field(f) && f.attributes?.omit_index !== true);
	const commented_fields = Object.values(fields_obj).filter((f) => is_index_field(f) && f.attributes?.omit_index === true);

	let v_active_fields: FormFieldDef[] = [];
	let v_commented_fields: FormFieldDef[] = [];

	if (schema_obj.view_columns) {
		const v_fields_obj = generate_fields_object({
			type: "view",
			name: schema_obj.name,
			columns: schema_obj.view_columns,
			foreign_keys: [],
			has_view: false,
		}, type_mapper, all_tables_columns, all_tables_indexes);
		const all_v = Object.values(v_fields_obj);
		v_active_fields = all_v.filter((f) => is_index_field(f) && f.attributes?.omit_index !== true);
		v_commented_fields = all_v.filter((f) => is_index_field(f) && f.attributes?.omit_index === true);
	}

	// Check if an FK _id field has its canonical <stem>_display field.
	function has_display_field_for_fk(f: FormFieldDef): boolean {
		if (!f.name.endsWith("_id") || !f.attributes?.foreign_key) return false;
		const stem = f.name.slice(0, -3);
		const available_fields = [...active_fields, ...v_active_fields];
		return available_fields.some((ff) => ff.name === `${stem}_display`);
	}

	// Use the larger set of active field names so we have enough columns for both views
	const source_fields = v_active_fields.length >= active_fields.length ? v_active_fields : active_fields;
	const source_commented = v_commented_fields.length >= commented_fields.length ? v_commented_fields : commented_fields;

	return { source_fields, source_commented, base_table_field_names, has_display_field_for_fk };
}

/**
 * One selectable index-grid column, as offered by the interactive picker.
 * `default_selected` mirrors what the no-selection default cap would have chosen,
 * so the picker can pre-check the same columns the generator would pick on its own.
 */
export interface GridColumnChoice {
	name: string;
	default_selected: boolean;
}

/**
 * List the columns eligible for an index grid, in emission order. Drives reeman's
 * "which columns to display" prompt; the returned names are what write_table_file()
 * accepts back as `grid_columns`.
 */
export function list_grid_column_choices(
	schema_obj: SchemaObject,
	type_mapper: TypeMapper,
	all_tables_columns?: Map<string, string[]>,
	all_tables_indexes?: Map<string, Set<string>>,
): GridColumnChoice[] {
	const sets = build_grid_field_sets(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);

	// Same eligibility rule the writer applies: checkbox/id are always present, and
	// an FK _id with a display sibling is hidden regardless of what the user picks.
	const eligible = sets.source_fields.filter((f) => f.name !== "id" && f.name !== "checkbox" && !sets.has_display_field_for_fk(f));

	const media_last = [...eligible].sort((a, b) => {
		const a_media = /_image$|_file$/.test(a.name) ? 1 : 0;
		const b_media = /_image$|_file$/.test(b.name) ? 1 : 0;
		return a_media - b_media;
	});
	const default_names = new Set(media_last.slice(0, DEFAULT_GRID_COLUMN_CAP).map((f) => f.name));

	return eligible.map((f) => ({ name: f.name, default_selected: default_names.has(f.name) }));
}

/**
 * Compute every `columns` entry for a table, exactly as the initial scaffold
 * would emit it. `localize_content` is threaded in because the localized flag
 * depends on env + pk shape, which the caller has already resolved.
 */
function build_column_lines(
	schema_obj: SchemaObject,
	type_mapper: TypeMapper,
	all_tables_columns: Map<string, string[]> | undefined,
	all_tables_indexes: Map<string, Set<string>> | undefined,
	localize_content: boolean,
	grid_columns?: string[],
): ColumnLine[] {
	const { source_fields, source_commented, base_table_field_names, has_display_field_for_fk } = build_grid_field_sets(
		schema_obj,
		type_mapper,
		all_tables_columns,
		all_tables_indexes
	);

	function is_localizable_string(f: FormFieldDef): boolean {
		return (
			(LOCALIZABLE_STRING_TYPES as readonly string[]).includes(f.type) &&
			!(LOCALIZATION_SYSTEM_FIELDS as readonly string[]).includes(f.name) &&
			base_table_field_names.has(f.name)
		);
	}

	// Column class based on field type - matches compute_initial_class logic.
	function column_class(f: FormFieldDef): string {
		if (f.attributes?.initial_class) return f.attributes.initial_class;
		const ctype = f.attributes?.column_type?.toLowerCase() || "";
		const cname = f.name || "";
		if (ctype === CURRENCY_FIELD.toLowerCase() || ctype === PERCENT_FIELD.toLowerCase()) return "text-right";
		if (BOOLEAN_PREFIXES.some((p) => cname.startsWith(p))) return "text-center";
		return "";
	}

	// Build a concise mismatch comment naming the actual vs. canonical SQL type.
	function domain_mismatch_comment(f: FormFieldDef, domain: string | undefined, compliant: boolean | undefined): string {
		if (!domain || compliant) return "";
		const actual = f.attributes?.column_type || "unknown";
		const canonical = canonical_sql_for_domain(domain) || "unknown";
		return ` // ⚠ ${domain} expects ${canonical}, got ${actual}`;
	}

	// Index grids shouldn't default to very long text columns - anything wider than
	// 20ch collapses to "auto" instead.
	function capped_width(width: string): string {
		const ch_match = width.match(/^(\d+)ch$/);
		if (ch_match && Number(ch_match[1]) > 20) return COL_WIDTH_AUTO;
		return width;
	}

	// Which columns the index grid shows. checkbox/id are excluded from the decision
	// (almost always present), and fields already hidden for another reason (FK _id
	// with a display sibling) don't count either since they're not contributing
	// visible width.
	const eligible_for_cap = source_fields.filter((f) => f.name !== "id" && f.name !== "checkbox" && !has_display_field_for_fk(f));

	// An explicit selection is the source of truth - everything outside it gets
	// grid: false, with no count limit. Selecting every eligible column is how
	// "show all" is expressed, so nothing is hidden at all.
	let hidden_by_cap: Set<string>;
	if (grid_columns) {
		const selected = new Set(grid_columns);
		const unselected = eligible_for_cap.filter((f) => !selected.has(f.name));
		hidden_by_cap = new Set(unselected.map((f) => f.name));
	} else {
		// No selection given (CLI runs, bulk, refresh) - fall back to the default cap of
		// 5 usable columns. Beyond the cap, prefer hiding _image/_file fields first
		// (least useful in a dense grid), then fall back to declaration order.
		const image_or_file_last = [...eligible_for_cap].sort((a, b) => {
			const a_media = /_image$|_file$/.test(a.name) ? 1 : 0;
			const b_media = /_image$|_file$/.test(b.name) ? 1 : 0;
			return a_media - b_media;
		});
		hidden_by_cap = new Set(image_or_file_last.slice(DEFAULT_GRID_COLUMN_CAP).map((f) => f.name));
	}

	function format_line(f: FormFieldDef, commented: boolean): string {
		const width = capped_width(f.attributes?.initial_width || COL_WIDTH_AUTO);
		const cls = column_class(f);
		const domain = f.attributes?.domain_type;
		const compliant = f.attributes?.domain_compliant;
		const domain_prop = domain ? `, domain: "${domain}"` : "";

		// Auto-detect FK _id fields with a corresponding display field in the view.
		// Hide them from the grid (grid: false) but keep them filterable (filter: true).
		const is_auto_hidden_fk = has_display_field_for_fk(f);
		const filter_val = is_auto_hidden_fk || f.attributes?.filter;
		const filter_prop = filter_val ? ", filter: true" : "";
		// Commented (CU) entries never carry the cap-based hide - they are already hidden.
		const grid_prop = is_auto_hidden_fk || (!commented && hidden_by_cap.has(f.name)) ? ", grid: false" : "";
		const localized_prop = localize_content && is_localizable_string(f) ? ", localized: true" : "";

		const mismatch_comment = domain_mismatch_comment(f, domain, compliant);
		const prefix = commented ? "  // " : "  ";
		return `${prefix}"${f.name}": { width: "${width}", class: "${cls}"${domain_prop}${filter_prop}${grid_prop}${localized_prop} },${mismatch_comment}`;
	}

	const lines: ColumnLine[] = [];
	for (const f of source_fields) {
		if (f.name === "id" || f.name === "checkbox") continue;
		lines.push({ name: f.name, line: format_line(f, false), commented: false });
	}
	// CU fields commented out for easy re-enabling
	for (const f of source_commented) {
		if (f.name === "id" || f.name === "checkbox") continue;
		lines.push({ name: f.name, line: format_line(f, true), commented: true });
	}
	return lines;
}

export interface WriteTableConfig {
	dir: string;
	schema_obj: SchemaObject;
	type_mapper: TypeMapper;
	all_tables_columns?: Map<string, string[]>;
	all_tables_indexes?: Map<string, Set<string>>;
	all_schemas?: SchemaObject[];
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	template_tags?: "flat" | "tags";
	/**
	 * Explicit index-grid column selection. Columns outside this list are written
	 * with `grid: false`. Omit to apply the default cap of DEFAULT_GRID_COLUMN_CAP.
	 */
	grid_columns?: string[];
}

export async function write_table_file(config: WriteTableConfig): Promise<void> {
	const { dir, schema_obj, type_mapper, all_tables_columns, all_tables_indexes, all_schemas, pagination_strategy = "offset", render_strategy = "load", template_tags = "flat", grid_columns } = config;
	const table_ts_path = `${dir}/schema/table.ts`;
	const exists = await Bun.file(table_ts_path).exists();
	// An existing table.ts holds hand-tuned widths, classes and grid flags, so it is
	// never rewritten wholesale. New DB columns are merged into its `columns` map
	// instead, and everything already there is left byte-for-byte alone.
	if (exists) {
		await merge_columns_into_table_file(table_ts_path, config);
		return;
	}

	const fields_obj = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);

	// A locale clone row reuses the base row id verbatim, so default localization
	// only applies to tables with an auto-increment primary key (generate_fields_object
	// omits the pk field entirely in that case - see field_generator.ts).
	const is_auto_increment_pk = !Object.values(fields_obj).some((f) => f.name === "id");
	const localize_content = Bun.env.LOCALIZE_CONTENT === "true" && is_auto_increment_pk;

	const column_lines = build_column_lines(schema_obj, type_mapper, all_tables_columns, all_tables_indexes, localize_content, grid_columns);

	// Build columns as a string so we can include commented-out entries
	const columns_lines: string[] = ["{"];
	columns_lines.push(`  "checkbox": { width: "${COL_WIDTH_INTEGER}", class: "text-center" },`);
	columns_lines.push(`  "id": { width: "${COL_WIDTH_INTEGER}", class: "" },`);
	for (const entry of column_lines) { columns_lines.push(entry.line); }
	columns_lines.push("}");
	const columns_str = columns_lines.join("\n");

	// Auto-detect route_param: if another table references this one via FK,
	// use the referenced column as the route_param (e.g. equipment_items FK
	// references equipment.code -> route_param = "code").
	// Fall back to "id" if no reverse FK is found.
	let route_param = "id";
	if (all_schemas) {
		for (const schema of all_schemas) {
			if (schema.name === schema_obj.name) continue;
			for (const fk of schema.foreign_keys) {
				if (fk.referenced_table_name.toLowerCase() === schema_obj.name.toLowerCase()) {
					if (fk.referenced_column_name !== "id") {
						route_param = fk.referenced_column_name;
						break;
					}
				}
			}
			if (route_param !== "id") break;
		}
		if (route_param !== "id") { console.log(`Auto-detected route_param="${route_param}" for "${schema_obj.name}" (FK target)`); }
	}
	const route_param_export = `const route_param = "${route_param}";`;

	// Field type is now controlled via DB column comments - put "autocomplete", "textarea",
	// or "markdown" directly in the column comment to set the field type. JSON-style comments
	// ({type: "autocomplete"}) also work for advanced attribute overrides.
	const parent_export_block = schema_obj.parent ? `
// Parent table configuration for nested CRUD (set via --parent flag).
// This child table's records belong to a parent record.
// table: Parent table name
// fk_column: Foreign key column in this table referencing the parent
// route_param: URL parameter name for the parent ID in nested routes
export const parent = ${JSON.stringify(schema_obj.parent, null, 2)};
` : "";

	const content = `export type { ${schema_obj.name}_type } from "./table.generated";	export { v_fields, fields, indexed_columns } from "./table.generated";

// domain - canonical domain type from DOMAIN_TYPES taxonomy. Null when no match.
// Add compliant column to flag SQL mismatches against the canonical type.
// grid - set to false to hide from index grid while keeping for filtering.
// localized - set to true to give this column its own value per locale.
const columns: Record<string, { width: string; class: string; domain?: string; filter?: boolean; grid?: boolean; localized?: boolean }> = ${columns_str}

// Route param for URL paths - change to a different column for URL obscurity.
${route_param_export}

// Enable/disable delete functionality (bulk delete + record delete).
// Set to true to enable delete for this table. Children in nested CRUD always have delete enabled.
const enable_delete = false;

// Trailing filler track appended to the index grid's column widths.
// "1fr" - filler absorbs the leftover row width, so the widths above are respected.
// "0px" - no filler width, so columns stretch to fill the row instead.
const grid_filler = "1fr";

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
// Cursor is best for real-time tables, offset for numbered navigation.
// Set at schema generation time via reeman or --pagination flag.
const pagination_strategy: "cursor" | "offset" = "${pagination_strategy}";

// Render strategy: "load" (synchronous, full page after DB query) or "stream" (progressive via DPU).
// Streaming sends the page shell immediately, then streams records and pagination
// as <template for> chunks after DB queries resolve.
const render_strategy: "stream" | "load" = "${render_strategy}";

// Template tags: "flat" (raw <input>/<select> markup per field, generated inline) or
// "tags" (single self-contained ReeTag component per field, e.g. <input-text>).
// Use "tags" once a form's layout is stable and won't need per-field HTML customization.
const template_tags: "flat" | "tags" = "${template_tags}";
${parent_export_block}export { columns, route_param, enable_delete, grid_filler, pagination_strategy, render_strategy, template_tags };
`;

	await Bun.write(`${dir}/schema/table.ts`, content);
}

/**
 * Locate the `columns` object literal in a table.ts source and return the offsets
 * of its opening brace and matching closing brace. Brace-counting rather than a
 * regex, because entries carry `{ width: ... }` sub-objects and trailing comments.
 * Returns null when the declaration or its terminator cannot be found, so the
 * caller can skip the merge rather than write a corrupted file.
 */
function find_columns_body(source: string): { open: number; close: number; } | null {
	const decl_anchor = "const columns: Record<string,";
	const decl_start = source.indexOf(decl_anchor);
	if (decl_start < 0) return null;

	const open = source.indexOf("{", source.indexOf("=", decl_start));
	if (open < 0) return null;

	let depth = 0;
	let in_line_comment = false;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (in_line_comment) {
			if (ch === "\n") in_line_comment = false;
			continue;
		}
		// A commented-out entry contains braces that must not affect the depth count.
		if (ch === "/" && source[i + 1] === "/") { in_line_comment = true; continue; }
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return { open, close: i };
		}
	}
	return null;
}

/**
 * Which column names a table.ts `columns` body already mentions - including
 * commented-out (CU) entries, so re-running a refresh never resurrects a column
 * the developer deliberately commented out.
 */
function existing_column_names(body: string): Set<string> {
	const names = new Set<string>();
	const key_pattern = /^\s*(?:\/\/\s*)?"([^"]+)"\s*:/gm;
	let match: RegExpExecArray | null;
	while ((match = key_pattern.exec(body)) !== null) { names.add(match[1]!); }
	return names;
}

/**
 * Append `columns` entries for DB columns that appeared since table.ts was
 * scaffolded. Existing entries are never rewritten or reordered - hand-tuned
 * widths, classes, grid flags and comments survive verbatim. New entries are
 * added active (not commented) so a newly exposed view column actually shows up,
 * which is the whole point of a refresh.
 */
async function merge_columns_into_table_file(table_ts_path: string, config: WriteTableConfig): Promise<void> {
	const { schema_obj, type_mapper, all_tables_columns, all_tables_indexes, grid_columns } = config;
	const source = await Bun.file(table_ts_path).text();

	const body_range = find_columns_body(source);
	if (!body_range) {
		console.log(`  ${Bun.color("yellow", "ansi")}Could not locate the columns map in ${table_ts_path} - skipped column merge`);
		return;
	}

	const body = source.slice(body_range.open, body_range.close);
	const present = existing_column_names(body);

	const fields_obj = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);
	const is_auto_increment_pk = !Object.values(fields_obj).some((f) => f.name === "id");
	const localize_content = Bun.env.LOCALIZE_CONTENT === "true" && is_auto_increment_pk;

	const all_lines = build_column_lines(schema_obj, type_mapper, all_tables_columns, all_tables_indexes, localize_content, grid_columns);
	const new_lines = all_lines.filter((entry) => !present.has(entry.name));
	if (new_lines.length === 0) return;

	// Insert before the closing brace, matching the indentation the file already uses
	// for its entries. reettier would normalize this anyway, but a merged file should
	// read correctly even if formatting is skipped.
	const indent_match = body.match(/\n([ \t]+)(?:\/\/\s*)?"/);
	const indent = indent_match ? indent_match[1]! : "\t";
	const insert_at = source.lastIndexOf("\n", body_range.close) + 1;
	const reindented = new_lines.map((entry) => entry.line.replace(/^ {2}/, indent));
	const added_block = `${reindented.join("\n")}\n`;
	const merged = source.slice(0, insert_at) + added_block + source.slice(insert_at);

	await Bun.write(table_ts_path, merged);
	const added_names = new_lines.map((entry) => entry.name).join(", ");
	console.log(`  ${Bun.color("green", "ansi")}Merged ${new_lines.length} new column(s) into table.ts: ${added_names}`);
}
