import { join } from "node:path";

import { BOOLEAN_PREFIXES, MAINTENANCE_FIELDS } from "$config/db_structure";

import { capitalize_first } from "./naming";
import type { FieldDef } from "./crud/types";

// Shared validation generation utilities
export function is_boolean_field(name: string): boolean { return BOOLEAN_PREFIXES.some((p) => name.startsWith(p)); }

export function entry_fields(fields: FieldDef[], include_maintenance = true): FieldDef[] {
	return fields.filter((f) => {
		if (f.attributes?.omit) return false;
		if (!include_maintenance && MAINTENANCE_FIELDS.includes(f.name.toLowerCase())) return false;
		return true;
	});
}

export function generate_zod_fields_from_array(fields: FieldDef[], type: "index" | "form" | "validate", foreign_keys?: Map<string, any>): string {
	const zod_fields: string[] = [];
	const filtered_fields = entry_fields(fields);

	for (const field of filtered_fields) {
		const has_fk = foreign_keys?.has(field.name) || field.attributes?.foreign_key;
		const isMaintenance = MAINTENANCE_FIELDS.includes(field.name.toLowerCase());

		let schema = "";

		// -------------------------
		// BASE TYPE RESOLUTION
		// -------------------------
		if (type === "index") {
			if (has_fk) {
				schema = field.attributes?.fk_type === "string" ? "z.string()" : "z.coerce.number()";
			} else if (field.type === "number") {
				schema = "z.coerce.number()";
			} else if (field.type === "date" || field.type === "datetime" || field.type === "timestamp") {
				schema = "z.union([z.date(), z.string()])";
			} else {
				schema = "z.string()";
			}

			if (!field.required) { schema += ".optional()"; }
		} else if (type === "form") {
			if (has_fk) {
				schema = field.attributes?.fk_type === "string" ? "z.string()" : "z.coerce.number()";
			} else if (field.type === "number") {
				schema = "z.coerce.number()";
			} else if (field.type === "date") {
				schema = "date_codec";
			} else if (field.type === "timestamp") {
				schema = "timestamp_codec";
			} else if (field.type === "datetime") {
				schema = "datetime_codec";
			} else {
				schema = "z.string()";
			}

			if (!field.required) { schema += ".optional().nullable()"; }
		} else if (type === "validate") {
			if (has_fk) {
				schema = field.attributes?.fk_type === "string" ? "z.string().min(1, \"must_be_selected\")" : "z.coerce.number().min(1, \"must_be_selected\")";
			} else if (field.type === "number") {
				schema = "z.coerce.number()";

				if (is_boolean_field(field.name)) { schema += `.min(0, "${field.name}_required")`; }
				if (field.min !== undefined) { schema += `.min(${field.min}, "${field.name}_min")`; }
				if (field.max !== undefined) { schema += `.max(${field.max}, "${field.name}_max")`; }
			} else if (field.type === "date") {
				schema = field.required ? "z_date_required" : "z_date_optional";
			} else if (field.type === "datetime" || field.type === "timestamp") {
				schema = field.required ? "z_datetime_required" : "z_datetime_optional";
			} else if (field.type === "tags") {
				schema = "z.string()";
			} else if (field.type === "select" && field.attributes?.options) {
				schema = `z.enum(${JSON.stringify(field.attributes.options)})`;

				if (field.min !== undefined) { schema += `.min(${field.min}, "${field.name}_invalid")`; }
				if (field.max !== undefined) { schema += `.max(${field.max}, "${field.name}_invalid")`; }
				if (field.min === undefined && field.required) { schema += `.min(1, "${field.name}_required")`; }
			} else {
				schema = "z.string()";

				if (field.min === undefined && field.required) { schema += `.min(1, "${field.name}_required")`; }
				if (field.max !== undefined) { schema += `.max(${field.max}, "${field.name}_max")`; }
			}

			// Date/datetime/timestamp helpers handle optionality internally
			if (!field.required && field.type !== "date" && field.type !== "datetime" && field.type !== "timestamp") { schema += ".optional()"; }
		}

		// -------------------------
		// MAINTENANCE OVERRIDE
		// -------------------------
		if (isMaintenance && type === "validate" && !schema.includes(".optional()") && field.type !== "date" && field.type !== "datetime" && field.type !== "timestamp") {
			schema += ".optional()";
		}

		// -------------------------
		// UNIFIED NULLABLE WRAPPER
		// -------------------------
		if (field.is_nullable) { schema = `z.nullable(${schema})`; }

		zod_fields.push(`\t${field.name}: ${schema}`);
	}

	return zod_fields.join(",\n");
}

