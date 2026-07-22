import {
	BOOLEAN_PREFIXES,
	COL_WIDTH_AUTO,
	COL_WIDTH_BOOLEAN,
	COL_WIDTH_DECIMAL,
	COL_WIDTH_IMAGE,
	COL_WIDTH_INTEGER,
	COL_WIDTH_STRING_MAX_CH,
	COL_WIDTH_TEMPORAL,
	CURRENCY_FIELD,
	IGNORE_INDEX_FIELDS,
	IMAGE_SUFFIXES,
	MAINTENANCE_FIELDS,
	PERCENT_FIELD,
} from "$config/db_structure";
import { DOMAIN_TYPES as MYSQL_DT } from "$config/domain_types/mysql";
import { DOMAIN_TYPES as SQLITE_DT } from "$config/domain_types/sqlite";
import { db_type } from "$lib/resolve_db_type";

import type { TypeMapper } from "./type_mapper";
import type { ColumnAttributes, FormFieldDef, SchemaObject } from "./types";

// Per-dialect domain type map selected at import time.
const DOMAIN_TYPE_MAP = { mysql: MYSQL_DT, sqlite: SQLITE_DT } as const;

// ---------------------------------------------------------------------------
// Missing index warnings collector - deduplicates warnings so each
// (table.column) pair is printed once, even when generate_fields_object()
// is called multiple times per table (e.g. for generated.ts, table.ts, etc.)
// ---------------------------------------------------------------------------

const _missing_index_warnings = new Set();

/**
 * Get all collected missing index warnings, clear the accumulator, and return them.
 */
export function get_and_clear_missing_index_warnings(): string[] {
	const result = Array.from(_missing_index_warnings);
	_missing_index_warnings.clear();
	return result;
}

/**
 * Clear any accumulated warnings without returning them.
 */
export function clear_missing_index_warnings(): void { _missing_index_warnings.clear(); }

/**
 * Look up the canonical SQL type for a domain in the active dialect's DOMAIN_TYPES map.
 * Returns null when the domain is unknown.
 */
export function canonical_sql_for_domain(domain: string): string | null {
	const dt_map = DOMAIN_TYPE_MAP[db_type];
	return (dt_map as Record<string, string>)[domain] ?? null;
}

type DomainTypeEntry = { domain: string | null; compliant: boolean; };

function normalize_sql(sql: string): string { return sql.toLowerCase()
	.replace(/\s+/g, " ")
	.trim(); }

/**
 * Match a column against the canonical DOMAIN_TYPES taxonomy.
 *
 * Strategy:
 * 1. Name-based: if the column name matches a domain type key (e.g. `email`),
 * assign that domain and check if the actual SQL matches the canonical SQL.
 * 2. Prefix/suffix heuristics: `is_*`/`has_*`/`can_*` -> boolean;
 * `_on`/`_by` -> date_only; `_at` -> timestamp; `_image` -> image.
 * 3. SQL-based: if the actual SQL type matches any canonical SQL value,
 * assign the matching domain type.
 *
 * Returns `{ domain: null, compliant: false }` when no match is found.
 */
export function resolve_domain_type(column_name: string, column_type: string): DomainTypeEntry {
	const dt_map = DOMAIN_TYPE_MAP[db_type];
	const lower_name = column_name.toLowerCase();
	const normalized_type = normalize_sql(column_type);

	// 1. Name-based direct match
	if (lower_name in dt_map) {
		const canonical_sql = (dt_map as Record<string, string>)[lower_name];
		return { domain: lower_name, compliant: normalized_type === normalize_sql(canonical_sql) };
	}

	// 2. Prefix/suffix heuristics
	for (const prefix of BOOLEAN_PREFIXES) {
		if (lower_name.startsWith(prefix)) {
			const canonical_sql = (dt_map as Record<string, string>).boolean;
			return { domain: "boolean", compliant: normalized_type === normalize_sql(canonical_sql) };
		}
	}

	if (lower_name.endsWith("_on") || lower_name.endsWith("_by")) {
		const canonical_sql = (dt_map as Record<string, string>).date_only;
		return { domain: "date_only", compliant: normalized_type === normalize_sql(canonical_sql) };
	}

	if (lower_name.endsWith("_at")) {
		const canonical_sql = (dt_map as Record<string, string>).timestamp;
		return { domain: "timestamp", compliant: normalized_type === normalize_sql(canonical_sql) };
	}

	if (IMAGE_SUFFIXES.some((suffix) => lower_name.endsWith(suffix))) {
		const canonical_sql = (dt_map as Record<string, string>).image;
		return { domain: "image", compliant: normalized_type === normalize_sql(canonical_sql) };
	}

	// 3. SQL value match (catch-all for any column whose type matches a canonical SQL)
	for (const [name, sql] of Object.entries(dt_map)) {
		if (normalized_type === normalize_sql(sql)) { return { domain: name, compliant: true }; }
	}

	return { domain: null, compliant: false };
}

