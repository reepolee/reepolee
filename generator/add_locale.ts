#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { default_locale, locales } from "$config/supported_locales";
import { format_bcp47, normalize_locale } from "$lib/locale";
import { notify_server_reload } from "$lib/server_notify";
import { get_dotted, read_all_translation_rows, read_namespace_file, upsert_file_translation, write_namespace_file } from "$lib/translation_files";
import { apply_translations, extract_untranslated, sync_target_to_source } from "$lib/translation_merge";

import { apply_route_memory, apply_translation_memory, table_for_translation_namespace } from "./translation_memory";
import { translate_json } from "./translator";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface AddLocaleOptions {
	translate?: boolean;
}

/**
 * Add a locale that already has a curated seed file under
 * sql/{db_type}/locales/*-init-translations-<code>.sql - no AI call. Lands the
 * code in `locales` only (not `active_locales`; adding is not activating -
 * see PLAN_locale_lifecycle.md), runs the seed SQL, then clones locale tables.
 */
export async function add_seeded_locale(locale_code: string): Promise<boolean> {
	let code: string;
	try {
		code = normalize_locale(locale_code);
	} catch {
		console.error(`Error: Invalid locale code "${locale_code}".`);
		return false;
	}

	if (locales.includes(code as any)) {
		console.error(`Error: Locale "${code}" already exists in supported locales.`);
		return false;
	}

	const { list_available_seed_locales, run_locale_init_sql } = await import("./activate_locale");
	const available = await list_available_seed_locales();
	const seed = available.find((l) => l.code === code);
	if (!seed) {
		console.error(`Error: No curated seed file found for "${code}".`);
		return false;
	}

	console.log(`🚀 Adding seeded locale: ${code} (${seed.name})`);

	console.log("📝 Step 1: Updating config/supported_locales.ts...");
	const config_path = join(process.cwd(), "config", "supported_locales.ts");
	let config_content = readFileSync(config_path, "utf-8");
	config_content = config_content.replace(/(export const locales = \[)(.*?)(\] as const)/s, (_, open, middle, close) => {
		const langs = middle.split(",").map((l: string) => l.trim()).filter(Boolean);
		langs.push(`"${code}"`);
		return `${open}\n\t${langs.join(",\n\t")},\n${close}`;
	});
	config_content = add_locale_name_to_config(config_content, code, seed.name);
	writeFileSync(config_path, config_content, "utf-8");
	console.log("   ✓ Updated supported_locales.ts\n");

	console.log(`📝 Step 2: Verifying translation files for ${code}...`);
	const ran = await run_locale_init_sql(code);
	if (!ran) {
		console.error(`   ❌ Translation files are missing for "${code}".`);
		return false;
	}
	console.log("   ✓ Translation files available\n");

	console.log(`📝 Step 3: Creating locale tables for ${code}...`);
	try {
		const { format_sync_actions, run_locale_table_sync } = await import("./locale_tables/run");
		// This process imported supported_locales before writing the new code.
		// Pass the pending list explicitly so the new clone tables are included.
		const { results } = await run_locale_table_sync({ locale_codes: [...locales, locale_code] });
		let changes = 0;
		for (const result of results) {
			const descriptions = format_sync_actions(result.actions);
			changes += descriptions.length;
			for (const description of descriptions) console.log(`   ✓ ${description}`);
		}
		if (changes === 0) console.log("   ✓ No localized tables - nothing to clone");
	} catch (err) {
		console.error("Error syncing locale tables:", err instanceof Error ? err.message : err);
		return false;
	}

	await notify_server_reload();
	return true;
}

/**
 * Add a new language to the system.
 *
 * @param locale_code - BCP 47 locale code (e.g. "it-it", "fr-fr", "de-at");
 * validated with Intl and normalized to lowercase immediately
 * @param options - Options
 * @returns true if successful, false on failure
 */
