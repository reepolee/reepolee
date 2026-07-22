/**
 * Shared translation sync module.
 *
 * Exports `sync_all_namespaces()` which:
 * 1. Queries the DB for all distinct namespaces
 * 2. For each namespace, syncs English keys and translates missing ones to all configured languages
 *
 * Used by both generator/sync_translations.ts (CLI) and generator/crud/main.ts (inline).
 */

import { db_cli } from "$config/db_cli";
import { language_names, languages } from "$config/supported_languages";
import {
	apply_translations,
	clean_for_translation,
	count_leaves,
	extract_untranslated,
	has_new_keys,
	type json_obj,
	log_translation_result,
	merge_into_english,
	merge_with_missing_prefix,
	sync_lang_to_en,
} from "$lib/translation_merge";
import { enqueue, init_queue, is_queue_available, is_worker_alive } from "$queue/index";

import { translate_json } from "./translator";

// Helpers

function set_nested(obj: Record<string, any>, path: string, value: string): void {
	const parts = path.split(".");
	let current = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		if (!current[parts[i]] || typeof current[parts[i]] !== "object") { current[parts[i]] = {}; }
		current = current[parts[i]];
	}
	current[parts[parts.length - 1]] = value;
}

function flatten_object(obj: json_obj, prefix: string = ""): [string, string][] {
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

async function upsert(lang: string, namespace: string, key_path: string, value: string): Promise<void> {
	try {
		await db_cli`DELETE FROM translations WHERE lang = ${lang} AND namespace = ${namespace} AND key_path = ${key_path}`;
		await db_cli`INSERT INTO translations (lang, namespace, key_path, translation) VALUES (${lang}, ${namespace}, ${key_path}, ${value})`;
	} catch {
		// translations table may not exist yet - skip silently
	}
}

async function write_namespace_to_db(lang: string, namespace: string, obj: json_obj): Promise<void> {
	const flat = flatten_object(obj);
	await Promise.all(flat.map(([key_path, value]) => upsert(lang, namespace, key_path, value)));
}

async function load_namespace_from_db(namespace: string): Promise<Record<string, json_obj>> {
	const lang_data: Record<string, json_obj> = {};
	for (const lang of languages) {
		lang_data[lang] = {};
	}

	try {
		const rows = (await db_cli`SELECT lang, key_path, translation FROM translations WHERE namespace = ${namespace}`) as { lang: string; key_path: string; translation: string; }[];

		for (const row of rows) {
			if (!lang_data[row.lang]) continue;
			set_nested(lang_data[row.lang], row.key_path, row.translation);
		}
	} catch {
		// translations table may not exist yet
	}

	return lang_data;
}

// Namespace sync

/**
 * Sync a single namespace - load all languages, merge into English, then
 * translate missing keys to all configured languages.
 */
export async function sync_single_namespace(namespace: string, translate: boolean): Promise<void> {
	const display = namespace || "(global)";
	const queue_mode = is_queue_available() && (await is_worker_alive()) && translate;

	console.log(`   ${display}`);

	// 1. Load all lang translations for this namespace from DB
	const lang_data = await load_namespace_from_db(namespace);

	// 1b. For root namespace, strip legacy route_name keys
	if (namespace === "root" || namespace === "") {
		for (const lang of Object.keys(lang_data)) {
			delete lang_data[lang].route_name;
		}
	}

	// 2. Merge everything into English
	const en_obj = { ...lang_data.en };
	for (const lang of languages) {
		if (lang === "en") continue;
		const lang_obj = lang_data[lang];
		if (!lang_obj || Object.keys(lang_obj).length === 0) continue;

		if (translate) {
			const clean_lang_obj = clean_for_translation(lang_obj);

			if (!has_new_keys(en_obj, clean_lang_obj)) continue;

			const target_lang_name = language_names[lang];
			try {
				const num_keys = count_leaves(clean_lang_obj);
				console.log(`🌍 Translating ${target_lang_name} → English (${num_keys} keys)...`);

				const translated = await translate_json(clean_lang_obj, "English", { source_lang: target_lang_name });
				log_translation_result(target_lang_name, "English", translated, clean_lang_obj);
				const clean_translated = clean_for_translation(translated);

				const new_keys: string[] = [];
				merge_into_english(en_obj, clean_translated, (key, path) => new_keys.push(path));

				if (new_keys.length > 0) {
					console.log(`✅ Added ${new_keys.length} new keys to English from ${target_lang_name}:`);
					for (const k of new_keys) {
						console.log(`   - ${k}`);
					}
				}
			} catch (err) {
				console.error(`❌ Translation failed for ${target_lang_name} → English:`, err);
				console.log(`⚠️ Falling back to clean version of ${target_lang_name} for English...`);
				merge_into_english(en_obj, clean_lang_obj);
			}
		} else {
			merge_with_missing_prefix(en_obj, lang_obj);
		}
	}

	// Write updated English to DB
	await write_namespace_to_db("en", namespace, en_obj);

	// 3. Sync all languages back to English - no cache, always translate fresh via AI
	for (const lang of languages) {
		if (lang === "en") continue;

		const lang_obj = lang_data[lang] || {};
		let synced = sync_lang_to_en(en_obj, lang_obj, translate);

		if (translate) {
			const total_keys = count_leaves(en_obj);
			const untranslated = extract_untranslated(en_obj, synced);
			const target_lang_name = language_names[lang];

			if (untranslated === null) {
				console.log(`   📦 All ${total_keys} keys already translated for ${target_lang_name} - ${display}`);
			} else {
				const remaining = count_leaves(untranslated);
				const cached = total_keys - remaining;
				console.log(`   📦 ${cached} keys already in DB, ${remaining} need AI - ${display}`);
				if (queue_mode) {
					await enqueue({ type: "translate_batch", payload: { namespace, lang, untranslated } });
					console.log(`   📦 Queued translation: ${display} / ${lang} (${remaining} keys)`);
				} else {
					console.log(`   🌍 Translating English → ${target_lang_name} (${remaining} keys)...`);
					try {
						const translated = await translate_json(untranslated, target_lang_name, { source_lang: "English" });
						log_translation_result("English", target_lang_name, translated, untranslated);
						synced = apply_translations(synced, translated);
					} catch (err) {
						console.error(`   ❌ Translation failed for English → ${target_lang_name}:`, err);
					}
				}
			}
		}

		await write_namespace_to_db(lang, namespace, synced);
	}
}

// Public API

/**
 * Scan the translations table for all namespaces with English keys and translate
 * any missing keys to all configured languages. No parameters needed - inspects
 * the DB directly to find what needs translating.
 */
export async function sync_all_namespaces(): Promise<void> {
	await init_queue();
	const translate = true;

	const namespaces = await get_all_namespaces();

	console.log(`🚀 Syncing translations across ${namespaces.length} namespace(s)...`);

	await Promise.all(namespaces.map((namespace) => sync_single_namespace(namespace, translate)));
}

async function get_all_namespaces(): Promise<string[]> {
	try {
		const rows = (await db_cli`SELECT DISTINCT namespace FROM translations ORDER BY namespace`) as { namespace: string; }[];
		return rows.map((r) => r.namespace);
	} catch {
		return [""];
	}
}
