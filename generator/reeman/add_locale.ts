#!/usr/bin/env bun
/**
 * Add locale - interactively add a new language to the system
 * Uses direct function calls instead of spawning subprocesses.
 */

import { add_locale_to_system } from "../add_locale";
import { ask, BOLD, color, confirm, CYAN, dim, GREEN, header, RED, show_cli_tip } from "./ui";

export async function add_locale(): Promise<void> {
	header("Add locale");

	const locale_code = await ask("Locale code (BCP 47, e.g. 'it-it', 'fr-fr', 'de-at')");

	if (!locale_code) {
		console.log(`  ${color("No locale code specified.", RED)}`);
		return;
	}

	if (!/^[a-z]{2}-[A-Z]{2}$/.test(locale_code)) {
		console.log(`  ${color("Invalid locale code. Use BCP 47, such as 'it-it', 'fr-fr', or 'de-at'.", RED)}`);
		return;
	}

	console.log(`  ${color("✓", GREEN)} Locale code: ${color(BOLD + locale_code, CYAN)}`);

	const sync_translate = await confirm("Translate using AI? (uses OpenRouter - generates translations for all keys)", "y");

	if (sync_translate) {
		console.log(`  ${color("✓", GREEN)} Will translate using AI`);
	} else {
		console.log(`  ${dim("  (will copy English as starting point)")}`);
	}

	console.log(`\n${color("Running add language...", BOLD)}\n`);

	const success = await add_locale_to_system(locale_code, { translate: sync_translate });

	console.log();
	if (success) {
		console.log(`${color("✓ Done", GREEN)}`);
		await show_cli_tip(`bun reeman add-locale ${locale_code}${sync_translate ? " --translate" : ""}`, `Added locale: ${locale_code}`);
	} else {
		console.log(`${color("✗ Failed", RED)}`);
	}
}
