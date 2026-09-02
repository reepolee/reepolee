import {
	ARCHIVE_SCOPE_SEEDS,
	ARCHIVE_TIMESTAMP_FIELD,
	BOOLEAN_PREFIXES,
	COL_WIDTH_AUTO,
	COL_WIDTH_INTEGER,
	CURRENCY_FIELD,
	IGNORE_INDEX_FIELDS,
	LOCALIZABLE_STRING_TYPES,
	LOCALIZATION_SYSTEM_FIELDS,
	PERCENT_FIELD,
} from "$config/db_structure";

import { env_switch_on } from "$config/env_vars";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { MAIN_APP } from "$config/paths";
import { default_field_helper } from "../crud/render_field_cell";
import { canonical_sql_for_domain, generate_fields_object } from "./field_generator";
import { load_table_module_fresh } from "./table_module_loader";
import type { TypeMapper } from "./type_mapper";
import type { FormFieldDef, GridColumnDefinition, SchemaObject } from "./types";

/**
 * Whether a table has an auto-increment integer primary key. Localization
 * (per-locale clone tables) reuses the base row's integer id verbatim, so it
 * is only valid for this shape of key. `primary_key` is the authoritative
 * signal when present (both introspectors set it); schemas assembled by hand
 * (synthetic/BREAD, tests) fall back to scanning `columns`, where the PK
 * column carries both flags.
 */
function has_auto_increment_pk(schema_obj: SchemaObject): boolean {
	if (schema_obj.primary_key) return schema_obj.primary_key.is_auto_increment;
	return schema_obj.columns.some((column) => column.is_primary_key && column.is_auto_increment);
}

function is_localizable_string(
	field: FormFieldDef,
	base_table_field_names: Set<string>,
	unique_field_names: Set<string>,
	foreign_key_field_names: Set<string>,
): boolean {
	return (
		(LOCALIZABLE_STRING_TYPES as readonly string[]).includes(field.type) &&
		!(LOCALIZATION_SYSTEM_FIELDS as readonly string[]).includes(field.name) &&
		!unique_field_names.has(field.name.toLowerCase()) &&
		!foreign_key_field_names.has(field.name.toLowerCase()) &&
		base_table_field_names.has(field.name)
	);
}

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

	await Bun.write(join(dir, "schema.generated.ts"), content);
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
	width: string;
	class_name: string;
	filter: boolean;
	helper: string;
	/** The type-based helper the CRUD generator would apply if none is selected. */
	default_helper: string;
	/** Whether this column is marked readonly in the existing config.ts columns map. */
	readonly: boolean;
	/** Whether this column receives the current automatic localization default. */
	localized: boolean;
}

function column_class(field: FormFieldDef): string {
	if (field.attributes?.initial_class) return field.attributes.initial_class;
	const column_type = field.attributes?.column_type?.toLowerCase() || "";
	const column_name = field.name || "";
	if (column_type === CURRENCY_FIELD.toLowerCase() || column_type === PERCENT_FIELD.toLowerCase()) return "text-right";
	if (BOOLEAN_PREFIXES.some((prefix) => column_name.startsWith(prefix))) return "text-center";
	return "";
}

