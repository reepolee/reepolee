import { join } from "node:path";

import { capitalize_first, singularize } from "../naming";
import { capitalize_label } from "../schema/field_generator";
import { collect_validation_error_keys, entry_fields } from "../validation_generator";
import { log_step, route_dir_to_namespace } from "./helpers";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ParentInfo } from "./types";
import { default_locale } from "$config/supported_locales";
import { get_dotted, read_namespace_file, set_dotted, upsert_file_translation, write_namespace_file } from "$lib/translation_files";

// ---------------------------------------------------------------------------
// Sync nav translations to files
// ---------------------------------------------------------------------------

export async function sync_nav_translations(table_name: string, clean_prefix: string, is_nested: boolean, route_name: string = ""): Promise<void> {
	if (is_nested) return;

	const dir_name = route_name || table_name;
	const nav_key = clean_prefix ? `${clean_prefix}.${dir_name}` : dir_name;
	const normalized_name = dir_name.replace(/[^a-zA-Z0-9 ]/g, " ");
	const label = capitalize_first(normalized_name.replace(/_/g, " "));
	await upsert_file_translation(default_locale, nav_key, "nav", label);
	log_step(`Nav translations synced to files for "${table_name}"`);
}

// ---------------------------------------------------------------------------
// Sync nav_prefix_title to files
// ---------------------------------------------------------------------------

export async function sync_nav_prefix_title(clean_prefix: string, is_nested: boolean): Promise<void> {
	if (is_nested || !clean_prefix) return;

	const obj = await read_namespace_file(clean_prefix, default_locale);
	if (get_dotted(obj, "nav_prefix_title") === undefined) {
		const prefix_label = capitalize_first(clean_prefix.replace(/_/g, " "));
		set_dotted(obj, "nav_prefix_title", prefix_label);
		await write_namespace_file(clean_prefix, default_locale, obj);
		log_step(`Nav prefix title synced to files for prefix "${clean_prefix}"`);
	}
}

// ---------------------------------------------------------------------------
// Inject CRUD-specific translation keys into files
// ---------------------------------------------------------------------------

export async function sync_crud_translations(
	table_name: string,
	route_dir: string,
	fields: FieldDef[],
	is_nested: boolean,
	parent_info: ParentInfo | undefined,
	v_fields: FieldDef[] | null = null,
): Promise<void> {
	const plural_label = table_name.replace(/_/g, " ");
	const singular_label = singularize(table_name);
	const singular_label_cap = capitalize_first(singular_label);

	log_step(`Loading CRUD translation keys`);
	const crud_keys: Record<string, Record<string, string>> = JSON.parse(apply_template(await Bun.file(join(process.cwd(), "generator", "templates", "crud_translations.json")).text(), {
		"translation.plural_label": plural_label,
		"translation.singular_label": singular_label,
		"translation.singular_label_cap": singular_label_cap,
	}));

	// Grid headers reflect what's actually rendered in the child grid, which
	// prefers the view's denormalized columns (e.g. ingredient_name instead of
	// ingredient_id) when a view exists - see child_section.ts's child_grid_fields.
	// The dialog is a real edit form, so it always uses the base table's own
	// (editable) columns regardless of any view.
	const grid_display_fields = v_fields || fields;
	const child_visible_fields = is_nested ? entry_fields(grid_display_fields, false).filter((f) => f.name !== parent_info?.fk_column && f.name !== "id") : [];
	const child_dialog_fields = is_nested ? entry_fields(fields, false).filter((f) => f.name !== parent_info?.fk_column) : [];

	const namespace = route_dir_to_namespace(route_dir);

	log_step(`Syncing CRUD translations to files for namespace "${namespace}"...`);

	try {
		// Collect all key-value pairs to insert in batch
		const rows: Array<{ key_path: string; value: string; }> = [];

		for (const [group, keys] of Object.entries(crud_keys)) {
			for (const [key, value] of Object.entries(keys)) {
				rows.push({ key_path: `${group}.${key}`, value });
			}
		}

		if (is_nested) {
			// For FK fields, strip the _id suffix for a clean label.
			// E.g. team_id -> "Team", company_id -> "Company"
			const label_for_field = (f: FieldDef): string => {
				if (f.label) return f.label;
				return f.attributes?.foreign_key ? capitalize_label(f.name.replace(/_id$/i, "")) : capitalize_label(f.name);
			};

			const seen = new Set();
			for (const cf of child_visible_fields) {
				const key_path = `child_fields.${cf.name}`;
				seen.add(cf.name);
				rows.push({ key_path, value: label_for_field(cf) });
			}
			for (const df of child_dialog_fields) {
				if (seen.has(df.name)) continue;
				rows.push({
					key_path: `child_fields.${df.name}`,
					value: label_for_field(df),
				});
			}
		}

		if (rows.length === 0) {
			log_step(`No CRUD translation keys to sync for "${table_name}"`);
			log_step(`CRUD generation complete for ${table_name}`);
			return;
		}

		const obj = await read_namespace_file(namespace, default_locale);
		for (const row of rows) set_dotted(obj, row.key_path, row.value);
		await write_namespace_file(namespace, default_locale, obj);

		log_step(`CRUD translations synced to files for "${table_name}" (${rows.length} keys)`);
	} catch (err) {
		console.warn(`⚠  CRUD translation sync failed for "${table_name}": ${err instanceof Error ? err.message : err}`);
	}
	log_step(`CRUD generation complete for ${table_name}`);
}

// ---------------------------------------------------------------------------
// Inject Zod validation error keys into files
// ---------------------------------------------------------------------------

/**
 * Sync the `errors.*` keys that the generated Zod schema emits as messages.
 *
 * Unlike sync_crud_translations(), this is insert-if-absent: existing rows are left
 * untouched so translations edited via the admin UI survive a regen. This writes
 * the default locale only; the CRUD pipeline follows with a structural locale sync
 * that creates missing values in every configured locale with the missing prefix.
 *
 * Empty values are never written. An empty translation is a lookup *hit*, so
 * validate_schema()'s `messages?.[err.message] ?? err.message` fallback would resolve
 * it to "" and show the user a blank error instead of the raw key.
 */
export async function sync_validation_translations(
	table_name: string,
	route_dir: string,
	fields: FieldDef[],
	foreign_keys?: Map<string, any>,
): Promise<void> {
	const error_keys = collect_validation_error_keys(fields, foreign_keys);

	if (error_keys.length === 0) {
		log_step(`No validation error keys to sync for "${table_name}"`);
		return;
	}

	const namespace = route_dir_to_namespace(route_dir);

	log_step(`Syncing validation error translations to files for namespace "${namespace}"...`);

	try {
		const obj = await read_namespace_file(namespace, default_locale);
		const new_rows = error_keys.filter((key) => get_dotted(obj, `errors.${key.key}`) === undefined);

		if (new_rows.length === 0) {
			log_step(`All ${error_keys.length} validation error key(s) already present for "${table_name}"`);
			return;
		}

		for (const row of new_rows) set_dotted(obj, `errors.${row.key}`, row.value);
		await write_namespace_file(namespace, default_locale, obj);

		const existing_count = error_keys.length - new_rows.length;
		log_step(`Validation error translations synced to files for "${table_name}" (${new_rows.length} new, ${existing_count} kept)`);
	} catch (err) {
		console.warn(`⚠  Validation translation sync failed for "${table_name}": ${err instanceof Error ? err.message : err}`);
	}
}
