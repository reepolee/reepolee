#!/usr/bin/env bun
/**
 * Remove locale - interactively remove a language from the system (reeman wrapper)
 * Delegates to remove_locale_from_system() from the core module.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { remove_locale_from_system } from "../remove_locale";
import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, show_cli_tip, YELLOW } from "./ui";

export async function remove_locale(): Promise<void> {
	header("Remove locale");

	// Parse current supported languages from config file
	const config_path = join(process.cwd(), "config", "supported_locales.ts");
	const config_content = readFileSync(config_path, "utf-8");

	// Extract current default language
	const default_match = config_content.match(/export const default_locale\s*=\s*"([^"]+)"/);
	const current_default = default_match ? default_match[1] : "en";

	// Extract languages array
	const locales_match = config_content.match(/export const locales\s*=\s*\[([\s\S]*?)\]\s*as\s+const/);
	if (!locales_match) {
		console.log(`  ${color("Could not parse supported_locales.ts", RED)}`);
		return;
	}

	const locale_items = locales_match[1]!.split(",")
		.map((l) => l.trim().replace(/^"|"$/g, ""))
		.filter(Boolean);

	if (locale_items.length === 0) {
		console.log(`  ${color("No languages found in config.", RED)}`);
		return;
	}

	if (locale_items.length <= 1) {
		console.log(`  ${color("Cannot remove the last language. At least one language must remain.", RED)}`);
		return;
	}

	// Let user select which language to remove
	const items = locale_items.map((code) => ({
		value: code,
		label: `${code}  ${dim(`(${current_default === code ? "default, " : ""}${get_lang_name(config_content, code) || code})`)}`,
	}));

	const selected = await select_from_list("Select a language to remove", items);

	if (!selected) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	console.log(`  ${color("✓", GREEN)} Language: ${color(BOLD + selected, CYAN)}`);

	// Determine new default if removing current default
	let new_default: string | undefined;
	if (current_default === selected) {
		console.log(`  ${color("The language being removed is the default.", YELLOW)}`);
		const remaining = locale_items.filter((l) => l !== selected);
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

	const success = await remove_locale_from_system(selected, { force: true, new_default });

	console.log();
	if (success) {
		console.log(`${color("✓ Done", GREEN)}`);
		await show_cli_tip(`bun reeman remove-locale ${selected} --force${new_default ? ` --new-default ${new_default}` : ""}`, `Removed language: ${selected}`);
	} else {
		console.log(`${color("✗ Failed", RED)}`);
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function get_lang_name(config_content: string, code: string): string {
	const match = config_content.match(new RegExp(`^\\t${code}:\\s*"([^"]*)"`, "m"));
	return match ? match[1]! : "";
}
