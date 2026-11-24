#!/usr/bin/env bun
/**
 * Install locale - interactively install an archived locale from
 * locales-archive/ back into the live tree (curated translations, no AI call).
 */

import { install_locale_from_archive, list_archived_locales } from "../install_locale";
import { ask, BOLD, color, confirm, CYAN, GREEN, header, RED, show_cli_tip, YELLOW } from "./ui";

export async function install_locale(): Promise<void> {
	header("Install archived locale");

	const available = await list_archived_locales();
	if (available.length === 0) {
		console.log(`  ${color("No archived locales found in locales-archive/.", YELLOW)}`);
		return;
	}
	console.log(`  ${color("✓", GREEN)} Archived locales: ${available.join(", ")}\n`);

	const locale_code = await ask("Locale code to install (e.g. 'de-de')");

	if (!locale_code) {
		console.log(`  ${color("No locale code specified.", RED)}`);
		return;
	}

	if (!/^[a-z]{2,3}-[a-z0-9]{2,8}$/.test(locale_code)) {
		console.log(`  ${color("Invalid locale code. Use lowercase BCP 47, such as 'de-de' or 'es-es'.", RED)}`);
		return;
	}

	console.log(`  ${color("✓", GREEN)} Locale code: ${color(BOLD + locale_code, CYAN)}`);

	const activate = await confirm("Activate immediately (serve to visitors)?", "n");

	console.log(`\n${color("Installing locale...", BOLD)}\n`);

	const success = await install_locale_from_archive(locale_code, { activate });

	console.log();
	if (success) {
		console.log(`${color("✓ Done", GREEN)}`);
		await show_cli_tip(
			`bun reeman install-locale ${locale_code}${activate ? " --activate" : ""}`,
			`Installed locale: ${locale_code}`
		);
	} else {
		console.log(`${color("✗ Failed", RED)}`);
	}
}
