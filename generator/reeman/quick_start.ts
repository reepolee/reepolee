#!/usr/bin/env bun
/**
 * Quick Start - orchestrated setup: DB type -> SQL file -> session driver -> admin user
 */

import { join } from "node:path";

import { SQL } from "bun";

import { active_locales } from "../../config/supported_locales";
import { env_available } from "../../config/env_vars";
import { create_user } from "../user_lib";
import { set_db_type } from "./set_db_type";
import { set_repo } from "./set_repo";
import { set_session_driver } from "./set_session_driver";
import { ask, BOLD, color, confirm, CYAN, DIM, dim, GREEN, header, RED, show_cli_tip, show_cli_tips, YELLOW } from "./ui";

// ---------------------------------------------------------------------------
// Create admin user
// ---------------------------------------------------------------------------

async function get_all_module_codes(conn_str: string): Promise<string> {
	const db = new SQL(conn_str);
	const keepalive = setInterval(() => {}, 2_147_483_647);
	try {
		const modules = (await db`SELECT code FROM modules ORDER BY code`) as { code: string }[];
		return modules.map((m) => m.code).join(",");
	} finally {
		clearInterval(keepalive);
		await db.close();
	}
}

async function create_admin_user(): Promise<{ username: string; email: string; password: string; } | null> {
	header("Create admin user");

	const default_username = env_available("ADMIN_USERNAME") ? Bun.env.ADMIN_USERNAME!.trim() : "";
	const default_email = env_available("ADMIN_EMAIL") ? Bun.env.ADMIN_EMAIL!.trim() : "";
	const default_password = env_available("ADMIN_PASSWORD") ? Bun.env.ADMIN_PASSWORD!.trim() : "";
	const required_names = ["ADMIN_USERNAME", "ADMIN_EMAIL", "ADMIN_PASSWORD"];
	const missing_names = required_names.filter((name) => !Bun.env[name]?.trim());
	if (missing_names.length > 0) {
		console.log(`  ${color("✗ Failed to create user", RED)}  ${color(`Missing from .env: ${missing_names.join(", ")}`, DIM)}`);
		return null;
	}

	console.log(`  ${dim("Leave blank to use defaults from .env.")}`);
	console.log();

	const username = await ask("Username", default_username);
	const email = await ask("Email", default_email);
	let password = await ask("Password", default_password);
	while (!password) {
		console.log(`  ${color("Password is required - set ADMIN_PASSWORD in .env or type one now.", RED)}`);
		password = await ask("Password", default_password);
	}

	console.log(`  ${color(`${BOLD}Username:`, CYAN)} ${username}`);
	console.log(`  ${color(`${BOLD}Email:`, CYAN)}   ${email}`);
	console.log(`  ${color(`${BOLD}Password:`, CYAN)} ${password}`);
	console.log();

	const proceed = await confirm(`Create user "${username}" (${email})?`, "y");

	if (!proceed) {
		console.log(`  ${color("Skipped.", YELLOW)}`);
		return null;
	}

	const conn_str = Bun.env.DEV_CONNECTION_STRING?.trim();
	if (!conn_str) {
		console.log(`  ${color("✗ Failed to create user", RED)}  ${color("DEV_CONNECTION_STRING not found in .env", DIM)}`);
		return null;
	}

	console.log(`\n${color("Creating user:", BOLD)} ${dim(username)}\n`);

	try {
		const all_modules = await get_all_module_codes(conn_str);
		await create_user(username, email, password, all_modules, conn_str);
		console.log(`${color("✓ User created successfully", GREEN)}`);
		show_cli_tip(`bun generator/user.ts ${username} ${email} ${password} --modules ${all_modules}`, `Created admin user: ${username}`);
		return { username, email, password };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.log(`${color("✗ Failed to create user", RED)}  ${color(message, DIM)}`);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Auto-run all SQL files from sql/{type}/init/ folder after DB type is selected.
// Locale translation files for locales not in active_locales live in
// sql/{type}/locales/ instead and are only pulled in here when active.
// ---------------------------------------------------------------------------

async function auto_run_sql_files(db_type: "mysql" | "sqlite"): Promise<void> {
	const init_dir = join(process.cwd(), "sql", db_type, "init");
	const locales_dir = join(process.cwd(), "sql", db_type, "locales");

	// Gather .sql files from init/ (always runnable)
	const files: string[] = [];
	try {
		const glob = new Bun.Glob("*.sql");
		for await (const file of glob.scan({ cwd: init_dir, onlyFiles: true })) {
			files.push(file);
		}
	} catch {
		console.log(`  ${color(`No sql/${db_type}/init/ folder found.`, YELLOW)}`);
		return;
	}

	if (files.length === 0) {
		console.log(`  ${color(`No .sql files found in sql/${db_type}/init/.`, YELLOW)}`);
		return;
	}

	// Pull in locale files from sql/{type}/locales/ for any active_locales not
	// already covered by init/ (e.g. a user pre-adding de-de to active_locales
	// before running Quick Start).
	const runnable_files: { file: string; dir: string; }[] = files.map((file) => ({ file, dir: init_dir }));
	const locale_file_re = /-init-translations-([a-z]{2}-[a-z]{2})\.sql$/i;
	const covered_locales = new Set(
		files.map((file) => file.match(locale_file_re)?.[1]?.toLowerCase()).filter((l): l is string => !!l),
	);
	const active_locale_set = new Set<string>(active_locales);

	try {
		const glob = new Bun.Glob("*.sql");
		for await (const file of glob.scan({ cwd: locales_dir, onlyFiles: true })) {
			const match = file.match(locale_file_re);
			const locale = match?.[1]?.toLowerCase();
			if (!locale || covered_locales.has(locale) || !active_locale_set.has(locale)) { continue; }
			runnable_files.push({ file, dir: locales_dir });
		}
	} catch {
		// sql/{type}/locales/ doesn't exist - nothing extra to add
	}

	runnable_files.sort((a, b) => a.file.localeCompare(b.file));

	const conn_str = Bun.env.DEV_CONNECTION_STRING?.trim();
	if (!conn_str) {
		console.log(`  ${color("DEV_CONNECTION_STRING not found in .env.", RED)}`);
		return;
	}

	const normalized = conn_str.toLowerCase();
	const is_mysql = normalized.startsWith("mysql://");

	console.log(`  ${dim(`Found ${runnable_files.length} SQL file(s) to execute`)}`);

	// Create a fresh connection using the current connection string
	const keepalive = setInterval(() => {}, 2_147_483_647);
	const db = new SQL(conn_str);

	try {
		if (is_mysql) { await db`SET FOREIGN_KEY_CHECKS = 0`; }

		for (const { file, dir } of runnable_files) {
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

		console.log(`  ${color("✓ Done", GREEN)} Executed SQL from sql/${db_type}/init/`);

		// Log one real `run-sql-file` command per file (not just a comment) so
		// replaying .reepolee/reeman.sh|ps1 against a fresh DB actually runs
		// this step - a bare log_action() comment previously left the replayed
		// DB empty. Paths use forward slashes for both .sh (bash) and .ps1
		// (accepted by run-sql-file's own path.join on Windows too).
		const replay_cmds = runnable_files.map(({ file, dir }) => {
			const rel_dir = dir === locales_dir ? `sql/${db_type}/locales` : `sql/${db_type}/init`;
			return `bun reeman run-sql-file ${rel_dir}/${file} --force`;
		});
		await show_cli_tips(replay_cmds, `Ran init SQL files: sql/${db_type}/init/ (${runnable_files.map((f) => f.file).join(", ")})`);
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
	console.log(`  ${color("2.", GREEN)} ${dim("Run SQL initialization from sql/{type}/init/ folder (automatic)")}`);
	console.log(`  ${color("3.", GREEN)} ${dim("Set session driver (Redis or SQL)")}`);
	console.log(`  ${color("4.", GREEN)} ${dim("Create admin user (defaults from .env)")}`);
	console.log(`  ${color("5.", GREEN)} ${dim("Link a GitHub repository (optional)")}`);
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

	// set_db_type() already refreshed Bun.env.DEV_CONNECTION_STRING and synced db_cli.

	await auto_run_sql_files(db_type);

	// Invalidate DB cache - SQL init files may have created/ altered tables
	const { invalidate_cache } = await import("../ddl_cache");
	invalidate_cache();

	await set_session_driver();
	const created = await create_admin_user();
	await set_repo();

	console.log(`\n  ${color("✓ Quick Start complete!", GREEN)}`);
	console.log(`  ${dim("Restart the server for changes to take effect.")}`);
	if (created) {
		console.log(`  ${dim(`You can log in with "${created.username}" / ${created.password}`)}`);
	} else {
		console.log(`  ${dim("Admin user was not created.")}`);
	}
}