export function parse_comment_attributes(comment: string): ColumnAttributes {
	if (!comment) return {};
	const json_match = comment.match(/\{([^}]+)\}/);
	if (!json_match) return {};

	try {
		const json_str = `{${json_match[1]}}`;
		const fixed_json = json_str.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, "$1\"$2\":").replace(/:([^"]+?)([,"}])/g, (match, value, terminator) => {
			const val = value.trim();
			if (!Number.isNaN(Number(val)) || val === "null" || val === "true" || val === "false") { return `: ${val}${terminator}`; }
			return `: "${val}"${terminator}`;
		});
		return JSON.parse(fixed_json);
	} catch {
		return {};
	}
}

export function infer_table_name(column_name: string): string {
	const base = column_name.replace(/_id$/i, "");
	if (base.endsWith("y")) return `${base.slice(0, -1)}ies`;
	if (base.endsWith("s")) return `${base}es`;
	return `${base}s`;
}

/**
 * Build a lookup map of table names to their column names from all schemas.
 * Used for implicit FK detection via naming convention.
 */
export function build_table_column_map(schemas: SchemaObject[]): Map<string, string[]> {
	const map = new Map();
	for (const schema of schemas) {
		if (schema.type === "table") {
			// Normalize to lowercase for case-insensitive matching
			map.set(schema.name, schema.columns.map((c) => c.name.toLowerCase()));
		}
	}
	return map;
}

/**
 * Singularize an English plural word.
 * Duplicated here (also in file_writer.ts) to avoid circular imports.
 */
function singularize(word: string): string {
	const lower = word.toLowerCase();

	const irregulars: Record<string, string> = { people: "person", children: "child" };

	if (irregulars[lower]) return irregulars[lower];
	if (lower.endsWith("ies")) return `${word.slice(0, -3)}y`;
	if (lower.endsWith("ves")) return `${word.slice(0, -3)}f`;
	if (lower.match(/(s|x|z|ch|sh)es$/)) return word.slice(0, -2);
	if (lower.endsWith("s") && !lower.endsWith("ss")) return word.slice(0, -1);
	return word;
}

export function apply_index_nullable(fields: FormFieldDef[]): void {
	for (const f of fields) {
		if (IGNORE_INDEX_FIELDS.includes(f.name)) {
			f.attributes = { ...(f.attributes || {}), nullable: true };
			f.required = false;
		}
	}
}

