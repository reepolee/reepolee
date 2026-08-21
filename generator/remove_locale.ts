#!/usr/bin/env bun
/**
 * Remove locale - core logic, used by `bun reeman remove-locale`.
 *
 * import { remove_locale_from_system } from "./remove_locale"
 *
 * Removes a language from config/supported_locales.ts, removes JSON translation
 * files, and cleans up cross-language references.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { normalize_locale } from "$lib/locale";
import { delete_file_translation, list_translation_files, read_all_translation_rows } from "$lib/translation_files";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface RemoveLocaleOptions {
	// Skip confirmation prompts (non-interactive mode)
	force?: boolean;
	// New default language if removing the current default. Auto-picks first remaining if not set
	new_default?: string;
}

/**
 * Remove a language from the system.
 *
 * @param locale_code - BCP 47 locale code (e.g. "es-es", "fr-fr", "de-at");
 * validated with Intl and normalized to lowercase immediately
 * @param options - Options
 * @returns true if successful, false on failure
 */
export async function remove_locale_from_system(locale_code: string, options: RemoveLocaleOptions = {}): Promise<boolean> {
	const force = options.force ?? false;

	try {
		locale_code = normalize_locale(locale_code);
	} catch {
		console.error(`Error: Invalid locale code "${locale_code}". Use a valid BCP 47 code like "es-es", "fr-fr", "de-at" (lowercase).`);
		return false;
	}

	console.log(`🚀 Removing language: ${locale_code}\n`);

	// -------------------------------------------------------------------
	// Step 1: Parse current supported languages from config file
	// -------------------------------------------------------------------
	const config_path = join(process.cwd(), "config", "supported_locales.ts");
	const config_content = readFileSync(config_path, "utf-8");

	// Extract current default language
	const default_match = config_content.match(/export const default_locale\s*=\s*"([^"]+)"/);
	const current_default = default_match ? default_match[1] : "en";

	// Extract languages array
	const locales_match = config_content.match(/export const locales\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
	if (!locales_match) {
		console.error("Error: Could not parse supported_locales.ts");
		return false;
	}

	const locale_items = locales_match[1]!.split(",")
		.map((l) => l.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);

	if (locale_items.length === 0) {
		console.error("Error: No languages found in config.");
		return false;
	}

	// Check language exists
	if (!locale_items.includes(locale_code)) {
		console.error(`Error: Language "${locale_code}" not found in supported languages.`);
		console.error(`   Available: ${locale_items.join(", ")}`);
		return false;
	}

	// Must keep at least one language
	if (locale_items.length <= 1) {
		console.error("Error: Cannot remove the last language. At least one language must remain.");
		return false;
	}

	// -------------------------------------------------------------------
	// Step 2: Determine new default if needed
	// -------------------------------------------------------------------
	const remaining = locale_items.filter((l) => l !== locale_code);
	let new_default = current_default;

	if (current_default === locale_code) {
		if (options.new_default && remaining.includes(options.new_default)) {
			new_default = options.new_default;
		} else if (force) {
			// Auto-pick first remaining language
			new_default = remaining[0];
			console.log(`   ⚠ Default language was "${current_default}". Auto-selecting "${new_default}" as new default.`);
		} else {
			console.error(`Error: Language "${locale_code}" is the default. Specify --new-default <lang> to change it.`);
			console.error(`   Options: ${remaining.join(", ")}`);
			return false;
		}
	}

	console.log(`   Language: ${locale_code}`);
	console.log(`   Default:  ${current_default === locale_code ? `${current_default} → ${new_default}` : current_default}`);
	console.log(`   Remaining: ${remaining.length} language(s)`);

	// -------------------------------------------------------------------
	// Step 3: Confirmation (skip if --force)
	// -------------------------------------------------------------------
	if (!force) {
		console.error("\nError: Use --force to confirm removal. This cannot be undone.");
		console.error(`Example: bun generator/remove_locale.ts ${locale_code} --force`);
		return false;
	}

	console.log("\n📝 Updating config/supported_locales.ts...");

	let new_config = config_content;

	// Remove from languages array - split on comma and rebuild from clean codes
	// to handle any corrupted formatting (e.g. triple commas from previous runs)
	new_config = new_config.replace(/(export const locales\s*=\s*\[)([\s\S]*?)(\]\s*as\s+const)/, (_, open: string, middle: string, close: string) => {
		const codes = middle.split(",")
			.map((l: string) => l.trim().replace(/^"|"$/g, ""))
			.filter(Boolean)
			.filter((c: string) => c !== locale_code);
		if (codes.length === 0) return `${open}\n${close}`;
		return `${open}\n\t${codes.map((c: string) => `"${c}"`).join(",\n\t")},\n${close}`;
	});

	// Remove from active_locales array - same approach
	new_config = new_config.replace(/(export const active_locales\s*=\s*\[)([\s\S]*?)(\]\s*as\s+const)/, (_, open: string, middle: string, close: string) => {
		const codes = middle.split(",")
			.map((l: string) => l.trim().replace(/^"|"$/g, ""))
			.filter(Boolean)
			.filter((c: string) => c !== locale_code);
		if (codes.length === 0) return `${open}\n${close}`;
		return `${open}\n\t${codes.map((c: string) => `"${c}"`).join(",\n\t")},\n${close}`;
	});

	// Update default_locale if needed
	if (new_default !== current_default) { new_config = new_config.replace(/(export const default_locale\s*=\s*)"([^"]+)"/, `$1"${new_default}"`); }

	// Remove from locale_names record
	const lang_name_regex = new RegExp(`^\\t${locale_code}:\\s*"[^"]*",\\s*$`, "m");
	new_config = new_config.replace(lang_name_regex, "");

	// Remove from language_locales record
	const lang_locale_regex = new RegExp(`^\\t${locale_code}:\\s*"[^"]*",\\s*$`, "m");
	new_config = new_config.replace(lang_locale_regex, "");

	// Clean up any blank lines left inside record blocks
	new_config = new_config.replace(/(\{\n)(\n)+/g, "$1");
	new_config = new_config.replace(/(\n)(\n)*(\s*\})/g, "\n$3");

	writeFileSync(config_path, new_config, "utf-8");
	console.log("   ✓ Updated supported_locales.ts");

	// -------------------------------------------------------------------
	// Step 4: Delete translation files and cross-language references
	// -------------------------------------------------------------------
	console.log("\n📝 Deleting translation files...");
	try {
		const files = await list_translation_files();
		const locale_files = files.filter((item) => item.locale === locale_code);
		for (const item of locale_files) await unlink(item.file);

		const rows = await read_all_translation_rows();
		const locale_name_key = `ui.locale_names.${locale_code}`;
		const language_name_to_key = `ui.language_names_to.${locale_code}`;
		const cross_references = rows.filter((row) => row.key_path === locale_name_key || row.key_path === language_name_to_key);
		for (const row of cross_references) await delete_file_translation(row.locale, row.namespace, row.key_path);

		console.log(`   ✓ Deleted ${locale_files.length} translation files for "${locale_code}"`);
		console.log("   ✓ Cleaned up cross-language references");
	} catch (err) {
		console.log(`   ⚠ Could not delete translation files: ${err}`);
	}

	// -------------------------------------------------------------------
	// Drop this locale's clone tables
	//
	// The config no longer lists the locale, so the syncer treats its tables
	// as stale and drops them. This destroys that locale's content - which is
	// what removing a locale means - so it is reported, never silent.
	// -------------------------------------------------------------------
	try {
		const { format_sync_actions, run_locale_table_sync } = await import("./locale_tables/run");
		const { results } = await run_locale_table_sync();
		for (const result of results) {
			for (const description of format_sync_actions(result.actions)) console.log(`   ✓ ${description}`);
		}
	} catch (err) {
		console.log(`   ⚠ Could not drop locale tables: ${err instanceof Error ? err.message : err}`);
	}

	// -------------------------------------------------------------------
	// Done
	// -------------------------------------------------------------------
	console.log(`\n✓ Done. Language "${locale_code}" has been removed.`);
	if (new_default !== current_default) { console.log(`   New default language: ${new_default}`); }
	console.log("   Restart the server for changes to take effect.");
	return true;
}