function capped_width(width: string): string {
	const ch_match = width.match(/^(\d+)ch$/);
	if (ch_match && Number(ch_match[1]) > 20) return COL_WIDTH_AUTO;
	return width;
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
	const unique_field_names = new Set([
		...(schema_obj.unique_columns ?? []),
		...schema_obj.columns.filter((column) => column.is_primary_key || column.is_unique === true).map((column) => column.name),
	].map((name) => name.toLowerCase()));
	const foreign_key_field_names = new Set(
		sets.source_fields
			.filter((field) => field.type === "foreign_key")
			.map((field) => field.name.toLowerCase()),
	);
	const localize_content = env_switch_on("LOCALIZE_CONTENT") && has_auto_increment_pk(schema_obj);

	// Same eligibility rule the writer applies: checkbox/id are always present, and
	// an FK _id with a display sibling is hidden regardless of what the user picks.
	const eligible = sets.source_fields.filter((f) => f.name !== "id" && f.name !== "checkbox" && !sets.has_display_field_for_fk(f));

	const media_last = [...eligible].sort((a, b) => {
		const a_media = /_image$|_file$/.test(a.name) ? 1 : 0;
		const b_media = /_image$|_file$/.test(b.name) ? 1 : 0;
		return a_media - b_media;
	});
	// Joined display columns are the readable representation of an FK and should
	// remain visible even when they appear after the normal five-column cap.
	const display_fields = eligible.filter((f) => f.name.endsWith("_display"));
	const default_names = new Set(display_fields.map((f) => f.name));
	for (const field of media_last) {
		if (default_names.size >= DEFAULT_GRID_COLUMN_CAP) break;
		default_names.add(field.name);
	}

	return eligible.map((field) => ({
		name: field.name,
		default_selected: default_names.has(field.name),
		width: capped_width(field.attributes?.initial_width || COL_WIDTH_AUTO),
		class_name: column_class(field),
		filter: field.attributes?.filter === true,
		helper: "",
		default_helper: default_field_helper(field),
		readonly: field.attributes?.readonly === true,
		localized: localize_content && is_localizable_string(field, sets.base_table_field_names, unique_field_names, foreign_key_field_names),
	}));
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
	grid_column_definitions?: GridColumnDefinition[],
): ColumnLine[] {
	const { source_fields, source_commented, base_table_field_names, has_display_field_for_fk } = build_grid_field_sets(
		schema_obj,
		type_mapper,
		all_tables_columns,
		all_tables_indexes
	);

	const unique_field_names = new Set([
		...(schema_obj.unique_columns ?? []),
		...schema_obj.columns.filter((column) => column.is_primary_key || column.is_unique === true).map((column) => column.name),
	].map((name) => name.toLowerCase()));
	const foreign_key_field_names = new Set(
		source_fields
			.filter((field) => field.type === "foreign_key")
			.map((field) => field.name.toLowerCase()),
	);

	// Build a concise mismatch comment naming the actual vs. canonical SQL type.
	function domain_mismatch_comment(f: FormFieldDef, domain: string | undefined, compliant: boolean | undefined): string {
		if (!domain || compliant) return "";
		const actual = f.attributes?.column_type || "unknown";
		const canonical = canonical_sql_for_domain(domain) || "unknown";
		return ` // ⚠ ${domain} expects ${canonical}, got ${actual}`;
	}

	// Which columns the index grid shows. checkbox/id are excluded from the decision
	// (almost always present), and fields already hidden for another reason (FK _id
	// with a display sibling) don't count either since they're not contributing
	// visible width.
	const eligible_for_cap = source_fields.filter((f) => f.name !== "id" && f.name !== "checkbox" && !has_display_field_for_fk(f));
	const definition_entries = grid_column_definitions?.map((definition) => [definition.name, definition] as const) ?? [];
	const definitions_by_name = new Map(definition_entries);

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
		const default_names = new Set(eligible_for_cap.filter((f) => f.name.endsWith("_display")).map((f) => f.name));
		for (const field of image_or_file_last) {
			if (default_names.size >= DEFAULT_GRID_COLUMN_CAP) break;
			default_names.add(field.name);
		}
		hidden_by_cap = new Set(eligible_for_cap.filter((f) => !default_names.has(f.name)).map((f) => f.name));
	}

	function format_line(f: FormFieldDef, commented: boolean): string {
		const definition = definitions_by_name.get(f.name);
		const width = definition?.width ?? capped_width(f.attributes?.initial_width || COL_WIDTH_AUTO);
		const cls = definition?.class_name ?? column_class(f);
		const domain = f.attributes?.domain_type;
		const compliant = f.attributes?.domain_compliant;
		const domain_prop = domain ? `, domain: "${domain}"` : "";

		// Auto-detect FK _id fields with a corresponding display field in the view.
		// Hide them from the grid (grid: false) but keep them filterable (filter: true).
		const is_auto_hidden_fk = has_display_field_for_fk(f);
		const filter_val = definition?.filter ?? (is_auto_hidden_fk || f.attributes?.filter);
		const filter_prop = filter_val ? ", filter: true" : "";
		const helper_prop = definition?.helper ? `, helper: ${JSON.stringify(definition.helper)}` : "";
		// Commented (CU) entries never carry the cap-based hide - they are already hidden.
		const grid_prop = is_auto_hidden_fk || (!commented && hidden_by_cap.has(f.name)) ? ", grid: false" : "";
		const localized = definition?.localized ?? (localize_content && is_localizable_string(f, base_table_field_names, unique_field_names, foreign_key_field_names));
		const localized_prop = localized ? ", localized: true" : "";
		const readonly_prop = definition?.readonly ? ", readonly: true" : "";

		const mismatch_comment = domain_mismatch_comment(f, domain, compliant);
		const prefix = commented ? "  // " : "  ";
		const width_value = JSON.stringify(width);
		const class_value = JSON.stringify(cls);
		return `${prefix}"${f.name}": { width: ${width_value}, class: ${class_value}${domain_prop}${filter_prop}${helper_prop}${grid_prop}${localized_prop}${readonly_prop} },${mismatch_comment}`;
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
	/** Per-column width, class and filter values supplied by the CRUD creation UI. */
	grid_column_definitions?: GridColumnDefinition[];
	/**
	 * Override for whether string columns are scaffolded with `localized: true`.
	 * Omit to fall back to `Bun.env.LOCALIZE_CONTENT` (the project-wide default
	 * for DB-backed tables). Callers with no notion of DB content localization
	 * (e.g. BREAD resources) pass this explicitly instead of inheriting the
	 * project setting.
	 */
	localize_content?: boolean;
}

