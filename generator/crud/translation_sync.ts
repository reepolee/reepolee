import { join } from "node:path";

import { capitalize_first, singularize } from "../naming";
import { capitalize_label } from "../schema/field_generator";
import { collect_validation_error_keys, entry_fields } from "../validation_generator";
import { log_step, route_dir_to_namespace } from "./helpers";
import { apply_template } from "./template_substitutor";
import type { FieldDef, ParentInfo } from "./types";

// ---------------------------------------------------------------------------
// Sync nav translations to DB
// ---------------------------------------------------------------------------

export async function sync_nav_translations(table_name: string, clean_prefix: string, is_nested: boolean, route_name: string = ""): Promise<void> {
	if (is_nested) return;

	try {
		const { db_cli } = await import("../../config/db_cli");
		const dir_name = route_name || table_name;
		const nav_key = clean_prefix ? `${clean_prefix}.${dir_name}` : dir_name;
		const label = capitalize_first(dir_name.replace(/[^a-zA-Z0-9 ]/g, " ").replace(/_/g, " "));
		await db_cli`DELETE FROM translations WHERE lang = 'en' AND namespace = ${nav_key} AND key_path = 'nav'`;
		await db_cli`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ('en', ${nav_key}, 'nav', ${label})`;
		log_step(`Nav translations synced to DB for "${table_name}"`);
	} catch (err) {
		console.warn(
			`⚠  Nav translation sync failed for "${table_name}": ${err instanceof Error ? err.message : err}${is_missing_table_error(err) ? "\n   Hint: Run Quick Start from the reeman to initialize the database." : ""}`
		);
	}
}

// ---------------------------------------------------------------------------
// Sync nav_prefix_title to DB
// ---------------------------------------------------------------------------

export async function sync_nav_prefix_title(clean_prefix: string, is_nested: boolean): Promise<void> {
	if (is_nested || !clean_prefix) return;

	try {
		const { db_cli } = await import("../../config/db_cli");
		const existing = (await db_cli`SELECT 1 FROM translations WHERE lang = 'en' AND namespace = ${clean_prefix} AND key_path = 'nav_prefix_title' LIMIT 1`) as any[];
		if (existing.length === 0) {
			const prefix_label = capitalize_first(clean_prefix.replace(/_/g, " "));
			await db_cli`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ('en', ${clean_prefix}, 'nav_prefix_title', ${prefix_label})`;
			log_step(`Nav prefix title synced to DB for prefix "${clean_prefix}"`);
		}
	} catch (err) {
		console.warn(
			`⚠  Nav prefix title sync failed for "${clean_prefix}": ${err instanceof Error ? err.message : err}${is_missing_table_error(err) ? "\n   Hint: Run Quick Start from the reeman to initialize the database." : ""}`
		);
	}
}

// ---------------------------------------------------------------------------
// Inject CRUD-specific translation keys directly into DB
// ---------------------------------------------------------------------------

