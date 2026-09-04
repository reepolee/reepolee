/**
 * Shared translation sync module.
 *
 * Exports `sync_all_namespaces()` which:
 * 1. Reads the default-locale source file for each namespace
 * 2. Synchronizes and translates missing leaves into target locale files
 *
 * Used by both `bun reeman sync-translations` (generator/reeman/cli.ts) and generator/crud/main.ts (inline).
 */

import { default_locale, locale_names, locales } from "$config/supported_locales";
import { read_all_translation_rows, read_namespace_file, write_namespace_file } from "$lib/translation_files";
import {
	apply_translations,
	count_leaves,
	extract_untranslated,
	type json_obj,
	log_translation_result,
	sort_object,
	sync_target_to_source,
} from "$lib/translation_merge";
import { enqueue, init_queue, is_queue_available, is_worker_alive } from "$queue/index";

import { translate_json } from "./translator";
import { apply_route_memory, apply_translation_memory, save_translation_memory, table_for_translation_namespace } from "./translation_memory";

async function load_namespace_from_files(namespace: string): Promise<Record<string, json_obj>> {
	const lang_data: Record<string, json_obj> = {};
	for (const locale of locales) {
		lang_data[locale] = await read_namespace_file(namespace, locale);
	}

	return lang_data;
}

// Namespace sync

/**
 * Sync a single namespace from the default locale into target locale files.
 * The default locale is source-of-truth input and is never modified here.
 */
export async function sync_single_namespace(namespace: string, translate: boolean): Promise<void> {
	const display = namespace || "(global)";
	const queue_mode = is_queue_available() && (await is_worker_alive()) && translate;
	const table_name = translate ? await table_for_translation_namespace(namespace) : null;

	console.log(`   ${display}`);

	// 1. Load all locale translations for this namespace from files
	const lang_data = await load_namespace_from_files(namespace);

	const source = lang_data[default_locale] || {};

	// 2. Synchronize all target locales from the immutable default-locale source.
	for (const locale of locales) {
		if (locale === default_locale) continue;

		const lang_obj = lang_data[locale] || {};
		// Structural sync always retains the missing marker. AI mode reads that
		// marker below and replaces only those keys after a successful response.
		let synced = sync_target_to_source(source, lang_obj, false);
		synced = await apply_route_memory(namespace, locale, source, synced);
		if (table_name) synced = await apply_translation_memory(table_name, locale, source, synced);

		if (translate) {
			const total_keys = count_leaves(source);
			const untranslated = extract_untranslated(source, synced);
			const target_lang_name = locale_names[locale]!;

			if (untranslated === null) {
				console.log(`   📦 All ${total_keys} keys already translated for ${target_lang_name} - ${display}`);
			} else {
				const remaining = count_leaves(untranslated);
				const cached = total_keys - remaining;
				console.log(`   📦 ${cached} keys already translated, ${remaining} need AI - ${display}`);
				if (queue_mode) {
					await enqueue({ type: "translate_batch", payload: { namespace, locale, untranslated, table_name } });
					console.log(`   📦 Queued translation: ${display} / ${locale} (${remaining} keys)`);
				} else {
					console.log(`   🌍 Translating ${default_locale} → ${target_lang_name} (${remaining} keys)...`);
					try {
						const translated = await translate_json(untranslated, locale, { source_lang: default_locale });
						log_translation_result(default_locale, target_lang_name, translated, untranslated);
						synced = apply_translations(synced, translated);
						if (table_name) await save_translation_memory(table_name, locale, untranslated, translated);
					} catch (err) {
						console.error(`   ❌ Translation failed for ${default_locale} → ${target_lang_name}:`, err);
					}
				}
			}
		}

		// Rewrite only when the merged result actually differs from what is on
		// disk. Compared order-insensitively (both sides canonicalized with
		// sort_object - the writer sorts anyway), so a pure key relocation is
		// treated as unchanged and skipped: an unconditional write would churn
		// a watcher/reload notification per unchanged file on every sync run.
		const unchanged = JSON.stringify(sort_object(synced)) === JSON.stringify(sort_object(lang_obj));
		if (!unchanged) await write_namespace_file(namespace, locale, synced);
	}
}

// Public API

/**
 * Scan translation files for all namespaces with default-locale source keys and translate
 * any missing keys to all configured locales.
 */
export interface SyncAllNamespacesOptions {
	translate?: boolean;
}

export async function sync_all_namespaces(options: SyncAllNamespacesOptions = {}): Promise<void> {
	await init_queue();
	const translate = options.translate ?? true;

	const namespaces = await get_all_namespaces();

	console.log(`🚀 Syncing translations across ${namespaces.length} namespace(s)...`);

	for (const namespace of namespaces) await sync_single_namespace(namespace, translate);
}

async function get_all_namespaces(): Promise<string[]> {
	const rows = await read_all_translation_rows();
	return [...new Set(rows.map((row) => row.namespace))].sort();
}
