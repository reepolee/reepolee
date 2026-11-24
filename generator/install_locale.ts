#!/usr/bin/env bun
/** Install a locale from a single validated locales-archive/{locale}.json bundle. */

import { default_locale } from "$config/supported_locales";
import { read_supported_locales, write_supported_locales } from "$reeman/locales/config";
import { normalize_locale } from "$lib/locale";
import { notify_server_reload } from "$lib/server_notify";

import { install_archived_translation_bundle, list_archived_translation_bundles } from "./translation_bundle";

/** Archived locales installable from disk. The default locale's archive (if any) is the current English snapshot, never something to install. */
export async function list_archived_locales(project_dir: string = process.cwd()): Promise<string[]> {
	const bundles = await list_archived_translation_bundles(project_dir);
	return bundles.filter((bundle) => bundle.code !== default_locale).map((bundle) => bundle.code);
}

export interface ArchivedLocaleOption {
	code: string;
	name: string;
	file_count: number;
	is_current: boolean;
}

/** Display-only name for a BCP-47 code via Intl, falling back to the bare code.
 * Not persisted - the install write uses this same helper with its default "en". */
function display_name_for(code: string, display_locale: string = "en"): string {
	try {
		const [language, region] = code.split("-");
		const tag = region ? `${language}-${region.toUpperCase()}` : language!;
		return new Intl.DisplayNames([display_locale], { type: "language" }).of(tag) || code;
	} catch {
		return code;
	}
}

export async function list_installable_archived_locales(project_dir: string = process.cwd(), display_locale: string = "en"): Promise<ArchivedLocaleOption[]> {
	const cfg = read_supported_locales();
	const bundles = await list_archived_translation_bundles(project_dir);
	return bundles
		.filter((bundle) => !cfg.locales.includes(bundle.code))
		.map((bundle) => ({
			code: bundle.code,
			name: display_name_for(bundle.code, display_locale),
			file_count: bundle.file_count,
			is_current: bundle.is_current,
		}));
}

export interface InstallLocaleOptions {
	activate?: boolean;
}

export async function install_locale_from_archive(locale_code: string, options: InstallLocaleOptions = {}): Promise<boolean> {
	const activate = options.activate ?? false;
	let code: string;
	try {
		code = normalize_locale(locale_code);
	} catch {
		console.error(`Error: Invalid locale code "${locale_code}". Use a valid BCP 47 code like "de-de" (lowercase).`);
		return false;
	}

	const cfg = read_supported_locales();
	const is_installed = cfg.locales.includes(code);
	const needs_activation = activate && !cfg.active_locales.includes(code);

	try {
		const bundle = await install_archived_translation_bundle(code);
		console.log(`Restored ${Object.keys(bundle.routes).length} translation route(s) from ${code}.json.`);
	} catch (error) {
		console.error(`Error: Could not install archived locale "${code}": ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}

	const next = { ...cfg };
	if (!is_installed) {
		next.locales = [...cfg.locales, code];
		next.locale_names = { ...cfg.locale_names, [code]: display_name_for(code) };
	}
	if (!is_installed) write_supported_locales(next);

	console.log(`Synchronizing localized tables for ${code}...`);
	try {
		const { format_sync_actions, run_locale_table_sync } = await import("./locale_tables/run");
		const { results } = await run_locale_table_sync();
		for (const result of results) {
			const descriptions = format_sync_actions(result.actions);
			for (const description of descriptions) console.log(`   ✓ ${description}`);
		}
	} catch (error) {
		console.error(`Error: Could not synchronize localized tables for "${code}": ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}

	if (needs_activation) {
		const activated = { ...next, active_locales: [...next.active_locales, code] };
		write_supported_locales(activated);
	}

	try {
		await notify_server_reload();
	} catch {
		// The server may not be running. Files and config are already installed.
	}

	console.log(`Locale "${code}" ${is_installed ? "restored" : "installed"}${needs_activation ? " and activated" : ""}.`);
	return true;
}

if (import.meta.main) {
	const code = process.argv[2] ?? "";
	const activate = process.argv.includes("--activate");
	if (!code) {
		console.error("Usage: bun generator/install_locale.ts <locale_code> [--activate]");
		process.exit(1);
	}
	const ok = await install_locale_from_archive(code, { activate });
	process.exit(ok ? 0 : 1);
}
