import { join } from "node:path";

import { default_locale, locale_aliases, locale_names, locales } from "$config/supported_locales";
import { normalize_locale } from "$lib/locale";
import { notify_server_reload } from "$lib/server_notify";

export async function add_locale_alias_to_system(alias_locale: string, target_locale: string): Promise<boolean> {
	try {
		alias_locale = normalize_locale(alias_locale);
		target_locale = normalize_locale(target_locale);
	} catch {
		console.error("Error: Locale aliases must use valid BCP 47 codes such as \"de-at\" and \"de-de\" (lowercase).");
		return false;
	}
	if (!locales.includes(target_locale as never)) {
		console.error(`Error: Alias target \"${target_locale}\" must already exist in supported_locales.ts.`);
		return false;
	}
	if (alias_locale === default_locale) {
		console.error(`Error: Default locale \"${default_locale}\" cannot be aliased.`);
		return false;
	}
	if (alias_locale === target_locale) {
		console.error("Error: A locale cannot alias itself.");
		return false;
	}
	if (locale_aliases[alias_locale]) {
		console.error(`Error: Locale \"${alias_locale}\" is already aliased to \"${locale_aliases[alias_locale]}\".`);
		return false;
	}
	if (locale_aliases[target_locale]) {
		console.error(`Error: Alias target \"${target_locale}\" is itself aliased.`);
		return false;
	}
	const target_name = locale_names[target_locale];
	if (!target_name) {
		console.error(`Error: Alias target \"${target_locale}\" has no locale_names label.`);
		return false;
	}

	const config_path = join(process.cwd(), "config", "supported_locales.ts");
	const config_file = Bun.file(config_path);
	const config_content = await config_file.text();
	const alias_exists = locales.includes(alias_locale as never);
	let updated_content = config_content;
	if (!alias_exists) {
		updated_content = add_locale_to_config_list(updated_content, "locales", alias_locale);
		updated_content = add_locale_to_config_list(updated_content, "active_locales", alias_locale);
		updated_content = add_locale_name_to_config(updated_content, alias_locale, target_name);
	}

	const next_aliases = { ...locale_aliases, [alias_locale]: target_locale };
	const alias_lines: string[] = [];
	for (const [from, to] of Object.entries(next_aliases)) {
		alias_lines.push(`\t\"${from}\": \"${to}\",`);
	}
	const replacement = `export const locale_aliases: Record<string, string> = {\n${alias_lines.join("\n")}\n};`;
	updated_content = updated_content.replace(/export const locale_aliases: Record<string, string> = \{[\s\S]*?\};/, replacement);
	if (updated_content === config_content) {
		console.error("Error: Could not find locale_aliases in config/supported_locales.ts.");
		return false;
	}

	await Bun.write(config_path, updated_content);
	await notify_server_reload();
	console.log(`✓ Added locale alias: ${alias_locale} -> ${target_locale}`);
	return true;
}

function add_locale_to_config_list(config_content: string, list_name: "locales" | "active_locales", locale: string): string {
	const list_pattern = new RegExp(`export const ${list_name} = \\[([\\s\\S]*?)\\] as const;`);
	const match = config_content.match(list_pattern);
	if (!match) throw new Error(`Could not find ${list_name} in config/supported_locales.ts.`);
	const list_content = match[1] ?? "";
	const values: string[] = [];
	const locale_matches = list_content.matchAll(/"([^"\\]+)"/g);
	for (const entry of locale_matches) {
		const value = entry[1];
		if (value !== undefined) values.push(value);
	}
	if (!values.includes(locale)) values.push(locale);

	const value_lines: string[] = [];
	for (const value of values) {
		value_lines.push(`\t${JSON.stringify(value)},`);
	}
	const replacement = `export const ${list_name} = [\n${value_lines.join("\n")}\n] as const;`;
	return config_content.replace(list_pattern, replacement);
}

function add_locale_name_to_config(config_content: string, locale: string, name: string): string {
	const names_pattern = /export const locale_names: Record<string, string> = \{([\s\S]*?)\};/;
	const match = config_content.match(names_pattern);
	if (!match) throw new Error("Could not find locale_names in config/supported_locales.ts.");
	const names_content = match[1] ?? "";
	const entries = new Map<string, string>();
	const name_matches = names_content.matchAll(/"([^"\\]+)"\s*:\s*"([^"\\]*)"/g);
	for (const entry of name_matches) {
		const entry_locale = entry[1];
		const entry_name = entry[2];
		if (entry_locale !== undefined && entry_name !== undefined) entries.set(entry_locale, entry_name);
	}
	entries.set(locale, name);

	const entry_lines: string[] = [];
	for (const [entry_locale, entry_name] of entries) {
		entry_lines.push(`\t${JSON.stringify(entry_locale)}: ${JSON.stringify(entry_name)},`);
	}
	const replacement = `export const locale_names: Record<string, string> = {\n${entry_lines.join("\n")}\n};`;
	return config_content.replace(names_pattern, replacement);
}
