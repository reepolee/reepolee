#!/usr/bin/env bun
/**
 * Add an explicitly supplied translation to its namespace file.
 */

import { notify_server_reload } from "$lib/server_notify";
import { get_dotted, read_namespace_file, upsert_file_translation } from "$lib/translation_files";
import { ask, BOLD, color, CYAN, GREEN, header, RED } from "./ui";

export async function add_translations(): Promise<void> {
	header("Add translation");

	const locale = await ask("Language code");
	const namespace = await ask("Namespace (leave empty for root)");
	const key_path = await ask("Key path");
	const translation = await ask("Translation");

	if (!locale || !key_path || !translation) {
		console.log(`  ${color("All fields are required.", RED)}`);
		return;
	}

	const normalized_namespace = namespace || "root";
	const obj = await read_namespace_file(normalized_namespace, locale);
	if (get_dotted(obj, key_path) !== undefined) {
		console.log(`  ${color("Translation already exists.", RED)}`);
		return;
	}

	await upsert_file_translation(locale, normalized_namespace, key_path, translation);
	await notify_server_reload();
	console.log(`  ${color("✓", GREEN)} Added ${color(BOLD + `${locale}:${namespace}:${key_path}`, CYAN)}`);
}
