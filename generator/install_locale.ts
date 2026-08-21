#!/usr/bin/env bun
/**
 * Install locale from archive - core logic for `bun reeman install-locale`.
 *
 * import { install_locale_from_archive } from "./install_locale"
 *
 * Locales other than en-us and sl-si ship archived under locales-archive/
 * (mirroring each file's path from the repo root) and are not served by
 * default. Installing a locale copies its archived translation files back
 * into place and registers it in config/supported_locales.ts, so it becomes
 * a served locale. No AI call is made - the archived files are the curated
 * translations.
 */

import { copyFile, mkdir, readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { existsSync } from "node:fs";

import { read_supported_locales, write_supported_locales } from "$reeman/locales/config";
import { normalize_locale } from "$lib/locale";
import { notify_server_reload } from "$lib/server_notify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ARCHIVE_DIR = "locales-archive";

async function walk(dir: string, out: string[]): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, out);
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
	return out;
}

/** Archived locale files for `locale_code`, as absolute paths. */
export async function list_archived_locale_files(locale_code: string, project_dir: string = process.cwd()): Promise<string[]> {
	const archive_root = join(project_dir, ARCHIVE_DIR);
	if (!existsSync(archive_root)) return [];
	const all = await walk(archive_root, []);
	return all.filter((file) => file.endsWith(`/${locale_code}.json`));
}

/** All locale codes present in the archive. */
export async function list_archived_locales(project_dir: string = process.cwd()): Promise<string[]> {
	const archive_root = join(project_dir, ARCHIVE_DIR);
	if (!existsSync(archive_root)) return [];
	const all = await walk(archive_root, []);
	const codes = new Set<string>();
	for (const file of all) {
		const match = /\/([a-z]{2,3}-[a-z0-9]{2,8})\.json$/.exec(file);
		if (match) codes.add(match[1]!);
	}
	return [...codes].sort();
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

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface InstallLocaleOptions {
	// Register the locale in active_locales as well as locales (served to
	// visitors immediately). Defaults to false - install is not activation;
	// use `bun reeman activate-locales` to flip it on.
	activate?: boolean;
}

/**
 * Install an archived locale: copy its translation files back into the live
 * tree and register it in config/supported_locales.ts.
 *
 * @returns true if installed, false on failure
 */
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

	const archived = await list_archived_locale_files(code);
	if (archived.length === 0) {
		const available = await list_archived_locales();
		console.error(`Error: No archived translation files found for "${code}".`);
		if (available.length > 0) console.error(`   Archived locales: ${available.join(", ")}`);
		return false;
	}

	console.log(`🚀 Installing locale: ${code} (${display_name_for(code)})\n`);

	// -------------------------------------------------------------------
	// Step 1: Copy archived files back into place
	// -------------------------------------------------------------------
	console.log(`📝 Step 1: Restoring ${archived.length} translation file(s) from ${ARCHIVE_DIR}/...`);
	const project_dir = process.cwd();
	for (const file of archived) {
		const rel = relative(join(project_dir, ARCHIVE_DIR), file);
		const dest = join(project_dir, rel);
		await mkdir(dirname(dest), { recursive: true });
		await copyFile(file, dest);
		console.log(`   ✓ ${rel.split(sep).join("/")}`);
	}

	// -------------------------------------------------------------------
	// Step 2: Register in config/supported_locales.ts
	// -------------------------------------------------------------------
	console.log("\n📝 Step 2: Updating config/supported_locales.ts...");
	const next = { ...cfg };
	next.locales = [...cfg.locales, code];
	if (activate) next.active_locales = [...cfg.active_locales, code];
	next.locale_names = { ...cfg.locale_names, [code]: display_name_for(code) };
	write_supported_locales(next);
	console.log(`   ✓ Added "${code}" to locales${activate ? " and active_locales" : ""}`);

	// -------------------------------------------------------------------
	// Step 3: Notify the server to pick up the new translations
	// -------------------------------------------------------------------
	try {
		await notify_server_reload();
	} catch {
		// Server may not be running - files and config are already in place.
	}

	console.log(`\n✓ Done. Locale "${code}" installed.`);
	if (!activate) {
		console.log(`   Run "bun reeman activate-locales ${code}" to serve it to visitors.`);
	}
	console.log("   Restart the server for changes to take effect.");
	return true;
}

// ---------------------------------------------------------------------------
// CLI entry - run directly: bun generator/install_locale.ts <locale_code> [--activate]
// ---------------------------------------------------------------------------

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