export function generate_fields_object(schema_obj: SchemaObject, type_mapper: TypeMapper, all_tables_columns?: Map<string, string[]>, all_tables_indexes?: Map<string, Set<string>>): Record<string, FormFieldDef> {
	const fields: Record<string, FormFieldDef> = {};

	for (const col of schema_obj.columns) {
		if (schema_obj.type === "table" && col.is_primary_key && col.is_auto_increment) continue;
		if (schema_obj.type === "view" && col.name === "id") continue;
		// Skip generated columns for tables - they can't be saved from forms
		if (schema_obj.type === "table" && col.is_generated) continue;

		const attributes = parse_comment_attributes(col.comment);
		// Store original column type for downstream consumers (e.g. currency detection)
		attributes.column_type = col.type_string;

		// Detect ICU/CU/F visibility flags from plain-text column comment.
		// "CU" (standalone, not inside "ICU") means the field is excluded from index lists
		// but still visible in create and update forms.
		// "ICU" is the default - visible in Index, Create, and Update.
		// "F" means the field is filterable in the index page filter panel.
		if (col.comment) {
			const has_cu = /\bCU\b/.test(col.comment);
			const has_icu = /\bICU\b/.test(col.comment);
			if (has_cu && !has_icu) { attributes.omit_index = true; }
			// Detect F flag: standalone \bF\b or combined with ICU/CU (e.g. ICUF, CUF)
			const has_f = /\bF\b/.test(col.comment) || /I?CUF/.test(col.comment);
			if (has_f) { attributes.filter = true; }
		}

		if (attributes.omit === true || MAINTENANCE_FIELDS.includes(col.name.toLowerCase())) continue;

		let field_type = type_mapper.to_html_input(col.type_string);
		const col_name_lower = col.name.toLowerCase();

		const explicit_fk = (schema_obj.foreign_keys || []).find((fk) => fk?.column_name?.toLowerCase?.() === col_name_lower);

		let is_fk = false;
		let fk_table: string | null = null;
		let fk_column: string = "id";

		if (explicit_fk) {
			is_fk = true;
			fk_table = explicit_fk.referenced_table_name;
			fk_column = explicit_fk.referenced_column_name;
		}

		// Detect implicit FK via {singular_table}_{column} naming convention
		// This also catches _id suffix columns (e.g. legal_entity_id -> legal_entities.id)
		// and verifies the target table+column actually exist in the schema.
		if (!is_fk && all_tables_columns) {
			for (const [table_name, columns] of all_tables_columns) {
				const singular_name = singularize(table_name);
				const prefix = `${singular_name}_`;
				if (col_name_lower.startsWith(prefix)) {
					const candidate_column = col_name_lower.slice(prefix.length);
					if (columns.includes(candidate_column)) {
						is_fk = true;
						fk_table = table_name;
						fk_column = candidate_column;

						// Check indexes on both sides of the implicit FK and warn if missing
						if (all_tables_indexes) {
							const source_index_set = all_tables_indexes.get(schema_obj.name);
							const target_index_set = all_tables_indexes.get(table_name);

							if (!source_index_set?.has(col.name.toLowerCase())) {
								_missing_index_warnings.add(
									`⚠️  Missing index: ${schema_obj.name}.${col.name} is used as an implicit FK referencing ${table_name}.${candidate_column}, but has no index on the source column. Add an INDEX to improve JOIN performance.`
								);
							}
							if (!target_index_set?.has(candidate_column)) {
								_missing_index_warnings.add(
									`⚠️  Missing index: ${table_name}.${candidate_column} is referenced as an FK target from ${schema_obj.name}.${col.name}, but has no index on the target column. Add an INDEX to improve JOIN performance.`
								);
							}
						}

						break;
					}
				}
			}
		}

		// Fallback: _id suffix heuristic when the column map is not available
		// or when the implicit rule didn't find a match.
		// This is less accurate (guesses the table name without verification).
		if (!is_fk && col_name_lower.endsWith("_id")) {
			is_fk = true;
			fk_table = infer_table_name(col_name_lower);

			// Check index on the _id source column and warn if missing
			if (all_tables_indexes) {
				const source_index_set = all_tables_indexes.get(schema_obj.name);
				if (!source_index_set?.has(col.name.toLowerCase())) {
					_missing_index_warnings.add(
						`⚠️  Missing index: ${schema_obj.name}.${col.name} is treated as an FK (via _id suffix) referencing ${fk_table}.id, but has no index. Add an INDEX to improve JOIN performance.`
					);
				}
			}
		}

		if (is_fk) {
			field_type = "select";
			attributes.foreign_key = { table: fk_table!, column: fk_column };
			// Store the original DB column type so validation generator
			// can pick the correct Zod type (string vs number) for FK fields
			attributes.fk_type = type_mapper.to_typescript(col.type_string);
		}

		// Detect _tags suffix - auto-tags referencing the prefix table.
		// Only auto-detect if not already explicitly set via column comment.
		const tags_match = col.name.match(/^(.+)_tags$/);
		if (tags_match) {
			field_type = "tags";
			if (!attributes.tags) { attributes.tags = { table: tags_match[1] }; }
		}

		// Detect _image suffix - stores an uploaded image path, rendered via <image-upload>
		// in forms and as a thumbnail in grids. Only auto-detect if not explicitly set.
		if (IMAGE_SUFFIXES.some((suffix) => col.name.toLowerCase().endsWith(suffix)) && !attributes.type) { field_type = "image"; }

		// Parse max length from type_string for string types (e.g. varchar(255))
		// Only apply when the user hasn't explicitly set max via column comment
		let max = attributes.max;
		if (max === undefined && field_type === "text") {
			const varchar_match = col.type_string.match(/^varchar\((\d+)\)$/i);
			if (varchar_match) { max = Number(varchar_match[1]); }
		}

		// Plain-word column comment detection - if the comment is a single known type name,
		// override the field type. This lets users set the type via DB comment.
		// JSON-style comments ({type: "autocomplete"}) still take precedence via attributes.type above.
		const comment_text = col.comment?.trim().toLowerCase();
		if (comment_text === "autocomplete" || comment_text === "textarea") { field_type = comment_text; }

		// Resolve domain type and compliance
		const { domain, compliant } = resolve_domain_type(col.name, col.type_string);
		attributes.domain_type = domain;
		attributes.domain_compliant = compliant;

		// Compute initial column width and CSS class for grid display
		const field_def = {
			name: col.name,
			type: attributes.type || field_type,
			required: !col.is_nullable,
			is_nullable: col.is_nullable,
			min: attributes.min,
			max,
			attributes,
		};
		const initial_width = compute_initial_width(field_def);
		const initial_class = compute_initial_class(field_def);
		attributes.initial_width = initial_width;
		attributes.initial_class = initial_class;

		fields[col.name] = field_def;
	}

	return fields;
}

