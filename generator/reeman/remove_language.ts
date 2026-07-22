#!/usr/bin/env bun
/**
 * Remove language - interactively remove a language from the system (reeman wrapper)
 * Delegates to remove_language_from_system() from the core module.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { remove_language_from_system } from "../remove_language";
import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, YELLOW } from "./ui";

export async function remove_language(): Promise<void> {
	header("Remove language");

	// Parse current supported languages from config file
	const config_path = join(process.cwd(), "config", "supported_languages.ts");
	const config_content = readFileSync(config_path, "utf-8");

	// Extract current default language
	const default_match = config_content.match(/export const default_language\s*=\s*"([^"]+)"/);
	const default_lang = default_match ? default_match[1] : "en";

	// Extract languages array
	const langs_match = config_content.match(/export const languages\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
	if (!langs_match) {
		console.log(`  ${color("Could not parse supported_languages.ts", RED)}`);
		return;
	}

	const lang_items = langs_match[1].split(",")
		.map((l) => l.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);

	if (lang_items.length === 0) {
		console.log(`  ${color("No languages found in config.", RED)}`);
		return;
	}

	if (lang_items.length <= 1) {
		console.log(`  ${color("Cannot remove the last language. At least one language must remain.", RED)}`);
		return;
	}

	// Let user select which language to remove
	const items = lang_items.map((code) => ({
		value: code,
		label: `${code}  ${dim(`(${default_lang === code ? "default, " : ""}${get_lang_name(config_content, code) || code})`)}`,
	}));

	const selected = await select_from_list("Select a language to remove", items);

	if (!selected) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	console.log(`  ${color("✓", GREEN)} Language: ${color(BOLD + selected, CYAN)}`);

	// Determine new default if removing current default
	let new_default: string | undefined;
	if (default_lang === selected) {
		console.log(`  ${color("The language being removed is the default.", YELLOW)}`);
		const remaining = lang_items.filter((l) => l !== selected);
		const default_items = remaining.map((code) => ({
			value: code,
			label: `${code}  ${dim(get_lang_name(config_content, code) || code)}`,
		}));

		const chosen = await select_from_list("Select new default language", default_items);
		if (!chosen) {
			console.log(`  ${color("A new default language must be selected.", RED)}`);
			return;
		}
		new_default = chosen;
		console.log(`  ${color("✓", GREEN)} New default: ${color(BOLD + new_default, CYAN)}`);
	}

	// Confirm
	const proceed = await confirm(`Remove "${selected}" and all its translations? This cannot be undone.`, "n");
	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	console.log(`\n${color("Removing language...", BOLD)}\n`);

	const success = await remove_language_from_system(selected, { force: true, new_default });

	console.log();
	if (success) {
		console.log(`${color("✓ Done", GREEN)}`);
	} else {
		console.log(`${color("✗ Failed", RED)}`);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get_lang_name(config_content: string, code: string): string {
	const match = config_content.match(new RegExp(`^\\t${code}:\\s*"([^"]*)"`, "m"));
	return match ? match[1] : "";
}