type NavigationConfig = {
	section_key: string | null;
	item_order: number;
	section_order: number | null;
	group_order: number | null;
	final_order: number | null;
};

function navigation_block(navigation: NavigationConfig): string {
	return `// Navigation is the source of truth for this route's sidebar placement.
const navigation = {
	// Section heading translation key; null keeps this route directly in its module group.
	section_key: ${JSON.stringify(navigation.section_key)},
	// Link order within its section or group; lower values appear first.
	item_order: ${navigation.item_order},
	// Section order; only used when section_key is set.
	section_order: ${navigation.section_order},
	// Module group order; lower values appear first.
	group_order: ${navigation.group_order},
	// Reserved final-sidebar-link order; currently unused by generated routes.
	final_order: ${navigation.final_order},
};`;
}

export function next_navigation_item_order(item_orders: readonly number[]): number {
	let highest_item_order = 0;
	for (const item_order of item_orders) {
		if (!Number.isFinite(item_order)) continue;
		highest_item_order = Math.max(highest_item_order, item_order);
	}
	return highest_item_order + 10;
}

async function navigation_for_new_route(dir: string): Promise<NavigationConfig> {
	const main_routes_dir = join(process.cwd(), MAIN_APP);
	const route_relative_dir = relative(main_routes_dir, dir);
	if (route_relative_dir === "" || route_relative_dir.startsWith("..")) {
		return { section_key: null, item_order: 10, section_order: null, group_order: null, final_order: null };
	}

	const sibling_dir = dirname(dir);
	const sibling_entries = readdirSync(sibling_dir, { withFileTypes: true });
	const route_dir_name = basename(dir);
	const sibling_item_orders: number[] = [];
	let group_order: number | null = null;

	for (const sibling of sibling_entries) {
		if (!sibling.isDirectory() || sibling.name === route_dir_name) continue;
		const sibling_config_path = join(sibling_dir, sibling.name, "config.ts");
		if (!statSync(sibling_config_path, { throwIfNoEntry: false })?.isFile()) continue;

		const module_data = await load_table_module_fresh<{ navigation?: Partial<NavigationConfig>; }>(sibling_config_path);
		const navigation = module_data.navigation;
		if (!navigation) continue;
		if (navigation.section_key === null && typeof navigation.item_order === "number" && Number.isFinite(navigation.item_order)) {
			sibling_item_orders.push(navigation.item_order);
		}
		if (typeof navigation.group_order === "number" && Number.isFinite(navigation.group_order)) {
			group_order = navigation.group_order;
		}
	}

	return {
		section_key: null,
		item_order: next_navigation_item_order(sibling_item_orders),
		section_order: null,
		group_order,
		final_order: null,
	};
}

function inject_navigation_declaration(source: string, navigation: NavigationConfig): string {
	if (/^const navigation\s*=/m.test(source)) return source;
	const export_index = source.indexOf("export { columns");
	if (export_index < 0) return source;
	const block = navigation_block(navigation);
	const export_source = source.slice(export_index).replace("template_tags", "template_tags, navigation");
	return `${source.slice(0, export_index)}${block}\n${export_source}`;
}

