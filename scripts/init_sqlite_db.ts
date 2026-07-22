#!/usr/bin/env bun
/**
 * Non-interactive DB init for `reepolee:install`, run right after copy_env.ts
 * so `bun dev` works immediately after install. Only applies when
 * CONNECTION_STRING (freshly read from .env) is SQLite, and only runs core
 * DDL + EN translations (no other language, no example data) - mirrors the
 * statement-splitting used by generator/reeman/quick_start.ts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { SQL } from "bun";

async function read_connection_string_from_env(): Promise<string | null> {
	const env_path = join(process.cwd(), ".env");
	if (!existsSync(env_path)) return null;

	const content = await Bun.file(env_path).text();
	const lines = content.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^(?:export\s+)?CONNECTION_STRING=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/);
		if (match) {
			const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
			if (value) return value;
		}
	}
	return null;
}

const conn_str = await read_connection_string_from_env();

if (!conn_str || conn_str.toLowerCase().startsWith("mysql://")) {
	console.log("[init-db] CONNECTION_STRING is not SQLite - skipping DB init");
	process.exit(0);
}

const SQL_FILES = ["sql/sqlite/01-init-sqlite.sql", "sql/sqlite/02-init-translations-en.sql"];

const keepalive = setInterval(() => {}, 2_147_483_647);
const db = new SQL(conn_str);

try {
	for (const file of SQL_FILES) {
		const file_path = join(process.cwd(), file);
		const file_content = await Bun.file(file_path).text();

		const sql_no_comments = file_content.split("\n")
			.map((line) => line.trimStart())
			.filter((line) => !line.startsWith("--"))
			.join("\n");

		const statements = (sql_no_comments.match(/\s*CREATE\s+TRIGGER[\s\S]*?END\s*;|[^;]+;/gi) || []).map((stmt) => stmt.replace(/;\s*$/, "").trim()).filter((stmt) => stmt.length > 0 && !stmt.match(
			/^\s*--/
		));

		console.log(`[init-db] ${file}: ${statements.length} statement(s)`);

		for (const stmt of statements) {
			await db.unsafe(stmt);
		}
	}
	console.log("[init-db] SQLite database initialized (DDL + EN translations)");
} finally {
	clearInterval(keepalive);
	await db.close();
}
