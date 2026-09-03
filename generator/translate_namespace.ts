/**
 * Shared translation sync module.
 *
 * Exports `sync_all_namespaces()` which:
 * 1. Scans locale files for all distinct namespaces
 * 2. For each namespace, syncs English keys and translates missing ones to all configured locales
 *
 * Used by both `bun reeman sync-translations` (generator/reeman/cli.ts) and generator/crud/main.ts (inline).
 */

import { default_locale, locale_names, locales } from "$config/supported_locales";
import { read_all_translation_rows, read_namespace_file, write_namespace_file } from "$lib/translation_files";
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

async function load_namespace_from_files(namespace: string): Promise<Record<string, json_obj>> {
	const lang_data: Record<string, json_obj> = {};
	for (const locale of locales) {
		lang_data[locale] = await read_namespace_file(namespace, locale);
	}

	return lang_data;
}

// Namespace sync

/**
 * Sync a single namespace - load all locales, merge into English, then
 * translate missing keys to all configured locales.
 */
export async function sync_single_namespace(namespace: string, translate: boolean): Promise<void> {
	const display = namespace || "(global)";
	const queue_mode = is_queue_available() && (await is_worker_alive()) && translate;

	console.log(`   ${display}`);

	// 1. Load all locale translations for this namespace from files
	const lang_data = await load_namespace_from_files(namespace);

	// 1b. For root namespace, strip legacy route_name keys
	if (namespace === "root" || namespace === "") {
		for (const locale of Object.keys(lang_data)) {
			delete lang_data[locale]!.route_name;
		}
	}

	// 2. Merge everything into English
	const en_obj = { ...lang_data[default_locale] };
	for (const locale of locales) {
		if (locale === default_locale) continue;
		const lang_obj = lang_data[locale];
		if (!lang_obj || Object.keys(lang_obj).length === 0) continue;

		if (translate) {
			const clean_lang_obj = clean_for_translation(lang_obj);

			if (!has_new_keys(en_obj, clean_lang_obj)) continue;

			const target_lang_name = locale_names[locale]!;
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

	await write_namespace_file(namespace, default_locale, en_obj);

	// 3. Sync all locales back to English - no cache, always translate fresh via AI
	for (const locale of locales) {
		if (locale === default_locale) continue;

		const lang_obj = lang_data[locale] || {};
		// Structural sync always retains the missing marker. AI mode reads that
		// marker below and replaces only those keys after a successful response.
		let synced = sync_lang_to_en(en_obj, lang_obj, false);

		if (translate) {
			const total_keys = count_leaves(en_obj);
			const untranslated = extract_untranslated(en_obj, synced);
			const target_lang_name = locale_names[locale]!;

			if (untranslated === null) {
				console.log(`   📦 All ${total_keys} keys already translated for ${target_lang_name} - ${display}`);
			} else {
				const remaining = count_leaves(untranslated);
				const cached = total_keys - remaining;
				console.log(`   📦 ${cached} keys already translated, ${remaining} need AI - ${display}`);
				if (queue_mode) {
					await enqueue({ type: "translate_batch", payload: { namespace, locale, untranslated } });
					console.log(`   📦 Queued translation: ${display} / ${locale} (${remaining} keys)`);
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

		await write_namespace_file(namespace, locale, synced);
	}
}

// Public API

/**
 * Scan translation files for all namespaces with English keys and translate
 * any missing keys to all configured locales.
 */
export async function sync_all_namespaces(): Promise<void> {
	await init_queue();
	const translate = true;

	const namespaces = await get_all_namespaces();

	console.log(`🚀 Syncing translations across ${namespaces.length} namespace(s)...`);

	await Promise.all(namespaces.map((namespace) => sync_single_namespace(namespace, translate)));
}

async function get_all_namespaces(): Promise<string[]> {
	const rows = await read_all_translation_rows();
	return [...new Set(rows.map((row) => row.namespace))].sort();
}