export async function sync_crud_translations(
	table_name: string,
	route_dir: string,
	fields: FieldDef[],
	is_nested: boolean,
	parent_info: ParentInfo | undefined,
): Promise<void> {
	const { db_cli } = await import("../../config/db_cli");
	const plural_label = table_name.replace(/_/g, " ");
	const singular_label = singularize(table_name);
	const singular_label_cap = capitalize_first(singular_label);

	log_step(`Loading CRUD translation keys`);
	const crud_keys: Record<string, Record<string, string>> = JSON.parse(apply_template(await Bun.file(join(process.cwd(), "generator", "templates", "crud_translations.json")).text(), {
		"translation.plural_label": plural_label,
		"translation.singular_label": singular_label,
		"translation.singular_label_cap": singular_label_cap,
	}));

	const child_visible_fields = is_nested ? entry_fields(fields, false).filter((f) => f.name !== parent_info?.fk_column && f.name !== "id") : [];
	const child_dialog_fields = is_nested ? entry_fields(fields, false).filter((f) => f.name !== parent_info?.fk_column) : [];

	const namespace = route_dir_to_namespace(route_dir);

	log_step(`Syncing CRUD translations to DB for namespace "${namespace}"...`);

	try {
		// Collect all key-value pairs to insert in batch
		const rows: Array<{ key_path: string; value: string; }> = [];

		for (const [group, keys] of Object.entries(crud_keys)) {
			for (const [key, value] of Object.entries(keys)) {
				rows.push({ key_path: `${group}.${key}`, value });
			}
		}

		if (is_nested) {
			const seen = new Set();
			for (const cf of child_visible_fields) {
				const key_path = `child_fields.${cf.name}`;
				seen.add(cf.name);
				rows.push({ key_path, value: cf.label || capitalize_label(cf.name) });
			}
			for (const df of child_dialog_fields) {
				if (seen.has(df.name)) continue;
				rows.push({
					key_path: `child_fields.${df.name}`,
					value: df.label || capitalize_label(df.name),
				});
			}
		}

		if (rows.length === 0) {
			log_step(`No CRUD translation keys to sync for "${table_name}"`);
			log_step(`CRUD generation complete for ${table_name}`);
			return;
		}

		// Batch DELETE then INSERT for all keys
		const key_paths = rows.map((r) => r.key_path);
		const placeholders = key_paths.map(() => "?").join(", ");
		const values = rows.flatMap((r) => [namespace, r.key_path, r.value]);

		await db_cli.unsafe(`DELETE FROM translations WHERE lang = 'en' AND namespace = ? AND key_path IN (${placeholders})`, [namespace, ...key_paths]);

		const value_slots = rows.map(() => "(?, ?, ?, ?)").join(", ");
		const value_params = rows.flatMap((r) => ["en", namespace, r.key_path, r.value]);

		await db_cli.unsafe(`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ${value_slots}`, value_params);

		log_step(`CRUD translations synced to DB for "${table_name}" (${rows.length} keys)`);
	} catch (err) {
		console.warn(
			`⚠  CRUD translation sync failed for "${table_name}": ${err instanceof Error ? err.message : err}${is_missing_table_error(err) ? "\n   Hint: Run Quick Start from the reeman to initialize the database." : ""}`
		);
	}
	log_step(`CRUD generation complete for ${table_name}`);
}

// ---------------------------------------------------------------------------
// Inject Zod validation error keys into DB
// ---------------------------------------------------------------------------

/**
 * Sync the `errors.*` keys that the generated Zod schema emits as messages.
 *
 * Unlike sync_crud_translations(), this is insert-if-absent: existing rows are left
 * untouched so translations edited via the admin UI survive a regen. Only English is
 * seeded - other languages are added via the Translations UI or `bun run sync:languages`.
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

	log_step(`Syncing validation error translations to DB for namespace "${namespace}"...`);

	try {
		const { db_cli } = await import("../../config/db_cli");

		// Fetch existing keys in one query - only insert the ones that are absent.
		const key_paths = error_keys.map((k) => `errors.${k.key}`);
		const placeholders = key_paths.map(() => "?").join(", ");
		const existing_rows = (await db_cli.unsafe(
			`SELECT key_path FROM translations WHERE lang = 'en' AND namespace = ? AND key_path IN (${placeholders})`,
			[namespace, ...key_paths]
		)) as { key_path: string; }[];

		const existing = new Set(existing_rows.map((r) => r.key_path));
		const new_rows = error_keys.filter((k) => !existing.has(`errors.${k.key}`));

		if (new_rows.length === 0) {
			log_step(`All ${error_keys.length} validation error key(s) already present for "${table_name}"`);
			return;
		}

		const value_slots = new_rows.map(() => "(?, ?, ?, ?)").join(", ");
		const value_params = new_rows.flatMap((k) => ["en", namespace, `errors.${k.key}`, k.value]);

		await db_cli.unsafe(`INSERT INTO translations (lang, namespace, key_path, translation) VALUES ${value_slots}`, value_params);

		log_step(`Validation error translations synced to DB for "${table_name}" (${new_rows.length} new, ${existing.size} kept)`);
	} catch (err) {
		console.warn(
			`⚠  Validation translation sync failed for "${table_name}": ${err instanceof Error ? err.message : err}${is_missing_table_error(err) ? "\n   Hint: Run Quick Start from the reeman to initialize the database." : ""}`
		);
	}
}

function is_missing_table_error(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("doesn't exist") || msg.includes("no such table");
}
