#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { db_cli } from "$config/db_cli";
import { default_locale, locales } from "$config/supported_locales";
import { format_bcp47, normalize_locale } from "$lib/locale";
import { notify_server_reload } from "$lib/server_notify";

import { chat_query } from "./ai-provider";
import { sync_all_namespaces } from "./translate_namespace";
import { translate_json } from "./translator";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface AddLocaleOptions {
	translate?: boolean;
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

	const locale_name = await get_language_name_ai(locale_code);

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

	config_content = config_content.replace(/(export const active_locales = \[)(.*?)(\] as const)/s, (_, open, middle, close) => {
		const langs = middle.split(",").map((l: string) => l.trim()).filter(Boolean);
		langs.push(`"${locale_code}"`);
		return `${open}\n\t${langs.join(",\n\t")},\n${close}`;
	});

	config_content = add_locale_name_to_config(config_content, locale_code, locale_name);

	writeFileSync(config_path, config_content, "utf-8");
	console.log(`   ✓ Updated supported_locales.ts\n`);

	// Step 2: Insert translations for new language into DB
	console.log("📝 Step 2: Reading English translations from DB and inserting for new language...");

	let namespaces: string[] = [];
	try {
		const rows = (await db_cli`SELECT DISTINCT namespace FROM translations WHERE locale = ${default_locale} ORDER BY namespace`) as { namespace: string; }[];
		namespaces = rows.map((r) => r.namespace);
	} catch {
		namespaces = [""];
	}

	console.log(`   Found ${namespaces.length} namespace(s) with English translations`);

	for (const namespace of namespaces) {
		try {
			const en_rows = (await db_cli`SELECT key_path, translation FROM translations WHERE namespace = ${namespace} AND locale = ${default_locale}`) as {
				key_path: string;
				translation: string;
			}[];

			if (en_rows.length === 0) continue;

			const en_content: Record<string, any> = {};
			for (const row of en_rows) {
				const parts = row.key_path.split(".");
				let target = en_content;
				for (let i = 0; i < parts.length - 1; i++) {
					const part = parts[i]!;
					if (!target[part] || typeof target[part] !== "object") { target[part] = {}; }
					target = target[part];
				}
				target[parts[parts.length - 1]!] = row.translation;
			}

			let translated_content: Record<string, any>;

			if (translate) {
				try {
					console.log(`   🌍 Translating ${namespace || "(global)"} to ${locale_name}...`);
					translated_content = await translate_json(en_content, locale_name, { source_lang: "English" });
					console.log(`   ✓ Translated ${namespace || "(global)"}`);
				} catch (err) {
					console.error(`   ❌ Translation failed for ${namespace}:`, err);
					console.log(`   ⚠ Using English as fallback`);
					translated_content = en_content;
				}
			} else {
				translated_content = en_content;
				console.log(`   ✓ Copied English for ${namespace || "(global)"}`);
			}

			const flat = flatten_object(translated_content);
			for (const [key_path, value] of flat) {
				if (typeof value !== "string") continue;
				try {
					await db_cli`DELETE FROM translations WHERE locale = ${locale_code} AND namespace = ${namespace} AND key_path = ${key_path}`;
					await db_cli`INSERT INTO translations (locale, namespace, key_path, translation) VALUES (${locale_code}, ${namespace}, ${key_path}, ${value})`;
				} catch {
					// Skip errors
				}
			}
			console.log(`   ✓ Synced ${locale_code} translations to DB for namespace "${namespace || "(global)"}"`);
		} catch (err) {
			console.error(`   ❌ Failed to process namespace ${namespace}:`, err);
		}
	}

	// Step 3: Update locale_names and language_names_to in DB
	console.log("\n📝 Step 3: Updating locale_names and language_names_to in DB...");

	try {
		const existing_langs = locales.filter((l: string) => l !== default_locale && l !== locale_code);

		for (const existing_lang of existing_langs) {
			const has_lang_names = await db_cli`SELECT 1 FROM translations WHERE namespace = 'root' AND locale = ${existing_lang} AND key_path LIKE 'ui.locale_names.%' LIMIT 1`;

			if (has_lang_names && has_lang_names.length > 0) {
				try {
					const file_lang_name = await get_language_name_in_language(locale_code, existing_lang);
					const key_path = `ui.locale_names.${locale_code}`;
					await db_cli`DELETE FROM translations WHERE locale = ${existing_lang} AND namespace = 'root' AND key_path = ${key_path}`;
					await db_cli`INSERT INTO translations (locale, namespace, key_path, translation) VALUES (${existing_lang}, '', ${key_path}, ${file_lang_name})`;
					console.log(`   ✓ Added ${locale_code} to locale_names for ${existing_lang}`);
				} catch (err) {
					console.error(`   ❌ Failed to translate language name for ${existing_lang}:`, err);
				}
			}

			const has_lang_names_to = await db_cli`SELECT 1 FROM translations WHERE namespace = 'root' AND locale = ${existing_lang} AND key_path LIKE 'ui.language_names_to.%' LIMIT 1`;

			if (has_lang_names_to && has_lang_names_to.length > 0) {
				try {
					const file_lang_name_to = await get_language_name_to_in_language(locale_code, existing_lang);
					const key_path = `ui.language_names_to.${locale_code}`;
					await db_cli`DELETE FROM translations WHERE locale = ${existing_lang} AND namespace = 'root' AND key_path = ${key_path}`;
					await db_cli`INSERT INTO translations (locale, namespace, key_path, translation) VALUES (${existing_lang}, '', ${key_path}, ${file_lang_name_to})`;
					console.log(`   ✓ Added ${locale_code} to language_names_to for ${existing_lang}`);
				} catch (err) {
					console.error(`   ❌ Failed to translate language name (to) for ${existing_lang}:`, err);
				}
			}
		}
	} catch (err) {
		console.error(`   ❌ Failed to update locale_names:`, err);
	}

	// Step 4: Sync translations
	console.log(`\n📝 Step 4: Syncing translations to ${locale_code}...`);
	try {
		await sync_all_namespaces();
		await notify_server_reload();
	} catch (err) {
		console.error("Error syncing translations:", err instanceof Error ? err.message : err);
		return false;
	}

	// Step 5: Create this locale's clone tables. A new locale has no content
	// tables until they are cloned from the base tables, so adding a locale is
	// a DDL operation, not only a config/translation one.
	console.log(`\n📝 Step 5: Creating locale tables for ${locale_code}...`);
	try {
		const { format_sync_actions, run_locale_table_sync } = await import("./locale_tables/run");
		const { results } = await run_locale_table_sync();
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

async function get_language_name_ai(code: string): Promise<string> {
	const system_prompt = "You are a language expert. Return ONLY the English display name for the given BCP 47 locale code, including the region when it disambiguates (e.g. 'German (Austria)' for de-at, 'English' for en-us). No explanation, no quotes, just the name.";
	const user_prompt = `What is the English display name of the locale with code "${code}"?`;

	const content = await chat_query(system_prompt, user_prompt, "Language Name Resolver");
	const sanitized = content.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
	return sanitized || format_bcp47(code);
}

async function get_language_name_in_language(target_code: string, translate_to_lang: string): Promise<string> {
	const target_name = await get_language_name_ai(target_code);
	const system_prompt = `You are a translator. Translate the given language name to ${translate_to_lang}. Return ONLY the translation, no quotes, no explanation.`;
	const user_prompt = `Translate "${target_name}" to ${translate_to_lang}`;

	const content = await chat_query(system_prompt, user_prompt, "Language Name Translator");
	return content || target_name;
}

async function get_language_name_to_in_language(target_code: string, translate_to_lang: string): Promise<string> {
	const target_name = await get_language_name_ai(target_code);
	const system_prompt = `You are a translator. Translate the phrase "to ${target_name}" (meaning: switch TO this language) to ${translate_to_lang}. Return ONLY the translation of the phrase, no quotes, no explanation. Use appropriate grammatical case for "to" in your language.`;
	const user_prompt = `Translate "to ${target_name}" to ${translate_to_lang} (use appropriate grammatical case)`;

	const content = await chat_query(system_prompt, user_prompt, "Language Name Translator");
	return content || target_name;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

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
