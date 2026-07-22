#!/usr/bin/env bun
/**
 * Run SQL file - select and execute a .sql file against the database
 */

import { join } from "node:path";

import { db_cli } from "$config/db_cli";

import { BOLD, color, confirm, CYAN, dim, GREEN, header, RED, select_from_list, YELLOW } from "./ui";

export async function run_sql_file(): Promise<void> {
	header("Select SQL file");

	const conn_str_display = Bun.env.CONNECTION_STRING?.trim();
	if (conn_str_display) {
		const type = conn_str_display.toLowerCase().startsWith("mysql://") ? "MySQL" : "SQLite";
		console.log(`  ${color(`${BOLD}DB:`, CYAN)} ${color(type, GREEN)} ${dim(conn_str_display)}`);
	} else {
		console.log(`  ${color("DB: not configured", YELLOW)}`);
	}
	console.log();

	const sql_files: string[] = [];

	// Determine DB type from CONNECTION_STRING and prefer sql/{type}/ folder
	const conn_str = Bun.env.CONNECTION_STRING?.trim() || "";
	const normalized = conn_str.toLowerCase();
	const db_type = normalized.startsWith("mysql://") ? "mysql" : "sqlite";
	const preferred_dir = join(process.cwd(), "sql", db_type);

	try {
		const glob = new Bun.Glob("**/*.sql");
		for await (const file of glob.scan({ cwd: preferred_dir, onlyFiles: true })) {
			sql_files.push(join("sql", db_type, file));
		}
	} catch {
		// sql/{type}/ directory doesn't exist - skip
	}

	if (sql_files.length > 0) {
		sql_files.sort();

		// Found files in the type-specific folder - offer a fallback to browse all
		const result = await select_from_list("Select SQL file", [
			{ value: "__skip__", label: "(skip) - no SQL file" },
			...sql_files.map((f) => ({ value: f, label: f })),
			{ value: "__browse_all__", label: "Browse all .sql files (root + sql/)" },
		]);

		if (!result) {
			console.log(`  ${dim("  (cancelled)")}`);
			return;
		}

		if (result === "__skip__") {
			console.log(`  ${dim("  (skipped - no SQL file executed)")}`);
			return;
		}

		if (result === "__browse_all__") {
			// Fall through to generic scan below
			sql_files.length = 0;
		} else {
			// Execute the selected file
			await execute_sql_file(result);
			return;
		}
	}

	// Fallback: scan project root + sql/ generically
	{
		const root_glob = new Bun.Glob("*.sql");
		for await (const file of root_glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
			sql_files.push(file);
		}

		const sql_dir = join(process.cwd(), "sql");
		try {
			const sql_glob = new Bun.Glob("**/*.sql");
			for await (const file of sql_glob.scan({ cwd: sql_dir, onlyFiles: true })) {
				sql_files.push(join("sql", file));
			}
		} catch {
			// sql/ directory doesn't exist - skip silently
		}

		if (sql_files.length === 0) {
			console.log(`  ${color(`No .sql files found in project root, sql/, or sql/${db_type}/.`, YELLOW)}`);
			return;
		}

		sql_files.sort();

		const skip_value = "__skip__";
		const items = [
			{ value: skip_value, label: "(skip) - no SQL file" },
			...sql_files.map((f) => ({ value: f, label: f })),
		];
		const selected_file = await select_from_list("Select SQL file", items);

		if (!selected_file || selected_file === skip_value) {
			console.log(`  ${dim("  (skipped - no SQL file executed)")}`);
			return;
		}

		await execute_sql_file(selected_file);
	}
}

// ---------------------------------------------------------------------------
// Execute a single SQL file against the database
// ---------------------------------------------------------------------------

async function execute_sql_file(relative_path: string): Promise<void> {
	const file_path = join(process.cwd(), relative_path);
	const file_content = await Bun.file(file_path).text();

	console.log(`  ${color("✓", GREEN)} Selected: ${color(BOLD + relative_path, CYAN)}`);
	console.log(`  ${dim(`${file_content.split("\n").length} lines`)}`);

	const proceed = await confirm(`Run "${relative_path}" against the database?`, "n");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	const conn_str = Bun.env.CONNECTION_STRING?.trim();
	if (!conn_str) {
		console.log(`  ${color("CONNECTION_STRING not set in .env.", RED)}`);
		return;
	}

	const normalized = conn_str.toLowerCase();
	const is_mysql = normalized.startsWith("mysql://");

	try {
		if (is_mysql) { await db_cli`SET FOREIGN_KEY_CHECKS = 0`; }

		const sql_no_comments = file_content.split("\n")
			.map((line) => line.trimStart())
			.filter((line) => !line.startsWith("--"))
			.join("\n");

		const statements = (sql_no_comments.match(is_mysql ? /[^;]+;/gi : /\s*CREATE\s+TRIGGER[\s\S]*?END\s*;|[^;]+;/gi) || []).map((stmt) => stmt.replace(/;\s*$/, "").trim()).filter((stmt) => stmt.length > 0 && !stmt.match(
			/^\s*--/
		));

		if (statements.length === 0) {
			console.log(`  ${color("No executable statements found in file.", YELLOW)}`);
			return;
		}

		console.log(`  ${dim(`Found ${statements.length} statement(s) to execute`)}`);

		for (let i = 0; i < statements.length; i++) {
			const stmt = statements[i];
			const preview = stmt.length > 70 ? `${stmt.slice(0, 67)}...` : stmt;
			try {
				console.log(`  [${i + 1}/${statements.length}] ${dim(preview)}`);
				await db_cli.unsafe(stmt);
				console.log(`           ${color("✓", GREEN)}`);
			} catch (stmt_err) {
				console.log(`           ${color(`\u2717 ${stmt_err}`, RED)}`);
			}
		}

		if (is_mysql) { await db_cli`SET FOREIGN_KEY_CHECKS = 1`; }

		// Invalidate DB cache - SQL files may have altered the schema
		const { invalidate_cache } = await import("../ddl_cache");
		const { clear_view_cache } = await import("../crud/sql_introspector");
		invalidate_cache();
		clear_view_cache();

		console.log(`\n  ${color("✓ Done", GREEN)} Executed ${statements.length} statement(s) from ${relative_path}`);
		console.log(`  ${dim("DDL cache invalidated - schema changes will be picked up on next use.")}`);
	} catch (err) {
		console.log(`  ${color(`Error: ${err}`, RED)}`);
	}
}