export async function write_table_file(config: WriteTableConfig): Promise<void> {
	const { dir, schema_obj, type_mapper, all_tables_columns, all_tables_indexes, pagination_strategy = "offset", render_strategy = "load", template_tags = "flat", grid_columns, grid_column_definitions, localize_content: localize_content_override } = config;
	const config_ts_path = join(dir, "config.ts");
	const exists = await Bun.file(config_ts_path).exists();
	const navigation = await navigation_for_new_route(dir);
	// An existing config.ts is never rewritten wholesale. New DB columns are merged
	// into its `columns` map, and explicit editor values update only their matching
	// settings.
	if (exists) {
		await merge_columns_into_table_file(config_ts_path, config, navigation);
		return;
	}

	// A locale clone row reuses the base row id verbatim, so default localization
	// only applies to tables with an auto-increment integer primary key.
	const is_auto_increment_pk = has_auto_increment_pk(schema_obj);
	const localize_content = localize_content_override !== undefined
		? localize_content_override && is_auto_increment_pk
		: env_switch_on("LOCALIZE_CONTENT") && is_auto_increment_pk;
	const column_lines = build_column_lines(schema_obj, type_mapper, all_tables_columns, all_tables_indexes, localize_content, grid_columns, grid_column_definitions);

	// Build columns as a string so we can include commented-out entries
	const columns_lines: string[] = ["{"];
	columns_lines.push(`  "checkbox": { width: "${COL_WIDTH_INTEGER}", class: "text-center" },`);
	columns_lines.push(`  "id": { width: "${COL_WIDTH_INTEGER}", class: "" },`);
	for (const entry of column_lines) { columns_lines.push(entry.line); }
	columns_lines.push("}");
	const columns_str = columns_lines.join("\n");

	// URLs use the primary key unless the application owner explicitly changes
	// config.ts. A reverse foreign key identifies a relationship, not a stable
	// public route identifier.
	const route_param_export = 'const route_param = "id";';

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

	const global_scopes_block = build_global_scopes_block(schema_obj);
	const navigation_source = navigation_block(navigation);

	const content = `export type { ${schema_obj.name}_type } from "./schema.generated";	export { v_fields, fields, indexed_columns } from "./schema.generated";

// domain - canonical domain type from DOMAIN_TYPES taxonomy. Null when no match.
// Add compliant column to flag SQL mismatches against the canonical type.
// grid - set to false to hide from index grid while keeping for filtering.
// localized - set to true to give this column its own value per locale.
// readonly - set to true to display this column's value on forms without an editor.
// helper - built-in template helper applied to this column's index-grid cell, e.g.
// "js_date_to_locale_string" renders the value as {~ js_date_to_locale_string(record.field) }.
const columns: Record<string, { width: string; class: string; domain?: string; filter?: boolean; helper?: string; grid?: boolean; localized?: boolean; readonly?: boolean }> = ${columns_str}

// Route param for URL paths - change to a different column for URL obscurity.
${route_param_export}

// Enable/disable the destructive action (record + bulk). For a table carrying
// an archived_at column this archives (soft delete); otherwise it hard-deletes.
// Children in nested CRUD always have this action enabled.
const enable_archive = false;

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

${navigation_source}
${global_scopes_block ? `\n${global_scopes_block}\n` : ""}${parent_export_block}export { columns, route_param, enable_archive, grid_filler, pagination_strategy, render_strategy, template_tags, navigation${global_scopes_block ? ", global_scopes" : ""} };
`;

	await Bun.write(config_ts_path, content);
}

/**
 * The `global_scopes` declaration block for a config.ts, or null when the table
 * is not archivable. Built from ARCHIVE_SCOPE_SEEDS so the scaffold and the
 * seed rows stay in sync. The declaration is the source of truth for seeding -
 * editing keys here and regenerating seeds the new rows (existing rows in the
 * global_scopes table are never overwritten).
 */
