import { join, relative } from "node:path";

import { IGNORE_ORDER_FIELDS, MAINTENANCE_FIELDS } from "$config/db_structure";

import { capitalize_first } from "../naming";

import type { FieldDef, ForeignKeyMap } from "./types";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export function log_step(label: string) { console.log(`[${new Date().toISOString()}] ${label}`); }

// ---------------------------------------------------------------------------
// Route dir -> translation namespace
// ---------------------------------------------------------------------------

export function route_dir_to_namespace(route_dir: string): string {
	const rel_path = relative(join(process.cwd(), "routes"), route_dir);
	return rel_path.replace(/\\/g, "/")
		.split("/")
		.filter((p) => p !== "translations")
		.join(".");
}

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

export function unique_fk_tables(foreign_keys: ForeignKeyMap): Array<{ table: string; column: string; label?: string; }> {
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

export function user_fields(fields: FieldDef[]): FieldDef[] { return fields.filter((f) => !MAINTENANCE_FIELDS.includes(f.name.toLowerCase())); }

export function find_v_field(name: string, v_fields: FieldDef[] | null): FieldDef | undefined { return v_fields?.find((f) => f.name === name); }

export function determine_search_field(fields: FieldDef[]): string {
	const priority = ["search_text", "title", "name"];
	for (const name of priority) {
		if (fields.some((f) => f.name === name)) return name;
	}
	return "id";
}

export function generate_sort_options(fields: FieldDef[], indexed_columns?: string[]): string {
	const options: any[] = [
		{ value: "id::asc", label: "ID (Ascending)" },
		{ value: "id::desc", label: "ID (Descending)" },
	];

	if (indexed_columns && indexed_columns.length > 0) {
		// Use indexed columns - sort options for every column with a DB key
		for (const col_name of indexed_columns) {
			if (col_name === "id") continue; // already added
			if (IGNORE_ORDER_FIELDS.includes(col_name)) continue;
			const field = fields.find((f) => f.name === col_name);
			if (field) {
				const label = capitalize_first(col_name.replace(/_/g, " "));
				options.push({ value: `${col_name}::asc`, label: `${label} (Ascending)` });
				options.push({ value: `${col_name}::desc`, label: `${label} (Descending)` });
			}
		}
	} else {
		// Fallback: hardcoded sortable list for schemas without indexed_columns
		const sortable = ["id", "title", "name", "email"];
		for (const s of sortable) {
			if (s !== "id" && fields.some((f) => f.name === s)) {
				if (IGNORE_ORDER_FIELDS.includes(s)) continue;
				const label = capitalize_first(s.replace(/_/g, " "));
				options.push({ value: `${s}::asc`, label: `${label} (Ascending)` });
				options.push({ value: `${s}::desc`, label: `${label} (Descending)` });
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
	const start = `<!-- crud:${marker_name}:start -->`;
	const end = `<!-- crud:${marker_name}:end -->`;
	const regex = new RegExp(`${escape_regex(start)}[\\s\\S]*?${escape_regex(end)}`);
	if (!regex.test(content)) { throw new Error(`Markers not found: crud:${marker_name}. Run with --force first to initialize.`); }
	return content.replace(regex, `${start}\n${new_content}\n${end}`);
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
		const tag = fallback[1];
		if (tag === "input") {
			const type_match = /type="([^"]*)"/.exec(fallback[2]);
			return type_match ? `input:${type_match[1]}` : "input:text";
		}
		return tag;
	}
	const tag = match[1];
	if (tag === "input") {
		const type_match = /type="([^"]*)"/.exec(match[2]);
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

/**
 * Smart merge: diff existing field-wrappers (by data-field attribute) against new field blocks.
 * - Existing fields with same template type -> compare element signatures; if they differ in attributes, use new block
 * - Existing fields with same template type AND same element signature -> keep the old block (preserving user customizations)
 * - Existing fields with CHANGED template type -> use the new block (field type changed in schema)
 * - Removed fields -> delete the old block
 * - New fields -> append at the end
 * Non-field elements (layout divs, whitespace) between field-wrappers are preserved untouched.
 */
export function smart_merge_fields(old_section: string, new_field_blocks: string[]): string {
	// Parse existing field-wrappers by data-field name
	const field_regex = /<field-wrapper[^>]*data-field="([^"]*)"[^>]*>[\s\S]*?<\/field-wrapper>/g;
	const old_field_info = new Map(); // name → full block text
	let match: RegExpExecArray | null;
	while ((match = field_regex.exec(old_section)) !== null) {
		old_field_info.set(match[1], match[0]);
	}

	// Parse new field blocks: extract data-field names, build map + template IDs
	const new_field_map = new Map();
	const new_template_ids = new Map();
	for (const block of new_field_blocks) {
		const name_match = block.match(/data-field="([^"]*)"/);
		if (name_match) {
			new_field_map.set(name_match[1], block);
			new_template_ids.set(name_match[1], get_field_template_id(block));
		}
	}

	// Step 1: Replace old field-wrappers
	// - If field still exists AND template type matches AND element signature matches -> keep old block
	// - If field still exists BUT template type changed OR element attributes changed -> use new block
	// - If field removed -> delete (replace with empty)
	let result = old_section.replace(/<field-wrapper[^>]*data-field="([^"]*)"[^>]*>[\s\S]*?<\/field-wrapper>/g, (_full, field_name: string) => {
		if (!new_field_map.has(field_name)) return ""; // deleted
		const new_block = new_field_map.get(field_name)!;
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
		// Same template type, same element signature - keep old block (preserves customizations)
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

// ---------------------------------------------------------------------------
// Foreign Key detection
// ---------------------------------------------------------------------------

export function extract_foreign_keys(fields: FieldDef[], generated_fields?: Record<string, any> | null): ForeignKeyMap {
	const fk_map = new Map();

	for (const field of fields) {
		// Only extract FK info for field types that render as FK selects/autocompletes.
		// If a user overrides a FK field's type to e.g. "number", skip FK handling.
		if (field.type !== "select" && field.type !== "autocomplete") continue;

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
