#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { db_cli } from "$config/db_cli";
import { languages } from "$config/supported_languages";
import { notify_server_reload } from "$lib/server_notify";

import { chat_query } from "./ai-provider";
import { sync_all_namespaces } from "./translate_namespace";
import { translate_json } from "./translator";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface AddLanguageOptions {
	translate?: boolean;
}

/**
 * Add a new language to the system.
 *
 * @param lang_code - 2-letter language code (e.g. "it", "fr", "es")
 * @param options - Options
 * @returns true if successful, false on failure
 */
export async function add_language_to_system(lang_code: string, options: AddLanguageOptions = {}): Promise<boolean> {
	const translate = options.translate ?? false;

	if (!/^[a-z]{2}$/.test(lang_code)) {
		console.error(`Error: Invalid language code "${lang_code}". Use 2-letter code like "it", "fr", "es".`);
		return false;
	}

	if (languages.includes(lang_code as any)) {
		console.error(`Error: Language "${lang_code}" already exists in supported languages.`);
		return false;
	}

	const lang_name = await get_language_name_ai(lang_code);
	const lang_locale = await get_language_locale_ai(lang_code);

	console.log(`🚀 Adding new language: ${lang_code} (${lang_name})`);
	console.log(`   Translate: ${translate ? "YES (AI)" : "NO"}\n`);

	// Step 1: Update config/supported_languages.ts
	console.log("📝 Step 1: Updating config/supported_languages.ts...");

	const config_path = join(process.cwd(), "config", "supported_languages.ts");
	let config_content = readFileSync(config_path, "utf-8");

	config_content = config_content.replace(/(export const languages = \[)(.*?)(\] as const)/s, (_, open, middle, close) => {
		const langs = middle.split(",").map((l: string) => l.trim()).filter(Boolean);
		langs.push(`"${lang_code}"`);
		return `${open}\n\t${langs.join(",\n\t")},\n${close}`;
	});

	config_content = config_content.replace(/(export const active_languages = \[)(.*?)(\] as const)/s, (_, open, middle, close) => {
		const langs = middle.split(",").map((l: string) => l.trim()).filter(Boolean);
		langs.push(`"${lang_code}"`);
		return `${open}\n\t${langs.join(",\n\t")},\n${close}`;
	});

	config_content = config_content.replace(/(export const language_names.*?\{)([\s\S]*?)(\})/, (_, open, middle, close) => {
		return `${open}${middle}\t${lang_code}: "${lang_name}",\n${close}`;
	});

	config_content = config_content.replace(/(export const language_locales.*?\{)([\s\S]*?)(\})/, (_, open, middle, close) => {
		return `${open}${middle}\t${lang_code}: "${lang_locale}",\n${close}`;
	});

	writeFileSync(config_path, config_content, "utf-8");
	console.log(`   ✓ Updated supported_languages.ts\n`);

	// Step 2: Insert translations for new language into DB
	console.log("📝 Step 2: Reading English translations from DB and inserting for new language...");

	let namespaces: string[] = [];
	try {
		const rows = (await db_cli`SELECT DISTINCT namespace FROM translations WHERE lang = 'en' ORDER BY namespace`) as { namespace: string; }[];
		namespaces = rows.map((r) => r.namespace);
	} catch {
		namespaces = [""];
	}

	console.log(`   Found ${namespaces.length} namespace(s) with English translations`);

	for (const namespace of namespaces) {
		try {
			const en_rows = (await db_cli`SELECT key_path, translation FROM translations WHERE namespace = ${namespace} AND lang = 'en'`) as {
				key_path: string;
				translation: string;
			}[];

			if (en_rows.length === 0) continue;

			const en_content: Record<string, any> = {};
			for (const row of en_rows) {
				const parts = row.key_path.split(".");
				let target = en_content;
				for (let i = 0; i < parts.length - 1; i++) {
					if (!target[parts[i]] || typeof target[parts[i]] !== "object") { target[parts[i]] = {}; }
					target = target[parts[i]];
				}
				target[parts[parts.length - 1]] = row.translation;
			}

			let translated_content: Record<string, any>;

			if (translate) {
				try {
					console.log(`   🌍 Translating ${namespace || "(global)"} to ${lang_name}...`);
					translated_content = await translate_json(en_content, lang_name, { source_lang: "English" });
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
					await db_cli`DELETE FROM translations WHERE lang = ${lang_code} AND namespace = ${namespace} AND key_path = ${key_path}`;
					await db_cli`INSERT INTO translations (lang, namespace, key_path, translation) VALUES (${lang_code}, ${namespace}, ${key_path}, ${value})`;
				} catch {
					// Skip errors
				}
			}
			console.log(`   ✓ Synced ${lang_code} translations to DB for namespace "${namespace || "(global)"}"`);
		} catch (err) {
			console.error(`   ❌ Failed to process namespace ${namespace}:`, err);
		}
	}

	// Step 3: Update language_names and language_names_to in DB
	console.log("\n📝 Step 3: Updating language_names and language_names_to in DB...");

	try {
		const existing_langs = languages.filter((l: string) => l !== "en" && l !== lang_code);

		for (const existing_lang of existing_langs) {
			const has_lang_names = await db_cli`SELECT 1 FROM translations WHERE namespace = 'root' AND lang = ${existing_lang} AND key_path LIKE 'ui.language_names.%' LIMIT 1`;

			if (has_lang_names && has_lang_names.length > 0) {
				try {
					const file_lang_name = await get_language_name_in_language(lang_code, existing_lang);
					const key_path = `ui.language_names.${lang_code}`;
					await db_cli`DELETE FROM translations WHERE lang = ${existing_lang} AND namespace = 'root' AND key_path = ${key_path}`;
					await db_cli`INSERT INTO translations (lang, namespace, key_path, translation) VALUES (${existing_lang}, '', ${key_path}, ${file_lang_name})`;
					console.log(`   ✓ Added ${lang_code} to language_names for ${existing_lang}`);
				} catch (err) {
					console.error(`   ❌ Failed to translate language name for ${existing_lang}:`, err);
				}
			}

			const has_lang_names_to = await db_cli`SELECT 1 FROM translations WHERE namespace = 'root' AND lang = ${existing_lang} AND key_path LIKE 'ui.language_names_to.%' LIMIT 1`;

			if (has_lang_names_to && has_lang_names_to.length > 0) {
				try {
					const file_lang_name_to = await get_language_name_to_in_language(lang_code, existing_lang);
					const key_path = `ui.language_names_to.${lang_code}`;
					await db_cli`DELETE FROM translations WHERE lang = ${existing_lang} AND namespace = 'root' AND key_path = ${key_path}`;
					await db_cli`INSERT INTO translations (lang, namespace, key_path, translation) VALUES (${existing_lang}, '', ${key_path}, ${file_lang_name_to})`;
					console.log(`   ✓ Added ${lang_code} to language_names_to for ${existing_lang}`);
				} catch (err) {
					console.error(`   ❌ Failed to translate language name (to) for ${existing_lang}:`, err);
				}
			}
		}
	} catch (err) {
		console.error(`   ❌ Failed to update language_names:`, err);
	}

	// Step 4: Sync translations
	console.log(`\n📝 Step 4: Syncing translations to ${lang_code}...`);
	try {
		await sync_all_namespaces();
		await notify_server_reload();
		return true;
	} catch (err) {
		console.error("Error syncing translations:", err instanceof Error ? err.message : err);
		return false;
	}
}

