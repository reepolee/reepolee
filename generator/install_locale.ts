#!/usr/bin/env bun
/** Install a locale from a single validated locales-archive/{locale}.json bundle. */

import { read_supported_locales, write_supported_locales } from "$reeman/locales/config";
import { normalize_locale } from "$lib/locale";
import { notify_server_reload } from "$lib/server_notify";

import { install_archived_translation_bundle, list_archived_translation_bundles } from "./translation_bundle";

export async function list_archived_locales(project_dir: string = process.cwd()): Promise<string[]> {
	const bundles = await list_archived_translation_bundles(project_dir);
	return bundles.map((bundle) => bundle.code);
}

export interface ArchivedLocaleOption {
	code: string;
	name: string;
	file_count: number;
	is_current: boolean;
}

function display_name_for(code: string): string {
	try {
		const [language, region] = code.split("-");
		const tag = region ? `${language}-${region.toUpperCase()}` : language!;
		return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) || code;
	} catch {
		return code;
	}
}

export async function list_installable_archived_locales(project_dir: string = process.cwd()): Promise<ArchivedLocaleOption[]> {
	const cfg = read_supported_locales();
	const bundles = await list_archived_translation_bundles(project_dir);
	return bundles
		.filter((bundle) => !cfg.locales.includes(bundle.code))
		.map((bundle) => ({
			code: bundle.code,
			name: display_name_for(bundle.code),
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
	if (cfg.locales.includes(code)) {
		console.error(`Error: Locale "${code}" is already installed (listed in supported locales).`);
		return false;
	}

	try {
		const bundle = await install_archived_translation_bundle(code);
		console.log(`Installed ${Object.keys(bundle.files).length} translation file(s) from ${code}.json.`);
	} catch (error) {
		console.error(`Error: Could not install archived locale "${code}": ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}

	const next = { ...cfg };
	next.locales = [...cfg.locales, code];
	if (activate) next.active_locales = [...cfg.active_locales, code];
	next.locale_names = { ...cfg.locale_names, [code]: display_name_for(code) };
	write_supported_locales(next);

	try {
		await notify_server_reload();
	} catch {
		// The server may not be running. Files and config are already installed.
	}

	console.log(`Locale "${code}" installed${activate ? " and activated" : " as inactive"}.`);
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