function build_global_scopes_block(schema_obj: SchemaObject): string | null {
	const has_archive = schema_obj.columns.some((column) => column.name.toLowerCase() === ARCHIVE_TIMESTAMP_FIELD);
	if (!has_archive) return null;

	const entries = ARCHIVE_SCOPE_SEEDS.map((seed) => {
		const props = [`display_name: ${JSON.stringify(seed.display_name)}`];
		if (seed.sort_order !== undefined) props.push(`sort_order: ${seed.sort_order}`);
		if (seed.is_default) props.push(`is_default: true`);
		return `\t${JSON.stringify(seed.scope_key)}: { ${props.join(", ")} },`;
	});

	return `// Global scopes - the scope keys this route offers. Each entry is seeded as a
// global_scopes row when CRUD is generated (existing rows are never
// overwritten); display_name is the fallback label, overridable per locale via
// 'scopes.<key>' in this namespace's translation files. '__live', '__archived'
// and '__all' are the reserved archive scopes - the route handler maps them to
// the archive filter and never uses their where_clause as SQL. Add your own
// keys (with a where_clause) for custom views.
const global_scopes: Record<string, { display_name: string; where_clause?: string; sort_order?: number; is_default?: boolean }> = {
${entries.join("\n")}
};`;
}

/**
 * Insert the global_scopes declaration into an existing config.ts, just before
 * the final `export { ... }` statement, and add `global_scopes` to that export
 * list. Returns the source unchanged when the statement cannot be found.
 */
function inject_global_scopes_declaration(source: string, block: string): string {
	let export_idx = source.indexOf("export { columns");
	if (export_idx < 0) export_idx = source.lastIndexOf("export {");
	if (export_idx < 0) return source;

	let export_part = source.slice(export_idx);
	if (!/\bglobal_scopes\b/.test(export_part)) {
		export_part = export_part.replace(/export \{([^}]*)\}/, "export {$1, global_scopes }");
	}
	return `${source.slice(0, export_idx)}${block}\n\n${export_part}`;
}

/**
 * Locate the `columns` object literal in a config.ts source and return the offsets
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
 * Which column names a config.ts `columns` body already mentions - including
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
 * Toggle the `grid: false` property on one existing column entry's line,
 * in place, without touching width/class/domain/filter/localized or comments.
 * Returns the line unchanged if it already matches the wanted visibility.
 */
function set_grid_flag_on_line(line: string, hidden: boolean): string {
	const has_grid_false = /,\s*grid:\s*false/.test(line);
	if (hidden === has_grid_false) return line;
	if (hidden) {
		const localized_index = line.indexOf(", localized:");
		const insert_index = localized_index >= 0 ? localized_index : line.lastIndexOf("}");
		if (insert_index < 0) return line;
		return `${line.slice(0, insert_index)}, grid: false${line.slice(insert_index)}`;
	}
	return line.replace(/,\s*grid:\s*false/, "");
}

function set_string_property_on_line(line: string, property: "width" | "class", value: string): string {
	const property_pattern = new RegExp(`${property}:\\s*"(?:\\\\.|[^"\\\\])*"`);
	return line.replace(property_pattern, `${property}: ${JSON.stringify(value)}`);
}

function set_true_flag_on_line(line: string, property: "filter" | "localized" | "readonly", enabled: boolean): string {
	const property_pattern = new RegExp(`,\\s*${property}:\\s*true`);
	if (!enabled) return line.replace(property_pattern, "");
	if (property_pattern.test(line)) return line;
	const later_property_indexes = [line.indexOf(", grid:"), line.indexOf(", localized:")].filter((index) => index >= 0);
	// filter sits before grid/localized; localized follows grid and precedes
	// readonly, which stays right before the closing brace.
	const insert_index = property === "filter"
		? (later_property_indexes[0] ?? line.lastIndexOf("}"))
		: property === "localized"
			? (line.indexOf(", readonly:") >= 0 ? line.indexOf(", readonly:") : line.lastIndexOf("}"))
		: line.lastIndexOf("}");
	if (insert_index < 0) return line;
	const before_close = line.slice(0, insert_index);
	const trimmed_before_close = before_close.trimEnd();
	const suffix = line.slice(insert_index);
	const separator = suffix.startsWith(",") ? "" : " ";
	return `${trimmed_before_close}, ${property}: true${separator}${suffix}`;
}

/**
 * Set or clear the optional `helper` property on one column line. An empty
 * value removes any existing `, helper: "..."` clause; a non-empty value
 * inserts/replaces it, kept after `filter` and before `grid`/`localized`.
 */
