import { join, relative } from "node:path";

import { ARCHIVE_TIMESTAMP_FIELD, IGNORE_ORDER_FIELDS, MAINTENANCE_FIELDS } from "$config/db_structure";

import type { FieldDef, ForeignKeyMap } from "./types";
import { MAIN_APP } from "$config/paths";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export function log_step(label: string) { console.log(`[${new Date().toISOString()}] ${label}`); }

// ---------------------------------------------------------------------------
// Archive detection
// ---------------------------------------------------------------------------

/**
 * Whether a table (or view) is archivable, decided by its physical columns.
 *
 * Must be asked of the DB column list, never of `fields`: `archived_at` is a
 * MAINTENANCE_FIELD, so it is deliberately absent from the generated `fields`
 * map, and a `fields.some(...)` test answers false for every table in the real
 * pipeline.
 */
export function has_archive_column(column_names: readonly string[] | null | undefined): boolean {
	return (column_names ?? []).some((name) => name.toLowerCase() === ARCHIVE_TIMESTAMP_FIELD);
}

// ---------------------------------------------------------------------------
// Route dir -> translation namespace
// ---------------------------------------------------------------------------

export function route_dir_to_namespace(route_dir: string): string {
	const rel_path = relative(join(process.cwd(), MAIN_APP), route_dir);
	return rel_path.replace(/\\/g, "/")
		.split("/")
		.filter((p) => p !== "translations")
		.join(".");
}

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

