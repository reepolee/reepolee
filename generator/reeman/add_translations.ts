#!/usr/bin/env bun
/**
 * Add explicitly supplied translation records to the database.
 */

import { db_cli } from "$config/db_cli";
import { notify_server_reload } from "$lib/server_notify";
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

	const existing = await db_cli`SELECT 1 FROM translations WHERE locale = ${locale} AND namespace = ${namespace} AND key_path = ${key_path} LIMIT 1`;
	if (existing.length > 0) {
		console.log(`  ${color("Translation already exists.", RED)}`);
		return;
	}

	await db_cli`INSERT INTO translations (locale, namespace, key_path, translation) VALUES (${locale}, ${namespace}, ${key_path}, ${translation})`;
	await notify_server_reload();
	console.log(`  ${color("✓", GREEN)} Added ${color(BOLD + `${locale}:${namespace}:${key_path}`, CYAN)}`);
}
