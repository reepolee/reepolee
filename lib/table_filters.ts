/**
 * Table Filters - filter definition, WHERE clause generation, and tag option loading.
 *
 * Pure functions operate on schema metadata and URL params.
 * load_tags_filter_options() queries the database to load tag filter options.
 */

import { db } from "$config/db";
import { BOOLEAN_PREFIXES } from "$config/db_structure";
import { timed_query } from "$lib/timed_sql";
import type { FormFieldDef } from "$generator/schema/types";

export type FilterType = "fk" | "text" | "number" | "boolean" | "tags";

export interface FilterDef {
	key: string;
	type: FilterType;
	label: string;
	fk_table?: string;
	fk_column?: string;
	fk_text_field?: string;
}

export interface ResolvedFilter {
	column: string;
	clause: string;
	params: any[];
}

// Display-oriented filter def with pre-computed UI fields for the <ree-filters> component.
export interface EnrichedFilterDef extends FilterDef {
	display_label: string;
	visible_options: { option_value: string; option_text: string; }[];
	hidden_options: { option_value: string; option_text: string; }[];
	has_more: boolean;
	checked_values: string[];
	is_not: boolean;
	current_value: string;
}

/**
 * Enrich raw FilterDef[] with display-oriented fields the <ree-filters> component needs.
 *
 * Each def gets:
 * - display_label: translated label from labels (falls back to def.label -> def.key)
 * - visible_options / hidden_options: first 7 FK/tag options, rest hidden behind "Show more"
 * - has_more: true when options > 7
 * - checked_values: which options are currently selected from URL params
 * - is_not: whether the filter_not checkbox is active
 * - current_value: raw URL param value for text/number/boolean filters
 */
export function enrich_filter_definitions(
	filter_definitions: FilterDef[],
	labels: Record<string, string>,
	filter_params: Record<string, string>,
	filter_not_params: Record<string, string>,
	filter_options: Record<string, { option_value: string; option_text: string; }[]>,
): EnrichedFilterDef[] {
	return filter_definitions.map((def) => {
		const options = filter_options[def.key] || [];
		const visible = options.slice(0, 7);
		const hidden = options.slice(7);
		const current = filter_params[def.key] || "";
		const checked = def.type === "fk" || def.type === "tags" ? current.split(",")
			.filter(Boolean)
			.map((v) => v.replace(/^!/, "")) : current ? [current] : [];

		return {
			...def,
			display_label: labels[def.key] || def.label || def.key,
			visible_options: visible,
			hidden_options: hidden,
			has_more: hidden.length > 0,
			checked_values: checked,
			is_not: filter_not_params[def.key] === "1",
			current_value: current,
		};
	});
}

/**
 * Build FilterDef[] from schema form field definitions and columns metadata.
 *
 * For each column with `filter: true`:
 * - If FK -> type "fk", extract fk_table, fk_column
 * - If boolean domain -> type "boolean"
 * - If tags field (attributes.tags exists) -> type "tags"
 * - If boolean-named column (is_, has_, can_ prefix) -> type "boolean"
 * - If field type is "number" -> type "number"
 * - Otherwise -> type "text"
 */
export function get_filter_definitions(columns: Record<string, { domain?: string; filter?: boolean; grid?: boolean; }>, fields: Record<string, FormFieldDef>): FilterDef[] {
	const defs: FilterDef[] = [];

	for (const [col_name, col_meta] of Object.entries(columns)) {
		// Include in filter defs if explicitly filterable OR hidden from grid (grid: false)
		if (!col_meta.filter && col_meta.grid !== false) continue;

		const field = fields[col_name];
		if (!field) continue;

		const label = field.attributes?.label || col_name.replace(/_/g, " ");
		const attrs = field.attributes || {};

		if (attrs.foreign_key) {
			defs.push({
				key: col_name,
				type: "fk",
				label,
				fk_table: attrs.foreign_key.table,
				fk_column: attrs.foreign_key.column,
			});
		} else if (attrs.domain_type === "boolean" || col_meta.domain === "boolean" || BOOLEAN_PREFIXES.some((p) => col_name.startsWith(p))) {
			defs.push({ key: col_name, type: "boolean", label });
		} else if (attrs.tags) {
			defs.push({ key: col_name, type: "tags", label });
		} else if (field.type === "number") {
			defs.push({ key: col_name, type: "number", label });
		} else {
			defs.push({ key: col_name, type: "text", label });
		}
	}

	return defs;
}

/**
 * Parse URL params and build parameterized WHERE clauses for active filters.
 *
 * URL param format: `?filter_<key>=<values>`
 * - FK/tags: comma-separated values, prefix `!` for NOT IN
 * - Boolean: "1" for true
 * - Text: raw value (wrapped in `%term%`)
 * - Number: exact match
 *
 * Negation: `?filter_not_<key>=1` inverts the clause (NOT IN, !=, NOT LIKE)
 */
