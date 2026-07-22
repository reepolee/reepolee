import {
	BOOLEAN_PREFIXES,
	COL_WIDTH_AUTO,
	COL_WIDTH_INTEGER,
	CURRENCY_FIELD,
	IGNORE_INDEX_FIELDS,
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

	const fieldInterface = `Record<string, FormFieldDef>`;

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

export interface WriteTableConfig {
	dir: string;
	schema_obj: SchemaObject;
	type_mapper: TypeMapper;
	all_tables_columns?: Map<string, string[]>;
	all_tables_indexes?: Map<string, Set<string>>;
	all_schemas?: SchemaObject[];
	pagination_strategy?: "cursor" | "offset";
	render_strategy?: "stream" | "load";
}

export async function write_table_file(config: WriteTableConfig): Promise<void> {
	const { dir, schema_obj, type_mapper, all_tables_columns, all_tables_indexes, all_schemas, pagination_strategy = "offset", render_strategy = "load" } = config;
	const exists = await Bun.file(`${dir}/schema/table.ts`).exists();
	if (exists) return;

	const fields_obj = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);

	// Split fields into active (shown in index) and commented (CU - hidden, but easy to enable)
	function is_index_field(f: FormFieldDef): boolean { return f.attributes?.omit !== true && !IGNORE_INDEX_FIELDS.includes(f.name); }

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

	// Helper: check if an FK _id field has a corresponding display name field in the view
	// (e.g. author_id -> author_name). When found, the _id field gets grid: false so it's
	// hidden from the index grid but still available for filtering.
	function has_name_field_for_fk(f: FormFieldDef): boolean {
		if (!f.name.endsWith("_id") || !f.attributes?.foreign_key) return false;
		const stem = f.name.slice(0, -3);
		return [...active_fields, ...v_active_fields].some((ff) => ff.name === `${stem}_name`);
	}

	// Use the larger set of active field names so we have enough columns for both views
	const source_fields = v_active_fields.length >= active_fields.length ? v_active_fields : active_fields;
	const source_commented = v_commented_fields.length >= commented_fields.length ? v_commented_fields : commented_fields;

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

	// Build columns as a string so we can include commented-out entries
	const columns_lines: string[] = ["{"];
	columns_lines.push(`  "checkbox": { width: "${COL_WIDTH_INTEGER}", class: "text-center" },`);
	columns_lines.push(`  "id": { width: "${COL_WIDTH_INTEGER}", class: "" },`);
	for (const f of source_fields) {
		if (f.name === "id" || f.name === "checkbox") continue;
		const width = f.attributes?.initial_width || COL_WIDTH_AUTO;
		const cls = column_class(f);
		const domain = f.attributes?.domain_type;
		const compliant = f.attributes?.domain_compliant;
		const domain_prop = domain ? `, domain: "${domain}"` : "";

		// Auto-detect FK _id fields with a corresponding display name field in the view.
		// Hide them from the grid (grid: false) but keep them filterable (filter: true).
		const is_auto_hidden_fk = has_name_field_for_fk(f);
		const filter_val = is_auto_hidden_fk || f.attributes?.filter;
		const filter_prop = filter_val ? ", filter: true" : "";
		const grid_prop = is_auto_hidden_fk ? ", grid: false" : "";

		const mismatch_comment = domain_mismatch_comment(f, domain, compliant);
		columns_lines.push(`  "${f.name}": { width: "${width}", class: "${cls}"${domain_prop}${filter_prop}${grid_prop} },${mismatch_comment}`);
	}
	// CU fields commented out for easy re-enabling
	for (const f of source_commented) {
		if (f.name === "id" || f.name === "checkbox") continue;
		const width = f.attributes?.initial_width || COL_WIDTH_AUTO;
		const cls = column_class(f);
		const domain = f.attributes?.domain_type;
		const compliant = f.attributes?.domain_compliant;
		const domain_prop = domain ? `, domain: "${domain}"` : "";

		// CU fields are commented-out but still need filter detection for the comment
		const is_auto_hidden_fk = has_name_field_for_fk(f);
		const filter_val = is_auto_hidden_fk || f.attributes?.filter;
		const filter_prop = filter_val ? ", filter: true" : "";
		const grid_prop = is_auto_hidden_fk ? ", grid: false" : "";

		const mismatch_comment = domain_mismatch_comment(f, domain, compliant);
		columns_lines.push(
			`  // "${f.name}": { width: "${width}", class: "${cls}"${domain_prop}${filter_prop}${grid_prop} },${mismatch_comment}`
		);
	}
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

	// Field type is now controlled via DB column comments - put "autocomplete" or "textarea"
	// directly in the column comment to set the field type. JSON-style comments
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
const columns: Record<string, { width: string; class: string; domain?: string; filter?: boolean; grid?: boolean }> = ${columns_str}

// Route param for URL paths - change to a different column for URL obscurity.
${route_param_export}

// Enable/disable delete functionality (bulk delete + record delete).
// Set to true to enable delete for this table. Children in nested CRUD always have delete enabled.
const enable_delete = false;

// Pagination strategy: "cursor" (keyset-based) or "offset" (LIMIT/OFFSET).
// Cursor is best for real-time tables, offset for numbered navigation.
// Set at schema generation time via reeman or --pagination flag.
const pagination_strategy: "cursor" | "offset" = "${pagination_strategy}";

// Render strategy: "load" (synchronous, full page after DB query) or "stream" (progressive via DPU).
// Streaming sends the page shell immediately, then streams records and pagination
// as <template for> chunks after DB queries resolve.
const render_strategy: "stream" | "load" = "${render_strategy}";
${parent_export_block}export { columns, route_param, enable_delete, pagination_strategy, render_strategy };
`;

	await Bun.write(`${dir}/schema/table.ts`, content);
}
