#!/usr/bin/env bun
/**
 * Activate locale - fast path for turning on a locale that is already in
 * config/supported_locales.ts `locales` and has curated translation files.
 */

import { read_supported_locales, write_supported_locales } from "$reeman/locales/config";
import { notify_server_reload } from "$lib/server_notify";
import { list_translation_files } from "$lib/translation_files";

export interface ActivateLocaleResult {
	ok: boolean;
	activated: string[];
	error?: string;
}

export interface AvailableSeedLocale {
	code: string;
	name: string;
}

/** Human-readable name for a BCP-47 code via Intl, falling back to the bare code. */
function display_name_for(code: string): string {
	try {
		const [lang, region] = code.split("-");
		const tag = region ? `${lang}-${region.toUpperCase()}` : lang!;
		return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) || code;
	} catch {
		return code;
	}
}

/**
 * Curated JSON locale files whose code is not yet in `locales`.
 */
export async function list_available_seed_locales(): Promise<AvailableSeedLocale[]> {
	const cfg = read_supported_locales();
	const files = await list_translation_files();
	const locale_codes = [...new Set(files.map((item) => item.locale))];
	const found: AvailableSeedLocale[] = [];
	for (const code of locale_codes) {
		if (cfg.locales.includes(code)) continue;
		found.push({ code, name: display_name_for(code) });
	}
	found.sort((a, b) => a.code.localeCompare(b.code));
	return found;
}

/**
 * Verify that a locale has curated JSON files before activation.
 */
export async function run_locale_init_sql(locale_code: string): Promise<boolean> {
	const files = await list_translation_files();
	return files.some((item) => item.locale === locale_code);
}

/**
 * Activate one or more locales that are already in `locales` but not in
 * `active_locales`. Verifies locale files before flipping the config.
 */
export async function activate_locales_in_system(locale_codes: string[]): Promise<ActivateLocaleResult> {
	const cfg = read_supported_locales();
	const to_activate = locale_codes.filter((code) => cfg.locales.includes(code) && !cfg.active_locales.includes(code));

	if (to_activate.length === 0) {
		return { ok: false, activated: [], error: "No inactive supported locale codes given." };
	}

	const activated: string[] = [];
	for (const code of to_activate) {
		const ran = await run_locale_init_sql(code);
		if (!ran) {
			return { ok: false, activated, error: `No translation files found for "${code}".` };
		}
		cfg.active_locales = [...new Set([...cfg.active_locales, code])];
		activated.push(code);
	}

	write_supported_locales(cfg);

	await notify_server_reload();

	return { ok: true, activated };
}