/**
 * Derive the validation error keys that `generate_zod_fields_from_array(fields, "validate")`
 * emits as Zod messages, paired with an English default.
 *
 * These keys never appear in .ree templates - they are produced at runtime from the
 * schema and resolved through the `messages` map in validate_schema(), so the .ree
 * scanner in reeman/sync_missing_translations.ts cannot find them. This function walks
 * the same fields and mirrors the same branches as generate_zod_fields_from_array so
 * the emitted messages and the translation keys stay in sync by construction.
 *
 * Values are English defaults only. Other languages are left to the Translations admin UI.
 */
export function collect_validation_error_keys(fields: FieldDef[], foreign_keys?: Map<string, any>): Array<{ key: string; value: string; }> {
	const keys = new Map<string, string>();
	const filtered_fields = entry_fields(fields);

	for (const field of filtered_fields) {
		const has_fk = foreign_keys?.has(field.name) || field.attributes?.foreign_key;
		const is_maintenance = MAINTENANCE_FIELDS.includes(field.name.toLowerCase());
		const label = field.label || capitalize_first(field.name.replace(/_/g, " "));

		// Maintenance fields are forced .optional() in validate mode - no error keys.
		if (is_maintenance && field.type !== "date" && field.type !== "datetime" && field.type !== "timestamp") { continue; }

		if (has_fk) {
			// Fixed key shared by every FK field - already shipped in crud_translations.json.
			keys.set("must_be_selected", "This field is required.");
		} else if (field.type === "number") {
			if (is_boolean_field(field.name)) { keys.set(`${field.name}_required`, `${label} is required.`); }
			if (field.min !== undefined) { keys.set(`${field.name}_min`, `${label} must be at least ${field.min}.`); }
			if (field.max !== undefined) { keys.set(`${field.name}_max`, `${label} must be at most ${field.max}.`); }
		} else if (field.type === "date") {
			// z_date_required / z_date_optional emit these fixed messages internally.
			keys.set("invalid_date", "Enter a valid date.");
			if (field.required) { keys.set("required", "This field is required."); }
		} else if (field.type === "datetime" || field.type === "timestamp") {
			keys.set("invalid_datetime", "Enter a valid date and time.");
			if (field.required) { keys.set("required", "This field is required."); }
		} else if (field.type === "tags") {
			// z.string() with no constraints - emits nothing.
		} else if (field.type === "select" && field.attributes?.options) {
			if (field.min !== undefined) { keys.set(`${field.name}_invalid`, `${label} is not a valid choice.`); }
			if (field.max !== undefined) { keys.set(`${field.name}_invalid`, `${label} is not a valid choice.`); }
			if (field.min === undefined && field.required) { keys.set(`${field.name}_required`, `${label} is required.`); }
		} else {
			if (field.min === undefined && field.required) { keys.set(`${field.name}_required`, `${label} is required.`); }
			if (field.max !== undefined) { keys.set(`${field.name}_max`, `${label} must be at most ${field.max} characters.`); }
		}
	}

	const result = Array.from(keys, ([key, value]) => ({ key, value }));
	return result;
}

export async function generate_validation_server_content(zod_index_fields_str: string, zod_form_fields_str: string, zod_validate_fields_str: string, template_path?: string): Promise<string> {
	const path = template_path || join(process.cwd(), "generator", "templates", "validation_server.ts");
	const template = await Bun.file(path).text();

	let ret = template.replace("__zod.index_fields__", zod_index_fields_str);
	ret = ret.replace("__zod.form_fields__", zod_form_fields_str);
	ret = ret.replace("__zod.validate_fields__", zod_validate_fields_str);
	return ret;
}
