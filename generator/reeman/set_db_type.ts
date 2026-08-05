#!/usr/bin/env bun
/**
 * Set database type - switch between MySQL and SQLite
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { sync_db_cli } from "$config/db_cli";

import { BOLD, color, CYAN, GREEN, header, select_from_list, show_cli_tip, YELLOW } from "./ui";

/**
 * Switch the active database type and update CONNECTION_STRING in .env.
 * @param type - "mysql" or "sqlite". When omitted, prompts for selection.
 */
export async function set_db_type(type?: "mysql" | "sqlite"): Promise<"mysql" | "sqlite" | null> {
	let db_choice: string;

	if (type) {
		db_choice = type;
	} else {
		header("Database type");

		const db_items = [
			{ value: "sqlite", label: "SQLite - CONNECTION_STRING=\"sqlite:app.db\"" },
			{
				value: "mysql",
				label: "MySQL / MariaDB - CONNECTION_STRING=\"mysql://user:pass@localhost/db\"",
			},
		];

		db_choice = await select_from_list("Select database type", db_items);

		if (!db_choice) {
			console.log(`  ${color("Cancelled.", YELLOW)}`);
			return null;
		}
	}

	const is_sqlite = db_choice === "sqlite";
	const db_type: "mysql" | "sqlite" = is_sqlite ? "sqlite" : "mysql";

	console.log(`  ${color("✓", GREEN)} Selected: ${color(BOLD + db_type.toUpperCase(), CYAN)}`);

	// Update .env - just uncomment the correct CONNECTION_STRING and comment the other
	const env_path = join(process.cwd(), ".env");
	const env_example_path = join(process.cwd(), ".env.example");

	let env_content: string;

	if (existsSync(env_path)) {
		env_content = await Bun.file(env_path).text();
	} else if (existsSync(env_example_path)) {
		env_content = await Bun.file(env_example_path).text();
		console.log(`  ${color("✓", GREEN)} Created .env from .env.example`);
	} else {
		console.log(`  ${color("No .env or .env.example found. Skipping CONNECTION_STRING update.", YELLOW)}`);
		return null;
	}

	const lines = env_content.split("\n");
	const target_keys = ["CONNECTION_STRING", "TEST_CONNECTION_STRING"];

	for (let i = 0; i < lines.length; i++) {
		const original = lines[i]!;
		const trimmed = original.trim();

		const conn_match = trimmed.match(/^(#\s*)?(?:export\s+)?(CONNECTION_STRING|TEST_CONNECTION_STRING)=(?:"([^"]*)"|'([^']*)'|(\S*))\s*$/);
		if (!conn_match) continue;
		const matched_key = conn_match[2] ?? "";
		if (!target_keys.includes(matched_key)) continue;

		const is_commented = !!conn_match[1];
		const value = conn_match[3] ?? conn_match[4] ?? conn_match[5] ?? "";
		const is_mysql_line = value.startsWith("mysql:");
		const is_sqlite_line = value.startsWith("sqlite:");

		const leading_ws = original.match(/^\s*/)?.[0] ?? "";

		if (is_sqlite_line && is_sqlite) {
			if (is_commented) { lines[i] = original.replace(/^\s*#\s*/, leading_ws); }
		} else if (is_sqlite_line && !is_sqlite) {
			if (!is_commented) { lines[i] = `${leading_ws}# ${original.trimStart()}`; }
		} else if (is_mysql_line && !is_sqlite) {
			if (is_commented) { lines[i] = original.replace(/^\s*#\s*/, leading_ws); }
		} else if (is_mysql_line && is_sqlite) {
			if (!is_commented) { lines[i] = `${leading_ws}# ${original.trimStart()}`; }
		}
	}

	env_content = lines.join("\n");

	await Bun.write(env_path, env_content);

	console.log(`  ${color("✓", GREEN)} Updated .env \u2192 ${is_sqlite ? "sqlite" : "mysql"} active (CONNECTION_STRING + TEST_CONNECTION_STRING)`);

	// Bun does not hot-reload .env into Bun.env after process start, so
	// sync_db_cli()'s Bun.env read would otherwise still see the value from
	// process boot. Re-read the file we just wrote and refresh Bun.env first.
	const refreshed_env_names = [
		"CONNECTION_STRING",
		"TEST_CONNECTION_STRING",
		"ADMIN_USERNAME",
		"ADMIN_EMAIL",
		"ADMIN_PASSWORD",
	];
	for (const env_name of refreshed_env_names) {
		const env_value = read_active_env_value(env_content, env_name);
		if (env_value) { Bun.env[env_name] = env_value; }
	}

	// Sync the live db_cli connection so subsequent reeman operations use the new DB
	await sync_db_cli();

	console.log(`\n  ${color("✓ Done", GREEN)} Database type set to ${db_type.toUpperCase()}. Restart the server for changes to take effect.`);
	await show_cli_tip(`bun reeman set-db-type ${db_type}`, `Set database type: ${db_type}`);

	return db_type;
}

// ---------------------------------------------------------------------------
// Read the active (uncommented) value of a key from in-memory .env content
// ---------------------------------------------------------------------------

function read_active_env_value(env_content: string, key: string): string | null {
	for (const line of env_content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;
		const match = trimmed.match(new RegExp(`^(?:export\\s+)?${key}=(?:"([^"]*)"|'([^']*)'|(\\S*))\\s*$`));
		if (match) {
			const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
			if (value) return value;
		}
	}
	return null;
}
