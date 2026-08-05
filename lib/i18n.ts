/**
 * Translation Repository - wraps translation state in a class to eliminate
 * module-level side effects and mutable exports.
 *
 * Usage:
 * import { translations } from "$lib/i18n";
 * await translations.initialize(); // loads from DB
 * await translations.reload();     // re-loads after DB updates
 * translations.get("sl-si");     // access locale data
 */

import { default_locale } from "$config/supported_locales";
import { unaliased_locales } from "$lib/locale";
import type { SQL } from "bun";

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

class TranslationRepository {
	private data: Record<string, any> | null = null;
	private db: SQL | null = null;
	// Version counter incremented on each reload - used for cache busting.
	private _version = 0;

	/**
	 * Initialize translations: load from DB only.
	 * Called once at server startup.
	 */
	async initialize(): Promise<void> {
		this.db = await this.load_db_silent();
		this.data = await this.load_from_db(unaliased_locales());

		if (Bun.argv.includes("--dev")) {
			const bytes = new TextEncoder().encode(JSON.stringify(this.data)).length;
			console.log("Translations:", bytes, "bytes");
		}
	}

	/**
	 * Reload translations from DB.
	 * Called after DB translations are updated by the sync script.
	 */
	async reload(): Promise<void> {
		if (!this.db) { this.db = await this.load_db_silent(); }
		this.data = await this.load_from_db(unaliased_locales());
		this._version++;
	}

	/**
	 * Reset translations state to uninitialized.
	 * Useful for testing - ensures a clean slate between tests.
	 */
	clear(): void {
		this.data = null;
		this.db = null;
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
	 * Load translations entirely from the database.
	 * The translations table is the single source of truth.
	 */
	private async load_from_db(target_locales: readonly string[]) {
		const merged: Record<string, any> = {};
		for (const locale of target_locales) {
			merged[locale] = {};
		}

		if (!this.db) return merged;

		try {
			const rows = await this.db`SELECT locale, namespace, key_path, translation FROM translations`;
			for (const row of rows) {
				const { locale, namespace, key_path, translation } = row as { locale: string; namespace: string; key_path: string; translation: string; };

				if (!target_locales.includes(locale)) continue;

				const parts = row_target_path(namespace, key_path);

				let target = merged[locale];
				for (let i = 0; i < parts.length - 1; i++) {
					const part = parts[i]!;
					if (!target[part] || typeof target[part] !== "object") { target[part] = {}; }
					target = target[part];
				}
				target[parts[parts.length - 1]!] = translation;
			}
		} catch {
			// translations table may not exist yet - skip silently
		}

		// Cross-locale DB fallback from the default locale
		if (target_locales.length > 1 && target_locales.includes(default_locale)) {
			for (const locale of target_locales) {
				if (locale === default_locale) continue;
				this.mark_missing_from(merged[default_locale], merged[locale], []);
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
			} else if (target[key] === undefined || target[key] === null || target[key] === "") {
				target[key] = `{${key}}`;
			}
		}
	}

	private async load_db_silent(): Promise<SQL | null> {
		try {
			const mod = await import("$config/db");
			return mod.db;
		} catch {
			return null;
		}
	}
}

export const translations = new TranslationRepository();
