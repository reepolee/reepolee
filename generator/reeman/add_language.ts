#!/usr/bin/env bun
/**
 * Add language - interactively add a new language to the system
 * Uses direct function calls instead of spawning subprocesses.
 */

import { add_language_to_system } from "../add_language";
import { ask, BOLD, color, confirm, CYAN, dim, GREEN, header, RED } from "./ui";

export async function add_language(): Promise<void> {
	header("Add language");

	const lang_code = await ask("Language code (2-letter, e.g. 'it', 'fr', 'es')");

	if (!lang_code) {
		console.log(`  ${color("No language code specified.", RED)}`);
		return;
	}

	if (!/^[a-z]{2}$/.test(lang_code)) {
		console.log(`  ${color("Invalid language code. Use a 2-letter lowercase code like 'it', 'fr', 'es'.", RED)}`);
		return;
	}

	console.log(`  ${color("✓", GREEN)} Language code: ${color(BOLD + lang_code, CYAN)}`);

	const sync_translate = await confirm("Translate using AI? (uses OpenRouter - generates translations for all keys)", "y");

	if (sync_translate) {
		console.log(`  ${color("✓", GREEN)} Will translate using AI`);
	} else {
		console.log(`  ${dim("  (will copy English as starting point)")}`);
	}

	console.log(`\n${color("Running add language...", BOLD)}\n`);

	const success = await add_language_to_system(lang_code, { translate: sync_translate });

	console.log();
	if (success) {
		console.log(`${color("✓ Done", GREEN)}`);
	} else {
		console.log(`${color("✗ Failed", RED)}`);
	}
}
