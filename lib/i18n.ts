/**
 * Translation Repository - wraps translation state in a class to eliminate
 * module-level side effects and mutable exports.
 *
 * Usage:
 * import { translations } from "$lib/i18n";
 * await translations.initialize(); // loads co-located JSON files
 * await translations.reload();     // re-loads after file updates
 * translations.get("sl-si");     // access locale data
 */

import { default_locale } from "$config/supported_locales";
import { unaliased_locales } from "$lib/locale";
import { read_all_translation_rows } from "$lib/translation_files";

/**
 * Where a translations-table row lands in the merged per-language tree.
 *
 * - `nav` / `nav_prefix_title` rows are whole-app dictionaries keyed by
 *   namespace under `routes.nav.*` / `routes.nav_prefix_title.*`.
 * - Regular namespaced rows merge under their dotted namespace path.
 * - Root-namespace rows (empty or "root") merge under `routes.*`.
 */
export function row_target_path(namespace: string, key_path: string): string[] {
	if (key_path === "nav_prefix_title" && namespace) { return ["routes", "nav_prefix_title", ...namespace.split(".")]; }
	if (key_path === "nav" && namespace) { return ["routes", "nav", ...namespace.split(".")]; }
	if (namespace && namespace !== "root") { return [...namespace.split("."), ...key_path.split(".")]; }
	return ["routes", ...key_path.split(".")];
}

// Version counter, anchored to globalThis so it survives module re-evaluation.
//
// bun --hot can re-evaluate this module without re-evaluating the consumers
// that cache derived data keyed by version (lib/request_context.ts). A
// per-instance counter restarts at 0 on every re-evaluation, so a consumer
// holding version 0 compares equal to the fresh repository's 0 and never
// invalidates - it keeps serving translations loaded before the reload.
// A process-wide counter never repeats a value, so that comparison stays honest.
declare global {
	var __reepolee_translations_version: number | undefined;
}

function next_translations_version(): number {
	globalThis.__reepolee_translations_version = (globalThis.__reepolee_translations_version ?? 0) + 1;
	return globalThis.__reepolee_translations_version;
}

class TranslationRepository {
	private data: Record<string, any> | null = null;
	// Version counter bumped on each load - used for cache busting.
	private _version = 0;

	/**
	 * Initialize translations from co-located JSON files.
	 * Called once at server startup.
	 */
	async initialize(): Promise<void> {
		this.data = await this.load_all_translations(unaliased_locales());
		// Bump on initialize too, not just reload: a hot-reloaded module starts a
		// new repository whose data may differ from what consumers already cached.
		this._version = next_translations_version();

		if (Bun.argv.includes("--dev")) {
			const bytes = new TextEncoder().encode(JSON.stringify(this.data)).length;
			console.log("Translations:", bytes, "bytes");
		}
	}

	/**
	 * Reload translations from files.
	 * Called after translation files are updated.
	 */
	async reload(): Promise<void> {
		this.data = await this.load_all_translations(unaliased_locales());
		this._version = next_translations_version();
	}

	/**
	 * Reset translations state to uninitialized.
	 * Useful for testing - ensures a clean slate between tests.
	 */
	clear(): void {
		this.data = null;
	}

	/**
	 * Get translations for a specific language.
	 */
	get(locale: string): Record<string, any> | undefined { return this.data?.[locale]; }

	/**
	 * Version counter, incremented on each reload.
	 * Consumers can use this to bust their own caches.
	 */
	get version(): number { return this._version; }

	/**
	 * Get the full translations data object (all locales), keyed by locale code.
	 */
	get all(): Record<string, any> { return this.data ?? {}; }

	/**
	 * Load translations from the canonical JSON tree.
	 */
	private async load_all_translations(target_locales: readonly string[], project_dir?: string, fallback_locale: string = default_locale) {
		const merged: Record<string, any> = {};
		for (const locale of target_locales) {
			merged[locale] = {};
		}

		const rows = await read_all_translation_rows(project_dir);
		for (const row of rows) {
			const { locale, namespace, key_path, translation } = row;
			if (!target_locales.includes(locale)) continue;

			const parts = row_target_path(namespace, key_path);
			let target = merged[locale];
			for (let index = 0; index < parts.length - 1; index++) {
				const part = parts[index]!;
				if (!target[part] || typeof target[part] !== "object") { target[part] = {}; }
				target = target[part];
			}
			target[parts[parts.length - 1]!] = translation;
		}

		// Cross-locale fallback from the default locale
		if (target_locales.length > 1 && target_locales.includes(fallback_locale)) {
			for (const locale of target_locales) {
				if (locale === fallback_locale) continue;
				this.mark_missing_from(merged[fallback_locale], merged[locale], []);
			}
		}

		return merged;
	}

	private mark_missing_from(source: any, target: any, path_parts: string[]) {
		for (const key of Object.keys(source || {})) {
			if (key === "route_name") continue;

			const val = source[key];
			const current_parts = [...path_parts, key];

			if (typeof val === "object" && val !== null && !Array.isArray(val)) {
				if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) { target[key] = {}; }
				this.mark_missing_from(val, target[key], current_parts);
			} else if (target[key] === undefined || target[key] === null) {
				// Only undefined/null count as missing. An empty string is a valid
				// translation (e.g. an intentionally empty unit suffix) and must
				// survive the fallback untouched - not be replaced with the
				// "{key}" missing marker.
				target[key] = `{${key}}`;
			}
		}
	}
}

// The repository *instance* is anchored to globalThis, not just its version
// counter. bun --hot re-evaluates this module on any file change, but
// Bun.serve keeps the fetch closure captured at bootstrap, so the internal
// admin endpoints (POST /__reload-translations) stay pinned to the first
// generation while request handlers - reached through the globalThis route
// table - run in the newest one. With one repository per module instance the
// endpoint reloaded an object nothing served from: the reload reported OK and
// the browser kept the old strings until a full restart. A single shared
// instance keeps the writer and the reader on the same data.
declare global {
	var __reepolee_translations_repo: TranslationRepository | undefined;
}

if (!globalThis.__reepolee_translations_repo) { globalThis.__reepolee_translations_repo = new TranslationRepository(); }

export const translations = globalThis.__reepolee_translations_repo;