function set_helper_property_on_line(line: string, value: string): string {
	const has_helper = /,\s*helper:\s*".*?"/.test(line);
	if (!value) return has_helper ? line.replace(/,\s*helper:\s*".*?"/, "") : line;
	const quoted = JSON.stringify(value);
	if (has_helper) return line.replace(/,\s*helper:\s*".*?"/, `, helper: ${quoted}`);
	const filter_index = line.indexOf(", filter:");
	const grid_index = line.indexOf(", grid:");
	const localized_index = line.indexOf(", localized:");
	const later_property_indexes = [filter_index, grid_index, localized_index].filter((index) => index >= 0);
	later_property_indexes.sort((a, b) => a - b);
	const insert_index = later_property_indexes[0] ?? line.lastIndexOf("}");
	if (insert_index < 0) return line;
	const before_close = line.slice(0, insert_index);
	const suffix = line.slice(insert_index);
	return `${before_close.trimEnd()}, helper: ${quoted}${suffix}`;
}

export interface TableFileSettings {
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
	template_tags?: "flat" | "tags";
	grid_columns?: string[];
	grid_column_definitions?: GridColumnDefinition[];
}

function apply_grid_settings(source: string, settings: TableFileSettings): { source: string; updated_names: string[]; } {
	if (!settings.grid_column_definitions) return { source, updated_names: [] };

	const selected = settings.grid_columns === undefined ? null : new Set(settings.grid_columns);
	let working_source = source;
	const updated_names: string[] = [];
	for (const definition of settings.grid_column_definitions) {
		const escaped_name = definition.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const line_pattern = new RegExp(`^([ \\t]*)"${escaped_name}":\\s*\\{[^}]*\\},?.*$`, "m");
		const match = working_source.match(line_pattern);
		if (!match) continue;

		let updated = match[0]!;
		updated = set_string_property_on_line(updated, "width", definition.width);
		updated = set_string_property_on_line(updated, "class", definition.class_name);
		updated = set_true_flag_on_line(updated, "filter", definition.filter);
		if (definition.helper !== undefined) updated = set_helper_property_on_line(updated, definition.helper);
		if (definition.localized !== undefined) updated = set_true_flag_on_line(updated, "localized", definition.localized);
		if (definition.readonly !== undefined) updated = set_true_flag_on_line(updated, "readonly", definition.readonly);
		if (selected) updated = set_grid_flag_on_line(updated, !selected.has(definition.name));
		if (updated === match[0]) continue;
		working_source = working_source.replace(match[0]!, updated);
		updated_names.push(definition.name);
	}
	return { source: working_source, updated_names };
}

function set_schema_setting(source: string, setting: "pagination_strategy" | "render_strategy" | "template_tags", value: string): string {
	const setting_pattern = new RegExp(`(const ${setting}:[^=]+?=\\s*)"[^"]+"`);
	return source.replace(setting_pattern, `$1${JSON.stringify(value)}`);
}

function apply_table_file_settings(source: string, settings: TableFileSettings): { source: string; updated_names: string[]; } {
	const grid_result = apply_grid_settings(source, settings);
	let working_source = grid_result.source;
	if (settings.pagination_strategy) working_source = set_schema_setting(working_source, "pagination_strategy", settings.pagination_strategy);
	if (settings.render_strategy) working_source = set_schema_setting(working_source, "render_strategy", settings.render_strategy);
	if (settings.template_tags) working_source = set_schema_setting(working_source, "template_tags", settings.template_tags);
	return { source: working_source, updated_names: grid_result.updated_names };
}

export async function update_table_file_settings(table_ts_path: string, settings: TableFileSettings): Promise<void> {
	const source = await Bun.file(table_ts_path).text();
	const result = apply_table_file_settings(source, settings);
	if (result.source !== source) await Bun.write(table_ts_path, result.source);
}

/**
 * Append `columns` entries for DB columns that appeared since config.ts was
 * scaffolded. Explicit settings from the index-column editor update width,
 * class, filter and visibility on existing entries while leaving domain,
 * localized and comments untouched.
 */