export function resolve_filters(filter_definitions: FilterDef[], url_params: Record<string, string>, filter_not: Record<string, string> = {}): ResolvedFilter[] {
	const resolved: ResolvedFilter[] = [];

	for (const def of filter_definitions) {
		const raw = url_params[def.key];
		if (!raw) continue;
		const negate = filter_not[def.key] === "1";

		if (def.type === "fk") {
			const raw_values = raw.split(",").filter(Boolean);
			// ! prefix negates individual values; filter_not toggles whole filter
			const negated = raw_values.filter((v) => v.startsWith("!")).map((v) => v.slice(1));
			const included = raw_values.filter((v) => !v.startsWith("!"));

			if (negated.length > 0) {
				const placeholders = negated.map(() => "?").join(", ");
				if (negate) {
					resolved.push({
						column: def.key,
						clause: `${def.key} IN (${placeholders})`,
						params: negated,
					});
				} else {
					resolved.push({
						column: def.key,
						clause: `${def.key} NOT IN (${placeholders})`,
						params: negated,
					});
				}
			}
			if (included.length > 0) {
				const placeholders = included.map(() => "?").join(", ");
				if (negate) {
					resolved.push({
						column: def.key,
						clause: `${def.key} NOT IN (${placeholders})`,
						params: included,
					});
				} else {
					resolved.push({
						column: def.key,
						clause: `${def.key} IN (${placeholders})`,
						params: included,
					});
				}
			}
		} else if (def.type === "boolean") {
			if (negate) {
				resolved.push({ column: def.key, clause: `${def.key} != ?`, params: [raw] });
			} else {
				resolved.push({ column: def.key, clause: `${def.key} = ?`, params: [raw] });
			}
		} else if (def.type === "text") {
			if (negate) {
				resolved.push({ column: def.key, clause: `${def.key} NOT LIKE ?`, params: [`%${raw}%`] });
			} else {
				resolved.push({ column: def.key, clause: `${def.key} LIKE ?`, params: [`%${raw}%`] });
			}
		} else if (def.type === "number") {
			if (negate) {
				resolved.push({ column: def.key, clause: `${def.key} != ?`, params: [raw] });
			} else {
				resolved.push({ column: def.key, clause: `${def.key} = ?`, params: [raw] });
			}
		} else if (def.type === "tags") {
			const raw_values = raw.split(",").filter(Boolean);
			const negated = raw_values.filter((v) => v.startsWith("!")).map((v) => v.slice(1));
			const included = raw_values.filter((v) => !v.startsWith("!"));

			if (negated.length > 0) {
				const tag_clauses = negated.map(() => `FIND_IN_SET(?, ${def.key})`);
				const combined = tag_clauses.join(" OR ");
				if (negate) {
					resolved.push({ column: def.key, clause: combined, params: negated });
				} else {
					resolved.push({ column: def.key, clause: `NOT (${combined})`, params: negated });
				}
			}
			if (included.length > 0) {
				const tag_clauses = included.map(() => `FIND_IN_SET(?, ${def.key})`);
				const combined = tag_clauses.join(" OR ");
				if (negate) {
					resolved.push({ column: def.key, clause: `NOT (${combined})`, params: included });
				} else {
					resolved.push({ column: def.key, clause: combined, params: included });
				}
			}
		}
	}

	return resolved;
}

/**
 * Load filter options for tags columns from the translations table.
 *
 * Tags fields (e.g. `modules_tags`) contain comma-separated keys like "admin,default".
 * Their display labels come from the translations table, not from the referenced DB table.
 *
 * Translations are stored as:
 * (namespace="system.users", key_path="modules_tags.admin", translation="Admin")
 *
 * @param namespace - The route's translation namespace (e.g. "system.users")
 * @param lang - The current language code (e.g. "en")
 */
export async function load_tags_filter_options(filter_definitions: FilterDef[], fields: Record<string, FormFieldDef>, namespace: string, lang: string): Promise<Record<string, { option_value: string; option_text: string; }[]>> {
	const options: Record<string, { option_value: string; option_text: string; }[]> = {};

	for (const def of filter_definitions) {
		if (def.type !== "tags") continue;

		const field = fields[def.key];
		if (!field?.attributes?.tags?.table) continue;

		try {
			const records = await timed_query(namespace, "load_tags_filter_options", async () => {
				const pattern = `${def.key}.%`;
				const result = await db`SELECT key_path, translation FROM translations WHERE namespace = ${namespace} AND key_path LIKE ${pattern} AND lang = ${lang} ORDER BY translation ASC`;
				return (result as { key_path: string; translation: string; }[]).map((r) => ({
					option_value: r.key_path.replace(`${def.key}.`, ""),
					option_text: r.translation,
				}));
			});
			options[def.key] = records;
		} catch (error) {
			console.error(`Error loading tag filter options for ${def.key}:`, error);
			options[def.key] = [];
		}
	}

	return options;
}
