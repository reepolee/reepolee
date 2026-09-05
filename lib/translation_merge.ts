// lib/translation_merge.ts - Pure JSON merge/sort/reconstruct functions for translation pipeline
//
// Extracted for shared use between the sync-translations reeman subcommand and queue workers.
// All functions are pure (no filesystem, no AI calls) - operate only on JSON objects in memory.

export type json_obj = Record<string, any>;

export function is_object(val: any): val is json_obj { return val && typeof val === "object" && !Array.isArray(val); }

export function sort_object(obj: json_obj): json_obj {
	const result: json_obj = {};
	for (const key of Object.keys(obj).sort()) {
		result[key] = is_object(obj[key]) ? sort_object(obj[key]) : obj[key];
	}
	return result;
}

// -------------------- CLEANING --------------------

// Strip "::missing:: " prefix from leaf values - used before sending to AI for translation.
export function clean_for_translation(obj: json_obj): json_obj {
	const result: json_obj = {};
	const prefix = "::missing:: ";
	for (const key of Object.keys(obj)) {
		const val = obj[key];
		if (is_object(val)) {
			result[key] = clean_for_translation(val);
		} else if (typeof val === "string" && val.startsWith(prefix)) {
			result[key] = val.substring(prefix.length);
		} else {
			result[key] = val;
		}
	}
	return result;
}

// -------------------- COMPARISON --------------------

// Extract keys explicitly marked as missing from a locale file. The marker is
// the source of truth: a value matching the default locale may be intentional and must
// never be sent to AI again.
export function extract_untranslated(en_obj: json_obj, lang_obj: json_obj): json_obj | null {
	const result: json_obj = {};
	for (const key of Object.keys(en_obj)) {
		const en_val = en_obj[key];
		const lang_val = lang_obj[key];
		if (is_object(en_val)) {
			const sub = extract_untranslated(en_val, is_object(lang_val) ? lang_val : {});
			if (sub !== null) result[key] = sub;
		} else {
			if (typeof lang_val === "string" && lang_val.startsWith("::missing:: ")) { result[key] = en_val; }
		}
	}
	return Object.keys(result).length > 0 ? result : null;
}

// -------------------- MERGE / APPLY --------------------

// Merge translated keys back into lang, leaving already-translated keys untouched.
export function apply_translations(lang_obj: json_obj, translated_obj: json_obj): json_obj {
	const result: json_obj = { ...lang_obj };
	for (const key of Object.keys(translated_obj)) {
		const t_val = translated_obj[key];
		if (is_object(t_val)) {
			result[key] = apply_translations(is_object(lang_obj[key]) ? lang_obj[key] : {}, t_val);
		} else {
			result[key] = t_val;
		}
	}
	return result;
}

// Sync a target language file to match the default-locale source structure.
export function sync_target_to_source(source_obj: json_obj, target_obj: json_obj, translate: boolean = false): json_obj {
	const result: json_obj = {};
	const prefix = "::missing:: ";

	for (const key of Object.keys(source_obj)) {
		const source_val = source_obj[key];
		const target_val = target_obj[key];

		if (is_object(source_val)) {
			result[key] = sync_target_to_source(source_val, is_object(target_val) ? target_val : {}, translate);
		} else {
			if (target_val === undefined || (typeof target_val === "string" && target_val.startsWith(prefix))) {
				if (typeof source_val === "string" && source_val.startsWith(prefix)) {
					result[key] = source_val;
				} else if (translate) {
					result[key] = source_val;
				} else {
					result[key] = `${prefix}${source_val}`;
				}
			} else {
				result[key] = target_val;
			}
		}
	}

	return result;
}

// -------------------- COUNTERS / HELPERS --------------------

// Count leaf (non-object) values in a nested JSON object tree.
export function count_leaves(obj: json_obj): number {
	let count = 0;
	for (const key of Object.keys(obj)) {
		if (is_object(obj[key])) {
			count += count_leaves(obj[key]);
		} else {
			count++;
		}
	}
	return count;
}

// Collect dot-notation paths of all leaf values in a nested object.
export function collect_leaf_paths(obj: json_obj, prefix: string = ""): string[] {
	const result: string[] = [];
	for (const key of Object.keys(obj)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (is_object(obj[key])) {
			result.push(...collect_leaf_paths(obj[key], path));
		} else {
			result.push(path);
		}
	}
	return result;
}

/**
 * Log detailed AI translation output - the raw JSON response and the list of translated keys.
 * Shared between sync_translations.ts (inline) and worker.ts (queue).
 */
export function log_translation_result(source_lang_name: string, target_lang_name: string, translated: json_obj, original_keys: json_obj): void {
	console.log(`   🔍 AI returned (${source_lang_name} → ${target_lang_name}):\n${JSON.stringify(translated, null, 2)}`);
	const num_keys = count_leaves(original_keys);
	console.log(`   ✅ Translated ${num_keys} keys into ${target_lang_name}:`);
	for (const k of collect_leaf_paths(original_keys)) {
		console.log(`      - ${k}`);
	}
}