export async function add_locale_to_system(locale_code: string, options: AddLocaleOptions = {}): Promise<boolean> {
	const translate = options.translate ?? false;

	try {
		locale_code = normalize_locale(locale_code);
	} catch {
		console.error(`Error: Invalid locale code "${locale_code}". Use a valid BCP 47 code like "it-it", "fr-fr", "de-at" (lowercase).`);
		return false;
	}

	if (locales.includes(locale_code as any)) {
		console.error(`Error: Locale "${locale_code}" already exists in supported locales.`);
		return false;
	}

	const locale_name = get_locale_display_name(locale_code);

	console.log(`🚀 Adding new language: ${locale_code} (${locale_name})`);
	console.log(`   Translate: ${translate ? "YES (AI)" : "NO"}\n`);

	// Step 1: Update config/supported_locales.ts
	console.log("📝 Step 1: Updating config/supported_locales.ts...");

	const config_path = join(process.cwd(), "config", "supported_locales.ts");
	let config_content = readFileSync(config_path, "utf-8");

	config_content = config_content.replace(/(export const locales = \[)(.*?)(\] as const)/s, (_, open, middle, close) => {
		const langs = middle.split(",").map((l: string) => l.trim()).filter(Boolean);
		langs.push(`"${locale_code}"`);
		return `${open}\n\t${langs.join(",\n\t")},\n${close}`;
	});

	config_content = add_locale_name_to_config(config_content, locale_code, locale_name);

	writeFileSync(config_path, config_content, "utf-8");
	console.log(`   ✓ Updated supported_locales.ts\n`);

	// Step 2: Create translation files from default-locale source plus archive memory.
	console.log("📝 Step 2: Reading default-locale translation files for the new language...");

	const translation_rows = await read_all_translation_rows();
	const english_rows = translation_rows.filter((row) => row.locale === default_locale);
	const namespaces = [...new Set(english_rows.map((row) => row.namespace))].sort();

	console.log(`   Found ${namespaces.length} namespace(s) with default-locale translations`);

	for (const namespace of namespaces) {
		try {
			const source_content = await read_namespace_file(namespace, default_locale);
			if (Object.keys(source_content).length === 0) continue;

			let translated_content = sync_target_to_source(source_content, {}, false);
			translated_content = await apply_route_memory(namespace, locale_code, source_content, translated_content);
			const table_name = await table_for_translation_namespace(namespace);
			if (table_name) translated_content = await apply_translation_memory(table_name, locale_code, source_content, translated_content);

			const untranslated = extract_untranslated(source_content, translated_content);
			if (translate && untranslated !== null) {
				try {
					console.log(`   🌍 Translating ${namespace || "(global)"} to ${locale_name}...`);
					const translated = await translate_json(untranslated, locale_code, { source_lang: default_locale });
					translated_content = apply_translations(translated_content, translated);
					console.log(`   ✓ Translated ${namespace || "(global)"}`);
				} catch (err) {
					console.error(`   ❌ Translation failed for ${namespace}:`, err);
					console.log(`   ⚠ Marked as missing for a later translation attempt`);
				}
			} else if (!translate) {
				console.log(`   ✓ Marked translations as missing for ${namespace || "(global)"}`);
			}

			await write_namespace_file(namespace, locale_code, translated_content);
			console.log(`   ✓ Wrote ${locale_code} translation file for namespace "${namespace || "(global)"}"`);
		} catch (err) {
			console.error(`   ❌ Failed to process namespace ${namespace}:`, err);
		}
	}

	// Step 3: Update locale_names and language_names_to in files
	console.log("\n📝 Step 3: Updating locale_names and language_names_to in files...");

	try {
		const existing_langs = locales.filter((l: string) => l !== default_locale && l !== locale_code);

		for (const existing_lang of existing_langs) {
			const root_obj = await read_namespace_file("root", existing_lang);
			if (get_dotted(root_obj, "ui.locale_names") !== undefined) {
				try {
					const file_lang_name = await get_language_name_in_language(locale_code, existing_lang);
					const key_path = `ui.locale_names.${locale_code}`;
					await upsert_file_translation(existing_lang, "root", key_path, file_lang_name);
					console.log(`   ✓ Added ${locale_code} to locale_names for ${existing_lang}`);
				} catch (err) {
					console.error(`   ❌ Failed to translate language name for ${existing_lang}:`, err);
				}
			}

			if (get_dotted(root_obj, "ui.language_names_to") !== undefined) {
				try {
					const file_lang_name_to = await get_language_name_to_in_language(locale_code, existing_lang);
					const key_path = `ui.language_names_to.${locale_code}`;
					await upsert_file_translation(existing_lang, "root", key_path, file_lang_name_to);
					console.log(`   ✓ Added ${locale_code} to language_names_to for ${existing_lang}`);
				} catch (err) {
					console.error(`   ❌ Failed to translate language name (to) for ${existing_lang}:`, err);
				}
			}
		}
	} catch (err) {
		console.error(`   ❌ Failed to update locale_names:`, err);
	}

	// Step 4: Reload routes after all new locale files have been written. The
	// target locale has already consumed its archive memory above, so do not
	// run a global sync that could translate unrelated locales.
	console.log(`\n📝 Step 4: Reloading routes for ${locale_code}...`);
	try {
		await notify_server_reload();
	} catch (err) {
		console.error("Error reloading routes:", err instanceof Error ? err.message : err);
		return false;
	}

	// Step 5: Create this locale's clone tables. A new locale has no content
	// tables until they are cloned from the base tables, so adding a locale is
	// a DDL operation, not only a config/translation one.
	console.log(`\n📝 Step 5: Creating locale tables for ${locale_code}...`);
	try {
		const { format_sync_actions, run_locale_table_sync } = await import("./locale_tables/run");
		const { results } = await run_locale_table_sync({ locale_codes: [...locales, locale_code] });
		let changes = 0;
		for (const result of results) {
			const descriptions = format_sync_actions(result.actions);
			changes += descriptions.length;
			for (const description of descriptions) console.log(`   ✓ ${description}`);
		}
		if (changes === 0) console.log("   ✓ No localized tables - nothing to clone");
		return true;
	} catch (err) {
		console.error("Error syncing locale tables:", err instanceof Error ? err.message : err);
		return false;
	}
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

export function get_locale_display_name(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "language" }).of(format_bcp47(code)) || format_bcp47(code);
	} catch {
		return format_bcp47(code);
	}
}