export function unique_fk_tables(foreign_keys: ForeignKeyMap): Array<{ table: string; column: string; label?: string; localized?: boolean; }> {
	const seen = new Set();
	const result: Array<{ table: string; column: string; label?: string; }> = [];

	for (const [, fk] of foreign_keys) {
		const key = `${fk.table}::${fk.column}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(fk);
	}

	return result;
}

export function get_autocomplete_fk_tables(fields: FieldDef[], foreign_keys: ForeignKeyMap): Array<{ table: string; column: string; label?: string; field_name: string; }> {
	const seen = new Set();
	const result: Array<{ table: string; column: string; label?: string; field_name: string; }> = [];

	for (const field of fields) {
		if (field.type === "autocomplete") {
			const fk_info = foreign_keys.get(field.name);
			if (fk_info) {
				const key = `${fk_info.table}::${fk_info.column}`;
				if (!seen.has(key)) {
					seen.add(key);
					result.push({ ...fk_info, field_name: field.name });
				}
			}
		}
	}

	return result;
}

export function user_fields(fields: FieldDef[]): FieldDef[] { return fields.filter((f) => !MAINTENANCE_FIELDS.includes(f.name.toLowerCase() as (typeof MAINTENANCE_FIELDS)[number])); }

/**
 * Determine the TS scalar type for a field's Record interface entry.
 * FK/select columns store fk_type (set from the referenced column's own
 * type), which is the source of truth over the UI-facing `type` field
 * (e.g. "select"/"autocomplete" would otherwise fall through to "string"
 * even when the FK column is numeric). Nullable DB columns get
 * `| null | undefined` - matching z.nullable(z.string().optional())'s
 * inferred output, which is what create_record/update_record receive.
 */
export function field_ts_type(f: FieldDef): string {
	const numeric_column_types = ["INTEGER", "REAL", "NUMERIC", "INT", "FLOAT", "DOUBLE", "DECIMAL"];
	const is_numeric = f.attributes?.fk_type === "number"
		|| f.type === "number"
		|| (f.attributes?.fk_type === undefined && numeric_column_types.includes((f.attributes?.column_type || "").toUpperCase()));
	const base = is_numeric ? "number" : "string";
	return f.is_nullable ? `${base} | null | undefined` : base;
}

/** Render a full `name?: type;` (or `name: type;`) Record interface line for a field. */
export function field_interface_prop(f: FieldDef): string {
	return `\t${f.name}${f.is_nullable ? "?" : ""}: ${field_ts_type(f)};`;
}

export function find_v_field(name: string, v_fields: FieldDef[] | null): FieldDef | undefined { return v_fields?.find((f) => f.name === name); }

export function determine_search_field(fields: FieldDef[]): string {
	const priority = ["search_text", "display"];
	for (const name of priority) {
		if (fields.some((f) => f.name === name)) return name;
	}
	return "id";
}

/**
 * Resolve the effective sort column for a field. FK id columns (e.g.
 * "author_id") are not meaningful to sort by in the UI - if the view exposes
 * a resolved display column ("author_display"), sort by that instead. Only
 * applies when the display column is actually present in `fields` (i.e. the
 * view was joined in); otherwise the raw id column is used as-is.
 */
function resolve_sort_column(col_name: string, fields: FieldDef[]): string {
	if (!col_name.endsWith("_id")) return col_name;
	const stem = col_name.slice(0, -3);
	const display_column = `${stem}_display`;
	return fields.some((f) => f.name === display_column) ? display_column : col_name;
}

export function generate_sort_options(fields: FieldDef[], indexed_columns?: string[]): string {
	const options: any[] = [
		{ value: "id::asc", field: "id", direction: "asc" },
		{ value: "id::desc", field: "id", direction: "desc" },
	];
	if (fields.some((field) => field.name === "display")) {
		options.push({ value: "display::asc", field: "display", direction: "asc" });
		options.push({ value: "display::desc", field: "display", direction: "desc" });
	}

	if (indexed_columns && indexed_columns.length > 0) {
		// Use indexed columns - sort options for every column with a DB key
		for (const col_name of indexed_columns) {
			if (col_name === "id" || col_name === "display") continue; // already added
			if (IGNORE_ORDER_FIELDS.includes(col_name as (typeof IGNORE_ORDER_FIELDS)[number])) continue;
			const field = fields.find((f) => f.name === col_name);
			if (field) {
				const sort_column = resolve_sort_column(col_name, fields);
				options.push({ value: `${sort_column}::asc`, field: sort_column, direction: "asc" });
				options.push({ value: `${sort_column}::desc`, field: sort_column, direction: "desc" });
			}
		}
	}

	return JSON.stringify(options);
}

// ---------------------------------------------------------------------------
// Marker helpers (for --refresh-fields)
// ---------------------------------------------------------------------------

export function escape_regex(str: string): string { return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Replace content between `<!-- crud:<name>:start -->` and `<!-- crud:<name>:end -->` markers.
 * Throws if markers are not found (file was not generated with markers).
 */
export function replace_between_markers(content: string, marker_name: string, new_content: string): string {
	const start = `<!-- GEN:${marker_name}:START -->`;
	const end = `<!-- GEN:${marker_name}:END -->`;
	const regex = new RegExp(`${escape_regex(start)}[\\s\\S]*?${escape_regex(end)}`);
	if (!regex.test(content)) { throw new Error(`Markers not found: crud:${marker_name}. Run with --force first to initialize.`); }
	return content.replace(regex, `${start}\n${new_content}\n${end}`);
}

/**
 * Extract content between marker pairs from existing content and inject it
 * into fresh template output. Used during --force regeneration to preserve
 * hand-edited sections like custom row prefixes (group headers/separators).
 * If the source has no markers, the fresh content is returned unchanged.
 */
export function preserve_marker_section(fresh: string, existing: string, marker_name: string): string {
	const start = escape_regex(`<!-- GEN:${marker_name}:START -->`);
	const end = escape_regex(`<!-- GEN:${marker_name}:END -->`);
	const extract_regex = new RegExp(`${start}([\\s\\S]*?)${end}`);
	const existing_match = extract_regex.exec(existing);
	if (!existing_match) return fresh;
	const custom_content = existing_match[1] ?? "";
	const replace_regex = new RegExp(`${start}[\\s\\S]*?${end}`);
	return fresh.replace(replace_regex, `<!-- GEN:${marker_name}:START -->${custom_content}<!-- GEN:${marker_name}:END -->`);
}

/**
 * Update grid-cols-[...] class value in index.ree.
 */
export function update_grid_cols(content: string, grid_value: string): string { return content.replace(/grid-cols-\[[\w_]+]/, `grid-cols-${grid_value}`); }

/**
 * Extract a template signature from a field-wrapper block to identify which template it uses.
 * Returns something like "input:text", "textarea", "input:checkbox", "select", "auto-complete", "input:hidden" (tags).
 */
function get_field_template_id(block: string): string {
	// Look for the input element after <label> inside <field-wrapper>
	const match = /<field-wrapper[^>]*>[\s\S]*?<\/label>\s*<(input|textarea|select|auto-complete|tags-input)\b([^>]*)>/.exec(block);
	if (!match) {
		// Fallback: look for any known element directly (some templates vary label placement)
		const fallback = /<(input|textarea|select|auto-complete|tags-input)\b([^>]*)>/.exec(block);
		if (!fallback) return "unknown";
		const tag = fallback[1]!;
		if (tag === "input") {
			const type_match = /type="([^"]*)"/.exec(fallback[2]!);
			return type_match ? `input:${type_match[1]}` : "input:text";
		}
		return tag;
	}
	const tag = match[1]!;
	if (tag === "input") {
		const type_match = /type="([^"]*)"/.exec(match[2]!);
		return type_match ? `input:${type_match[1]}` : "input:text";
	}
	if (tag === "textarea") return "textarea";
	if (tag === "select") return "select";
	if (tag === "auto-complete") return "autocomplete";
	if (tag === "tags-input") return "tags";
	return tag;
}

/**
 * Extract the element signature (tag + attributes) of the main input element
 * in a field-wrapper block. Used to detect attribute changes (like rows)
 * that should trigger a field-block replacement during refresh.
 */
function get_element_signature(block: string): string {
	const match = /<(input|textarea|select|auto-complete|tags-input)\b([^>]*)>/.exec(block);
	return match ? match[0] : "";
}

/** Whether a field block uses one of the localized editor containers. */
function get_field_container_type(block: string): "localized" | "plain" {
	return /^\s*<localized-(?:field-tabs|input-text)\b/.test(block) ? "localized" : "plain";
}

/** Extract the field name from any supported generated field container. */
function get_field_container_name(block: string): string | undefined {
	const container = /(?:data-field|\bfield|\bname|\bfield-name)="([^"]*)"/.exec(block);
	return container?.[1];
}

/**
 * Smart merge: diff existing field-wrappers (by data-field attribute) against new field blocks.
 * - Existing fields with same template type -> compare element signatures; if they differ in attributes, use new block
 * - Existing fields with same template type AND same element signature -> keep the old block (preserving user customizations)
 * - Existing fields with CHANGED template type -> use the new block (field type changed in schema)
 * - Removed fields -> delete the old block
 * - New fields -> append at the end
 * Non-field elements (layout divs, whitespace) between field-wrappers are preserved untouched.
 */
function smart_merge_fields_flat(old_section: string, new_field_blocks: string[]): string {
	// Match a WHOLE field container - either a plain <field-wrapper data-field>
	// or a <localized-field-tabs field> wrapper (which itself contains a
	// <field-wrapper>). Matching the outer container (not just the inner
	// field-wrapper) is what lets localization be added/removed on refresh
	// without nesting wrappers or leaving stale locale-tab shells behind.
	const field_regex = /<field-wrapper\b[^>]*data-field="([^"]*)"[^>]*>[\s\S]*?<\/field-wrapper>|<localized-field-tabs\b[^>]*field="([^"]*)"[^>]*>[\s\S]*?<\/localized-field-tabs>|<[a-z][\w]*-[\w-]+\b(?=[^>]*(?:\bname|\bfield-name)="[^"]*")[^>]*>[\s\S]*?<\/[a-z][\w]*-[\w-]+>/g;
	const old_field_info = new Map<string, string>(); // name → full container text
	let match: RegExpExecArray | null;
	while ((match = field_regex.exec(old_section)) !== null) {
		const field_name = get_field_container_name(match[0]);
		if (field_name) old_field_info.set(field_name, match[0]);
	}

	// Parse new field blocks: extract field names, build map + template IDs
	const new_field_map = new Map<string, string>();
	const new_template_ids = new Map<string, string>();
	for (const block of new_field_blocks) {
		const name_match = block.match(/(?:data-field|field|name)="([^"]*)"/);
		if (name_match) {
			new_field_map.set(name_match[1]!, block);
			new_template_ids.set(name_match[1]!, get_field_template_id(block));
		}
	}

	// Step 1: Replace old field containers
	// - If field still exists AND container/template/signature all match -> keep old block
	// - If field still exists BUT container shape (localized↔plain), template type,
	//   or element attributes changed -> use new block
	// - If field removed -> delete (replace with empty)
	let result = old_section.replace(field_regex, (_full) => {
		const field_name = get_field_container_name(_full);
		if (!field_name || !new_field_map.has(field_name)) return ""; // deleted
		const new_block = new_field_map.get(field_name)!;

		// Localization added or removed - the container shape changed, so take
		// the fresh block wholesale (also clears stale locale-tab shells).
		if (get_field_container_type(_full) !== get_field_container_type(new_block)) return new_block;

		const old_id = get_field_template_id(_full);
		const new_id = new_template_ids.get(field_name) || "unknown";
		if (old_id !== new_id) {
			// Template type changed - use new block
			return new_block;
		}
		// Same template type - check if element attributes changed (e.g., rows)
		const old_sig = get_element_signature(_full);
		const new_sig = get_element_signature(new_block);
		if (old_sig !== new_sig) {
			// Element attributes changed - use new block
			return new_block;
		}
		// Same container, template type, and element signature - keep old block
		// (preserves customizations)
		return _full;
	});

	// Step 2: Append new fields that don't exist in old section
	const appended: string[] = [];
	for (const [name, block] of new_field_map) {
		if (!old_field_info.has(name)) { appended.push(block); }
	}

	if (appended.length > 0) { result = `${result.trimEnd()}\n\n${appended.join("\n\n")}`; }

	// Clean up excessive blank lines (3+ -> 2)
	result = result.replace(/\n{3,}/g, "\n\n");

	return result;
}

/**
 * Tags-mode merge: each field is a single self-closing ReeTag (e.g. <input-foreign-key name="...">).
 * Some fields sit inside a <div data-localized-field-source="name" class="contents">...</div> wrapper;
 * that wrapper is left untouched as surrounding text (matching how flat mode preserves it around
 * <field-wrapper>) - only the inner tag itself is matched/replaced.
 * There is no hand-customizable content inside these tags (attributes are all schema/scope-derived),
 * so unlike flat mode there is no "keep old block" case - matched fields are always replaced with
 * the freshly generated block so option/value scope-variable fixes always propagate.
 */
function smart_merge_fields_tags(old_section: string, new_field_blocks: string[]): string {
	// Recognize both tags-mode fields and flat-mode containers so changing the
	// template mode on an existing route replaces the old representation
	// instead of leaving it in place and appending every field a second time.
	const field_regex = /<localized-field-tabs\b[^>]*field="([^"]*)"[^>]*>[\s\S]*?<\/localized-field-tabs>|<field-wrapper\b[^>]*data-field="([^"]*)"[^>]*>[\s\S]*?<\/field-wrapper>|<[a-z][\w]*-[\w-]+\b(?=[^>]*\bname="[^"]*")[^>]*>[\s\S]*?<\/[a-z][\w]*-[\w-]+>/g;
	const old_field_info = new Map(); // name -> full matched block text
	let match: RegExpExecArray | null;
	while ((match = field_regex.exec(old_section)) !== null) {
		const field_name = get_field_container_name(match[0]);
		if (field_name) old_field_info.set(field_name, match[0]);
	}

	const new_field_map = new Map();
	for (const block of new_field_blocks) {
		const name_match = block.match(/<input-[\w-]+\s[^>]*name="([^"]*)"/);
		if (name_match) { new_field_map.set(name_match[1], block); }
	}

	let result = old_section.replace(field_regex, (_full) => {
		const field_name = get_field_container_name(_full);
		if (!field_name) return "";
		if (!new_field_map.has(field_name)) return ""; // deleted
		return new_field_map.get(field_name)!;
	});

	const appended: string[] = [];
	for (const [name, block] of new_field_map) {
		if (!old_field_info.has(name)) { appended.push(block); }
	}

	if (appended.length > 0) { result = `${result.trimEnd()}\n\n${appended.join("\n\n")}`; }

	result = result.replace(/\n{3,}/g, "\n\n");

	return result;
}

export function smart_merge_fields(old_section: string, new_field_blocks: string[], template_tags: "flat" | "tags" = "flat"): string {
	if (template_tags === "tags") { return smart_merge_fields_tags(old_section, new_field_blocks); }
	return smart_merge_fields_flat(old_section, new_field_blocks);
}

// ---------------------------------------------------------------------------
// Foreign Key detection
// ---------------------------------------------------------------------------

export function extract_foreign_keys(fields: FieldDef[], generated_fields?: Record<string, any> | null): ForeignKeyMap {
	const fk_map = new Map();

	for (const field of fields) {
		// Only extract FK info for field types that render as FK selects/autocompletes.
		// If a user overrides a FK field's type to e.g. "number", skip FK handling.
		if (field.type !== "foreign_key" && field.type !== "autocomplete") continue;

		const fk = field.attributes?.foreign_key;
		if (fk) {
			fk_map.set(field.name, { table: fk.table, column: fk.column, label: field.label });
		} else if (generated_fields?.[field.name]?.attributes?.foreign_key) {
			const gen_fk = generated_fields[field.name].attributes.foreign_key;
			fk_map.set(field.name, {
				table: gen_fk.table,
				column: gen_fk.column,
				label: field.label || gen_fk.label,
			});
		}
	}

	return fk_map;
}
