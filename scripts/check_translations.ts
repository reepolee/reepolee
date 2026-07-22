#!/usr/bin/env bun
import { close_db_cli, db_cli } from "$config/db_cli";

try {
	const rows = await db_cli.unsafe(`
		SELECT lang, namespace, key_path, translation
		FROM translations
		WHERE key_path IN ('username_or_email','username_required','username_exists','invalid_username_or_password','username')
		ORDER BY namespace, key_path, lang
	`);
	for (const r of rows) {
		console.log(`${r.lang.padEnd(4)} ${r.namespace.padEnd(28)} ${r.key_path.padEnd(32)} ${r.translation}`);
	}
	console.log(`\nTotal: ${rows.length} rows`);
} finally {
	await close_db_cli();
}