async function merge_columns_into_table_file(table_ts_path: string, config: WriteTableConfig, navigation: NavigationConfig): Promise<void> {
	const { schema_obj, type_mapper, all_tables_columns, all_tables_indexes, grid_columns, grid_column_definitions, localize_content: localize_content_override } = config;
	let source = await Bun.file(table_ts_path).text();
	const navigation_source = inject_navigation_declaration(source, navigation);
	if (navigation_source !== source) {
		await Bun.write(table_ts_path, navigation_source);
		source = navigation_source;
		console.log(`  ${Bun.color("green", "ansi")}Added navigation declaration to schema`);
	}

	// Inject the global_scopes declaration into config.ts files scaffolded before
	// the const existed (archivable tables only). A declaration already present
	// is hand-edited territory and is left byte-for-byte alone.
	const global_scopes_block = build_global_scopes_block(schema_obj);
	if (global_scopes_block && !source.includes("const global_scopes")) {
		const injected = inject_global_scopes_declaration(source, global_scopes_block);
		if (injected !== source) {
			await Bun.write(table_ts_path, injected);
			source = injected;
			console.log(`  ${Bun.color("green", "ansi")}Added global_scopes declaration to schema`);
		}
	}

	const body_range = find_columns_body(source);
	if (!body_range) {
		console.log(`  ${Bun.color("yellow", "ansi")}Could not locate the columns map in ${table_ts_path} - skipped column merge`);
		return;
	}

	const body = source.slice(body_range.open, body_range.close);
	const present = existing_column_names(body);

	const is_auto_increment_pk = has_auto_increment_pk(schema_obj);
	const localize_content = localize_content_override !== undefined
		? localize_content_override && is_auto_increment_pk
		: env_switch_on("LOCALIZE_CONTENT") && is_auto_increment_pk;
	const all_lines = build_column_lines(schema_obj, type_mapper, all_tables_columns, all_tables_indexes, localize_content, grid_columns, grid_column_definitions);
	const new_lines = all_lines.filter((entry) => !present.has(entry.name));

	const settings_result = apply_table_file_settings(source, config);
	let working_source = settings_result.source;
	const retargeted_names = settings_result.updated_names;

	if (grid_columns !== undefined && !grid_column_definitions) {
		const selected = new Set(grid_columns);
		const existing_lines = all_lines.filter((entry) => present.has(entry.name) && !entry.commented);
		for (const entry of existing_lines) {
			const wanted_hidden = !selected.has(entry.name);
			const line_pattern = new RegExp(`^([ \\t]*)"${entry.name}":\\s*\\{[^}]*\\},?.*$`, "m");
			const match = working_source.match(line_pattern);
			if (!match) continue;
			const retargeted = set_grid_flag_on_line(match[0]!, wanted_hidden);
			if (retargeted === match[0]) continue;
			working_source = working_source.replace(match[0]!, retargeted);
			retargeted_names.push(entry.name);
		}
	}

	if (retargeted_names.length > 0) { console.log(`  ${Bun.color("green", "ansi")}Updated index-grid settings for ${retargeted_names.length} existing column(s): ${retargeted_names.join(", ")}`); }

	if (new_lines.length === 0) {
		if (working_source !== source) await Bun.write(table_ts_path, working_source);
		return;
	}

	// Insert before the closing brace, matching the indentation the file already uses
	// for its entries. reettier would normalize this anyway, but a merged file should
	// read correctly even if formatting is skipped. Re-locate the body range since
	// the grid-flag pass above may have shifted offsets within the file.
	const working_body_range = find_columns_body(working_source)!;
	const working_body = working_source.slice(working_body_range.open, working_body_range.close);
	const indent_match = working_body.match(/\n([ \t]+)(?:\/\/\s*)?"/);
	const indent = indent_match ? indent_match[1]! : "\t";
	const insert_at = working_source.lastIndexOf("\n", working_body_range.close) + 1;
	const reindented = new_lines.map((entry) => entry.line.replace(/^ {2}/, indent));
	const added_block = `${reindented.join("\n")}\n`;
	const merged = working_source.slice(0, insert_at) + added_block + working_source.slice(insert_at);

	await Bun.write(table_ts_path, merged);
	const added_names = new_lines.map((entry) => entry.name).join(", ");
	console.log(`  ${Bun.color("green", "ansi")}Merged ${new_lines.length} new column(s) into config.ts: ${added_names}`);
}
