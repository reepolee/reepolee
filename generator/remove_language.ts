#!/usr/bin/env bun
/**
 * Remove language - core logic and CLI entry point.
 *
 * CLI:  bun generator/remove_language.ts <lang_code> [--force]
 * reeman:  import { remove_language_from_system } from "./remove_language"
 *
 * Removes a language from config/supported_languages.ts, deletes DB translations,
 * removes JSON translation files, and cleans up cross-language references.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { db_cli } from "$config/db_cli";

// ---------------------------------------------------------------------------
// Exported API - callable from other modules
// ---------------------------------------------------------------------------

export interface RemoveLanguageOptions {
	// Skip confirmation prompts (non-interactive mode)
	force?: boolean;
	// New default language if removing the current default. Auto-picks first remaining if not set
	new_default?: string;
}

/**
 * Remove a language from the system.
 *
 * @param lang_code - 2-letter language code (e.g. "es", "fr", "de")
 * @param options - Options
 * @returns true if successful, false on failure
 */
export async function remove_language_from_system(lang_code: string, options: RemoveLanguageOptions = {}): Promise<boolean> {
	const force = options.force ?? false;

	if (!/^[a-z]{2}$/.test(lang_code)) {
		console.error(`Error: Invalid language code "${lang_code}". Use 2-letter code like "es", "fr", "de".`);
		return false;
	}

	console.log(`🚀 Removing language: ${lang_code}\n`);

	// -------------------------------------------------------------------
	// Step 1: Parse current supported languages from config file
	// -------------------------------------------------------------------
	const config_path = join(process.cwd(), "config", "supported_languages.ts");
	const config_content = readFileSync(config_path, "utf-8");

	// Extract current default language
	const default_match = config_content.match(/export const default_language\s*=\s*"([^"]+)"/);
	const default_lang = default_match ? default_match[1] : "en";

	// Extract languages array
	const langs_match = config_content.match(/export const languages\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
	if (!langs_match) {
		console.error("Error: Could not parse supported_languages.ts");
		return false;
	}

	const lang_items = langs_match[1].split(",")
		.map((l) => l.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);

	if (lang_items.length === 0) {
		console.error("Error: No languages found in config.");
		return false;
	}

	// Check language exists
	if (!lang_items.includes(lang_code)) {
		console.error(`Error: Language "${lang_code}" not found in supported languages.`);
		console.error(`   Available: ${lang_items.join(", ")}`);
		return false;
	}

	// Must keep at least one language
	if (lang_items.length <= 1) {
		console.error("Error: Cannot remove the last language. At least one language must remain.");
		return false;
	}

	// -------------------------------------------------------------------
	// Step 2: Determine new default if needed
	// -------------------------------------------------------------------
	const remaining = lang_items.filter((l) => l !== lang_code);
	let new_default = default_lang;

	if (default_lang === lang_code) {
		if (options.new_default && remaining.includes(options.new_default)) {
			new_default = options.new_default;
		} else if (force) {
			// Auto-pick first remaining language
			new_default = remaining[0];
			console.log(`   ⚠ Default language was "${default_lang}". Auto-selecting "${new_default}" as new default.`);
		} else {
			console.error(`Error: Language "${lang_code}" is the default. Specify --new-default <lang> to change it.`);
			console.error(`   Options: ${remaining.join(", ")}`);
			return false;
		}
	}

	console.log(`   Language: ${lang_code}`);
	console.log(`   Default:  ${default_lang === lang_code ? `${default_lang} → ${new_default}` : default_lang}`);
	console.log(`   Remaining: ${remaining.length} language(s)`);

	// -------------------------------------------------------------------
	// Step 3: Confirmation (skip if --force)
	// -------------------------------------------------------------------
	if (!force) {
		console.error("\nError: Use --force to confirm removal. This cannot be undone.");
		console.error(`Example: bun generator/remove_language.ts ${lang_code} --force`);
		return false;
	}

	console.log("\n📝 Updating config/supported_languages.ts...");

	let new_config = config_content;

	// Remove from languages array - split on comma and rebuild from clean codes
	// to handle any corrupted formatting (e.g. triple commas from previous runs)
	new_config = new_config.replace(/(export const languages\s*=\s*\[)([\s\S]*?)(\]\s*as\s+const)/, (_, open: string, middle: string, close: string) => {
		const codes = middle.split(",")
			.map((l: string) => l.trim().replace(/^"|"$/g, ""))
			.filter(Boolean)
			.filter((c: string) => c !== lang_code);
		if (codes.length === 0) return `${open}\n${close}`;
		return `${open}\n\t${codes.map((c: string) => `"${c}"`).join(",\n\t")},\n${close}`;
	});

	// Remove from active_languages array - same approach
	new_config = new_config.replace(/(export const active_languages\s*=\s*\[)([\s\S]*?)(\]\s*as\s+const)/, (_, open: string, middle: string, close: string) => {
		const codes = middle.split(",")
			.map((l: string) => l.trim().replace(/^"|"$/g, ""))
			.filter(Boolean)
			.filter((c: string) => c !== lang_code);
		if (codes.length === 0) return `${open}\n${close}`;
		return `${open}\n\t${codes.map((c: string) => `"${c}"`).join(",\n\t")},\n${close}`;
	});

	// Update default_language if needed
	if (new_default !== default_lang) { new_config = new_config.replace(/(export const default_language\s*=\s*)"([^"]+)"/, `$1"${new_default}"`); }

	// Remove from language_names record
	const lang_name_regex = new RegExp(`^\\t${lang_code}:\\s*"[^"]*",\\s*$`, "m");
	new_config = new_config.replace(lang_name_regex, "");

	// Remove from language_locales record
	const lang_locale_regex = new RegExp(`^\\t${lang_code}:\\s*"[^"]*",\\s*$`, "m");
	new_config = new_config.replace(lang_locale_regex, "");

	// Clean up any blank lines left inside record blocks
	new_config = new_config.replace(/(\{\n)(\n)+/g, "$1");
	new_config = new_config.replace(/(\n)(\n)*(\s*\})/g, "\n$3");

	writeFileSync(config_path, new_config, "utf-8");
	console.log("   ✓ Updated supported_languages.ts");

	// -------------------------------------------------------------------
	// Step 4: Delete translations from DB
	// -------------------------------------------------------------------
	console.log("\n📝 Deleting translations from database...");
	try {
		const [result] = await Promise.all([
			db_cli`DELETE FROM translations WHERE lang = ${lang_code}`,
			db_cli`DELETE FROM translations WHERE key_path = ${`ui.language_names.${lang_code}`}`,
			db_cli`DELETE FROM translations WHERE key_path = ${`ui.language_names_to.${lang_code}`}`,
		]);
		const count = (result as any)?.changes ?? (result as any)?.affectedRows ?? 0;
		console.log(`   ✓ Deleted ${count} translation(s) from DB for "${lang_code}"`);
		console.log("   ✓ Cleaned up cross-language references");
	} catch (err) {
		console.log(`   ⚠ Could not delete DB translations (DB may not be connected): ${err}`);
	}

	// -------------------------------------------------------------------
	// Done
	// -------------------------------------------------------------------
	console.log(`\n✓ Done. Language "${lang_code}" has been removed.`);
	if (new_default !== default_lang) { console.log(`   New default language: ${new_default}`); }
	console.log("   Restart the server for changes to take effect.");
	return true;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

function show_usage() {
	console.error("Usage: bun generator/remove_language.ts <lang_code> [--force] [--new-default <lang>]");
	console.error("Example: bun generator/remove_language.ts es --force");
	console.error("         bun generator/remove_language.ts en --force --new-default sl");
	console.error("\nRemoves a language from the system:");
	console.error("  - Updates config/supported_languages.ts");
	console.error("  - Deletes all translations from the DB");
	console.error("  - Cleans up cross-language references");
	console.error("\nFlags:");
	console.error("  --force            Confirm removal (required for non-interactive use)");
	console.error("  --new-default <l>  New default language if removing the current default");
	process.exit(1);
}

async function main() {
	const args = Bun.argv.slice(2);
	let lang_code = "";
	let force = false;
	let new_default = "";

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;

		if (arg === "--force") {
			force = true;
		} else if (arg === "--new-default" && i + 1 < args.length) {
			new_default = args[++i];
		} else if (!arg.startsWith("--")) {
			lang_code = arg;
		}
	}

	if (!lang_code) {
		console.error("Error: Language code is required");
		show_usage();
	}

	const success = await remove_language_from_system(lang_code, { force, new_default: new_default || undefined });
	process.exit(success ? 0 : 1);
}

// Only run as CLI when executed directly, not when imported as a module
if (import.meta.path === Bun.main) { main(); }
