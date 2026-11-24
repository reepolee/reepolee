#!/usr/bin/env bun
/**
 * Add locale - interactively add a new language to the system
 * Uses direct function calls instead of spawning subprocesses.
 *
 * Offers two paths, same as the reeman web UI's Add Locale dialog:
 * 1. Activate - pick from locales already in config/supported_locales.ts
 *    `locales` (translations already generated) but not yet `active_locales`.
 *    Fast: just runs the locale's prepared init SQL and flips the flag.
 * 2. Add - a brand new BCP 47 code, translated via AI or copied from English.
 */

import { read_supported_locales } from "$reeman/locales/config";

import { add_locale_to_system } from "../add_locale";
import { ask, BOLD, color, confirm, CYAN, dim, GREEN, header, multi_select, RED, show_cli_tip, YELLOW } from "./ui";

export async function add_locale(): Promise<void> {
	header("Add locale");

	const cfg = read_supported_locales();
	const inactive = cfg.locales.filter((code) => !cfg.active_locales.includes(code));

	if (inactive.length > 0) {
		const activate = await confirm(`${inactive.length} locale(s) already supported but not active (${inactive.join(", ")}). Activate some now?`, "y");

		if (activate) {
			const items = inactive.map((code) => ({ value: code, label: `${code}${cfg.locale_names[code] ? ` - ${cfg.locale_names[code]}` : ""}` }));
			const selected = await multi_select("Select locales to activate (arrows + space + enter)", items);

			if (selected.length === 0) {
				console.log(`  ${color("No locales selected.", YELLOW)}`);
				return;
			}

			console.log(`\n${color("Activating locale(s)...", BOLD)}\n`);
			const { activate_locales_in_system } = await import("../activate_locale");
			const result = await activate_locales_in_system(selected);

			console.log();
			if (result.ok) {
				console.log(`${color("✓ Done", GREEN)} Activated: ${result.activated.join(", ")}`);
				await show_cli_tip(`bun reeman activate-locales ${result.activated.join(" ")}`, `Activated locale(s): ${result.activated.join(", ")}`);
			} else {
				console.log(`${color("✗ Failed", RED)} ${result.error || ""}`);
			}
			return;
		}
	}

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
