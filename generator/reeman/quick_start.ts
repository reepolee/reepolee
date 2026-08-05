#!/usr/bin/env bun
/**
 * Quick Start - orchestrated setup: DB type -> SQL file -> session driver -> admin user
 */

import { join } from "node:path";

import { SQL } from "bun";

import { create_user } from "../user_lib";
import { set_db_type } from "./set_db_type";
import { set_session_driver } from "./set_session_driver";
import { ask, BOLD, color, confirm, CYAN, DIM, dim, GREEN, header, log_action, RED, show_cli_tip, YELLOW } from "./ui";

// ---------------------------------------------------------------------------
// Create admin user
// ---------------------------------------------------------------------------

async function create_admin_user(): Promise<{ username: string; email: string; password: string; } | null> {
	header("Create admin user");

	const default_username = Bun.env.ADMIN_USERNAME?.trim();
	const default_email = Bun.env.ADMIN_EMAIL?.trim();
	const default_password = Bun.env.ADMIN_PASSWORD?.trim();
	const required_names = ["ADMIN_USERNAME", "ADMIN_EMAIL", "ADMIN_PASSWORD"];
	const missing_names = required_names.filter((name) => !Bun.env[name]?.trim());
	if (missing_names.length > 0) {
		console.log(`  ${color("✗ Failed to create user", RED)}  ${color(`Missing from .env: ${missing_names.join(", ")}`, DIM)}`);
		return null;
	}

	console.log(`  ${dim("Leave blank to use defaults from .env.")}`);
	console.log();

	const username = await ask("Username", default_username!);
	const email = await ask("Email", default_email!);
	const password = await ask("Password", default_password!);

	console.log(`  ${color(`${BOLD}Username:`, CYAN)} ${username}`);
	console.log(`  ${color(`${BOLD}Email:`, CYAN)}   ${email}`);
	console.log(`  ${color(`${BOLD}Password:`, CYAN)} ${password}`);
	console.log();

	const proceed = await confirm(`Create user "${username}" (${email})?`, "y");

	if (!proceed) {
		console.log(`  ${color("Skipped.", YELLOW)}`);
		return null;
	}

	const conn_str = Bun.env.CONNECTION_STRING?.trim();
	if (!conn_str) {
		console.log(`  ${color("✗ Failed to create user", RED)}  ${color("CONNECTION_STRING not found in .env", DIM)}`);
		return null;
	}

	console.log(`\n${color("Creating user:", BOLD)} ${dim(username)}\n`);

	try {
		await create_user(username, email, password, "system,examples", conn_str);
		console.log(`${color("✓ User created successfully", GREEN)}`);
		show_cli_tip(`bun generator/user.ts ${username} ${email} ${password} --modules system,examples`, `Created admin user: ${username}`);
		return { username, email, password };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log(`${color("✗ Failed to create user", RED)}  ${color(message, DIM)}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Auto-run all SQL files from sql/{type}/ folder after DB type is selected
// ---------------------------------------------------------------------------

async function auto_run_sql_files(db_type: "mysql" | "sqlite"): Promise<void> {
	const dir = join(process.cwd(), "sql", db_type);

	// Gather .sql files sorted
	const files: string[] = [];
	try {
		const glob = new Bun.Glob("*.sql");
		for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
			files.push(file);
		}
	} catch {
		console.log(`  ${color(`No sql/${db_type}/ folder found.`, YELLOW)}`);
		return;
	}

	if (files.length === 0) {
		console.log(`  ${color(`No .sql files found in sql/${db_type}/.`, YELLOW)}`);
		return;
	}

	files.sort();

	const conn_str = Bun.env.CONNECTION_STRING?.trim();
	if (!conn_str) {
		console.log(`  ${color("CONNECTION_STRING not found in .env.", RED)}`);
		return;
	}

	const normalized = conn_str.toLowerCase();
	const is_mysql = normalized.startsWith("mysql://");

	console.log(`  ${dim(`Found ${files.length} SQL file(s) to execute`)}`);

	// Create a fresh connection using the current connection string
	const keepalive = setInterval(() => {}, 2_147_483_647);
	const db = new SQL(conn_str);

	try {
		if (is_mysql) { await db`SET FOREIGN_KEY_CHECKS = 0`; }

		for (const file of files) {
			const file_path = join(dir, file);
			const file_content = await Bun.file(file_path).text();
			console.log(`  ${color(BOLD + file, CYAN)} ${dim(`(${file_content.split("\n").length} lines)`)}`);

			const sql_no_comments = file_content.split("\n")
				.map((line) => line.trimStart())
				.filter((line) => !line.startsWith("--"))
				.join("\n");

			const statements = (sql_no_comments.match(is_mysql ? /[^;]+;/gi : /\s*CREATE\s+TRIGGER[\s\S]*?END\s*;|[^;]+;/gi) || []).map((stmt) => stmt.replace(/;\s*$/, "").trim()).filter((stmt) => stmt.length > 0 && !stmt.match(
				/^\s*--/
			));

			for (let i = 0; i < statements.length; i++) {
				const stmt = statements[i]!;
				const preview = stmt.length > 70 ? `${stmt.slice(0, 67)}...` : stmt;
				try {
					console.log(`    [${i + 1}/${statements.length}] ${dim(preview)}`);
					await db.unsafe(stmt);
					console.log(`           ${color("✓", GREEN)}`);
				} catch (stmt_err) {
					console.log(`           ${color(`\u2717 ${stmt_err}`, RED)}`);
				}
			}
		}

		if (is_mysql) { await db`SET FOREIGN_KEY_CHECKS = 1`; }

		console.log(`  ${color("✓ Done", GREEN)} Executed SQL from sql/${db_type}/`);
		log_action(`Ran init SQL files: sql/${db_type}/ (${files.join(", ")})`);
	} catch (err) {
		console.log(`  ${color(`Error: ${err}`, RED)}`);
	} finally {
		clearInterval(keepalive);
		await db.close();
	}
}

// ---------------------------------------------------------------------------
// Quick Start
// ---------------------------------------------------------------------------

export async function quick_start(): Promise<void> {
	console.log();
	console.log(`  ${color(`${BOLD}Quick Start`, CYAN)}`);
	console.log(`  ${dim("-".repeat(30))}`);
	console.log(`  ${dim("This will walk you through initial project setup:")}`);
	console.log(`  ${color("1.", GREEN)} ${dim("Select database type (MySQL or SQLite)")}`);
	console.log(`  ${color("2.", GREEN)} ${dim("Run SQL initialization from sql/{type}/ folder (automatic)")}`);
	console.log(`  ${color("3.", GREEN)} ${dim("Set session driver (Redis or SQL)")}`);
	console.log(`  ${color("4.", GREEN)} ${dim("Create admin user (defaults from .env)")}`);
	console.log(`  ${dim("-".repeat(30))}`);
	console.log();

	const proceed = await confirm("Proceed with Quick Start?", "y");

	if (!proceed) {
		console.log(`  ${color("Cancelled.", YELLOW)}`);
		return;
	}

	const db_type = await set_db_type();

	if (!db_type) {
		console.log(`  ${color("Quick Start cancelled after DB type selection.", YELLOW)}`);
		return;
	}

	// set_db_type() already refreshed Bun.env.CONNECTION_STRING and synced db_cli.

	await auto_run_sql_files(db_type);

	// Invalidate DB cache - SQL init files may have created/ altered tables
	const { invalidate_cache } = await import("../ddl_cache");
	invalidate_cache();

	await set_session_driver();
	const created = await create_admin_user();

	console.log(`\n  ${color("✓ Quick Start complete!", GREEN)}`);
	console.log(`  ${dim("Restart the server for changes to take effect.")}`);
	if (created) {
		console.log(`  ${dim(`You can log in with "${created.username}" / ${created.password}`)}`);
	} else {
		console.log(`  ${dim("Admin user was not created.")}`);
	}
}