async function get_language_name_in_language(target_code: string, translate_to_lang: string): Promise<string> {
	const target_name = get_locale_display_name(target_code);
	return await translate_language_label(target_name, translate_to_lang);
}

async function get_language_name_to_in_language(target_code: string, translate_to_lang: string): Promise<string> {
	const label = `to ${get_locale_display_name(target_code)}`;
	return await translate_language_label(label, translate_to_lang);
}

async function translate_language_label(label: string, locale: string): Promise<string> {
	const translated = await translate_json({ label }, locale, { source_lang: default_locale });
	return typeof translated?.label === "string" && translated.label ? translated.label : label;
}

export function add_locale_name_to_config(config_content: string, locale_code: string, locale_name: string): string {
	const locale_names_pattern = /export const locale_names: Record<string, string> = \{([\s\S]*?)\};/;
	const match = config_content.match(locale_names_pattern);
	if (!match) throw new Error("Could not find locale_names in config/supported_locales.ts.");
	const locale_names_content = match[1] ?? "";

	const existing_names = new Map<string, string>();
	const name_entry_pattern = /"([^"\\]+)"\s*:\s*"([^"\\]*)"/g;
	for (const entry of locale_names_content.matchAll(name_entry_pattern)) {
		const locale = entry[1];
		const name = entry[2];
		if (locale !== undefined && name !== undefined) existing_names.set(locale, name);
	}
	existing_names.set(locale_code, locale_name);

	const name_lines: string[] = [];
	for (const [locale, name] of existing_names) {
		name_lines.push(`\t${JSON.stringify(locale)}: ${JSON.stringify(name)},`);
	}
	const replacement = `export const locale_names: Record<string, string> = {\n${name_lines.join("\n")}\n};`;
	return config_content.replace(locale_names_pattern, replacement);
}
