import { add_locale_alias_to_system } from "../add_locale_alias";
import { ask, color, GREEN, header, RED, show_cli_tip } from "./ui";

export async function add_locale_alias(): Promise<void> {
	header("Add locale alias");

	const alias_locale = await ask("Alias (new) locale (BCP 47, e.g. 'de-at')");
	const target_locale = await ask("Target (existing) locale (BCP 47, e.g. 'de-de')");
	const success = await add_locale_alias_to_system(alias_locale, target_locale);

	console.log();
	if (success) {
		console.log(`${color("✓ Done", GREEN)}`);
		await show_cli_tip(`bun reeman add-locale-alias ${alias_locale} ${target_locale}`, `Added alias: ${alias_locale} -> ${target_locale}`);
		return;
	}

	console.log(`${color("✗ Failed", RED)}`);
}