// ---------------------------------------------------------------------------
// AI helpers
// ---------------------------------------------------------------------------

async function get_language_name_ai(code: string): Promise<string> {
	const system_prompt = "You are a language expert. Return ONLY the English name of the language for the given 2-letter code. No explanation, no quotes, just the name.";
	const user_prompt = `What is the English name of the language with code "${code}"?`;

	const content = await chat_query(system_prompt, user_prompt, "Language Name Resolver");
	const sanitized = content.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
	return sanitized || code.toUpperCase();
}

async function get_language_locale_ai(code: string): Promise<string> {
	const system_prompt = "You are a language expert. Return ONLY the locale code (like 'it-IT', 'fr-FR') for the given 2-letter language code. No explanation, no quotes, just the locale code.";
	const user_prompt = `What is the locale code for language code "${code}"?`;

	const content = await chat_query(system_prompt, user_prompt, "Language Locale Resolver");
	const sanitized = content.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
	return sanitized || `${code}-${code.toUpperCase()}`;
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

function show_usage() {
	console.error("Usage: bun generator/add-language.ts <lang_code> [--translate]");
	console.error("Example: bun generator/add-language.ts it --translate");
	console.error("\nAdds a new language to the system:");
	console.error("  - Updates config/supported_languages.ts");
	console.error("  - Copies English translations from DB and inserts for new language");
	console.error("  - Updates language_names and language_names_to in the DB");
	console.error("  - Optionally translates missing keys using AI (--translate)");
	process.exit(1);
}

async function main() {
	const args = Bun.argv.slice(2);
	let lang_code = "";
	let translate = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;

		if (arg === "--translate") {
			translate = true;
		} else if (!arg.startsWith("--")) {
			lang_code = arg;
		}
	}

	if (!lang_code) {
		console.error("Error: Language code is required");
		show_usage();
	}

	const success = await add_language_to_system(lang_code, { translate });
	process.exit(success ? 0 : 1);
}

// Only run as CLI when executed directly, not when imported as a module
if (import.meta.path === Bun.main) { main(); }
