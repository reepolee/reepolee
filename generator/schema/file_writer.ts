import { join, relative } from "node:path";
import { slugify } from "$lib/route_map";

import { singularize } from "../naming";

import { capitalize_label, generate_fields_object } from "./field_generator";
import type { TypeMapper } from "./type_mapper";
import type { SchemaObject } from "./types";

// Table and validation writers live in dedicated modules; re-exported here so
// the historical import surface (schema.ts, refresh_fields.ts, etc.) is stable.
export { write_table_file, write_table_generated_file } from "./write_table";
export type { WriteTableConfig } from "./write_table";
export { write_validation_file } from "./write_validation";

// Flatten a nested JSON object into [key_path, value] entries.
function flatten_object(obj: Record<string, any>, prefix: string = ""): [string, string][] {
	const entries: [string, string][] = [];
	for (const key of Object.keys(obj)) {
		const val = obj[key];
		const path = prefix ? `${prefix}.${key}` : key;
		if (val && typeof val === "object" && !Array.isArray(val)) {
			entries.push(...flatten_object(val, path));
		} else if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
			entries.push([path, String(val)]);
		}
	}
	return entries;
}

export async function write_translation_files(
	dir: string,
	schema_obj: SchemaObject,
	type_mapper: TypeMapper,
	all_tables_columns: Map<string, string[]> | undefined,
	all_tables_indexes: Map<string, Set<string>> | undefined,
	route_name: string = "",
): Promise<void> {
	const fields = generate_fields_object(schema_obj, type_mapper, all_tables_columns, all_tables_indexes);
	const singular = singularize(schema_obj.name);

	// For FK fields, strip the _id suffix for a clean label.
	// E.g. author_id -> "Author", reviewer_id -> "Reviewer"
	function label_for_field(k: string): string {
		const field = fields[k];
		if (field?.attributes?.foreign_key) { return capitalize_label(k.replace(/_id$/, "")); }
		return capitalize_label(k);
	}

	// Check if any column has filter: true
	const has_filterable = Object.values(fields).some((f) => f.attributes?.filter === true);

	const en_json: any = {
		route_name: slugify(route_name || schema_obj.name),
		labels: Object.fromEntries(Object.keys(fields).map((k) => [k, label_for_field(k)])),
		actions: { [`new_${singular}`]: `New ${capitalize_label(singular)}` },
		ui: {
			title: capitalize_label(singular),
			no_records: `No ${schema_obj.name.replace(/_/g, " ")} found.`,
			modifying: "You are about to modify",
			records: "record(s)",
			...(has_filterable ? {
				filters: "Filters",
				apply_filters: "Apply",
				clear_all: "Clear all",
			} : {}),
		},
	};

	if (schema_obj.view_columns) {
		const v_fields = generate_fields_object({
			type: "view",
			name: schema_obj.name,
			columns: schema_obj.view_columns,
			foreign_keys: [],
			has_view: false,
		}, type_mapper, all_tables_columns, all_tables_indexes);
		en_json.v_labels = Object.fromEntries(Object.keys(v_fields).map((k) => [k, capitalize_label(k)]));
	}

	// Compute namespace from route directory
	const rel_path = relative(join(process.cwd(), "routes"), dir);
	const namespace = rel_path.replace(/\\/g, "/")
		.split("/")
		.filter((p) => p !== "translations")
		.join(".");

	// Flatten and write to DB - only for English.
	// Other languages will be populated by sync_translations --translate via AI.
	const flat = flatten_object(en_json);
	const { db_cli } = await import("../../config/db_cli");
	for (const [key_path, value] of flat) {
		try {
			await db_cli`DELETE FROM translations WHERE lang = 'en' AND namespace = ${namespace} AND key_path = ${key_path}`;
			await db_cli`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ('en', ${namespace}, ${key_path}, ${value})`;
		} catch (err) {
			console.error(`    ❌ Failed to upsert en:${namespace}:${key_path}:`, err instanceof Error ? err.message : err);
		}
	}

	console.log(`📄 Wrote ${flat.length} translation keys to DB (namespace: "${namespace}")`);
}