/**
 * Compute the initial column width for a grid display based on field type and constraints.
 *
 * - Boolean-prefixed names (BOOLEAN_PREFIXES) -> COL_WIDTH_BOOLEAN
 * - Decimal/numeric types -> COL_WIDTH_DECIMAL
 * - Integer types -> COL_WIDTH_INTEGER
 * - Boolean -> COL_WIDTH_BOOLEAN
 * - Temporal types -> COL_WIDTH_TEMPORAL
 * - String types with known max length -> {max}ch (capped at COL_WIDTH_STRING_MAX_CH)
 * - Everything else -> COL_WIDTH_AUTO
 */
export function compute_initial_width(field: FormFieldDef): string {
	const column_type = field.attributes?.column_type?.toLowerCase() || "";
	const field_type = field.type || "";

	// Strip parenthesized precision/scale for type matching (e.g. "decimal(18,2)" -> "decimal")
	const type_base = column_type.replace(/\(.*\)/, "").trim();

	// Boolean-prefixed names first - these are stored as tinyint(1) and would
	// otherwise be claimed by the integer branch below.
	const field_name = field.name || "";
	const is_boolean_name = BOOLEAN_PREFIXES.some((prefix) => field_name.startsWith(prefix));
	if (is_boolean_name) { return COL_WIDTH_BOOLEAN; }

	// Decimal/numeric types
	const decimal_types = ["decimal", "numeric", "float", "double", "real"];
	if (decimal_types.includes(type_base)) { return COL_WIDTH_DECIMAL; }

	// Integer types
	const integer_types = ["int", "integer", "tinyint", "smallint", "mediumint", "bigint", "serial"];
	if (integer_types.includes(type_base)) { return COL_WIDTH_INTEGER; }

	// Boolean
	if (field_type === "checkbox" || /bool|boolean/.test(column_type)) { return COL_WIDTH_BOOLEAN; }

	// Image thumbnail - fixed width for the 100x100 preview
	if (field_type === "image") { return COL_WIDTH_IMAGE; }

	// Try extracting max from varchar/char type_string (e.g. varchar(255), char(10))
	const varchar_match = column_type.match(/^(?:var)?char\s*\((\d+)\)/);
	if (varchar_match) {
		const max = Number(varchar_match[1]);
		return `${Math.min(max, COL_WIDTH_STRING_MAX_CH)}ch`;
	}

	// Temporal types (date, datetime, timestamp, time)
	if (field_type === "date" || field_type === "datetime" || field_type === "timestamp" || field_type === "time") { return COL_WIDTH_TEMPORAL; }

	// For string/text types, use the parsed max (from max attribute or column comment)
	if (field.max && (field_type === "text" || field_type === "textarea" || field_type === "email" || field_type === "url" || field_type === "tel" || field_type === "password")) {
		const max = Number(field.max);
		return `${Math.min(max, COL_WIDTH_STRING_MAX_CH)}ch`;
	}

	return COL_WIDTH_AUTO;
}

/**
 * Compute the CSS class for a grid column based on field type.
 *
 * - Currency (CURRENCY_FIELD) and percent (PERCENT_FIELD) columns -> "text-right"
 * - Boolean (BOOLEAN_PREFIXES) columns -> "text-center"
 * - Everything else -> ""
 */
export function compute_initial_class(field: FormFieldDef): string {
	const column_type = field.attributes?.column_type?.toLowerCase() || "";
	const name = field.name || "";

	// Currency/percent -> text-right (compare full type string like "decimal(18,2)")
	if (column_type === CURRENCY_FIELD.toLowerCase() || column_type === PERCENT_FIELD.toLowerCase()) { return "text-right"; }

	// Boolean fields -> text-center
	if (BOOLEAN_PREFIXES.some((prefix) => name.startsWith(prefix))) { return "text-center"; }

	return "";
}

export function capitalize_label(name: string): string { return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
