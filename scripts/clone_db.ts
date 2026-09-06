#!/usr/bin/env bun
/**
 * Regenerate the test database from a development database dump.
 *
 * Usage:
 * bun run db:clone-test               # interactive confirmation
 * bun run db:clone-test -- --yes      # skip confirmation
 * bun run db:clone-test -- --dry-run  # show what would happen
 * bun run db:clone-test -- --no-data  # DDL only (no row data)
 * bun run db:clone-test -- --quiet    # summary only (used by the installer)
 * bun run db:clone-test -- --snapshot <file>  # dump test DB to a file
 * bun run db:clone-test -- --restore <file>   # load a snapshot into the test DB
 */

import { SQL } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { extract_db_name } from "$config/test_db";
import { dump_dialect, parse_mysql_connection, run_dump, sqlite_database_path, type DumpDialect } from "$root/scripts/dump_db";
import { get_connection_string, sanitize_env_value } from "$lib/env";

export interface DatabaseSummary {
	tables: number;
	rows: number;
}

export interface RegenerateOptions {
	source_connection: string;
	target_connection: string;
	no_data?: boolean;
}

export function mysql_restore_command(connection_string: string): { cmd: string[]; password: string } {
	const connection = parse_mysql_connection(connection_string);
	return {
		cmd: [
			"mysql",
			`--host=${connection.host}`,
			`--port=${connection.port}`,
			`--user=${connection.user}`,
			connection.database,
		],
		password: connection.password,
	};
}

export async function regenerate_test_database(options: RegenerateOptions): Promise<DatabaseSummary> {
	const source_dialect = dump_dialect(options.source_connection);
	const target_dialect = dump_dialect(options.target_connection);
	if (source_dialect !== target_dialect) {
		throw new Error(`Source (${source_dialect}) and target (${target_dialect}) DB types must match`);
	}
	assert_test_target(options.target_connection);

	const temporary_dir = await mkdtemp(join(tmpdir(), "reepolee-clone-"));
	try {
		const dump_path = await run_dump({
			connection: options.source_connection,
			dialect: source_dialect,
			output_dir: temporary_dir,
			no_data: source_dialect === "mysql" && options.no_data === true,
			quiet: true,
		});
		if (source_dialect === "sqlite" && options.no_data) await remove_sqlite_data(dump_path);
		await restore_database_dump(options.target_connection, source_dialect, dump_path);
		return await summarize_database(options.target_connection, source_dialect);
	} finally {
		await rm(temporary_dir, { recursive: true, force: true });
	}
}

export async function snapshot_test_database(target_connection: string, file_path: string): Promise<void> {
	assert_test_target(target_connection);
	const dialect = dump_dialect(target_connection);
	const temporary_dir = await mkdtemp(join(tmpdir(), "reepolee-snapshot-"));
	try {
		const dump_path = await run_dump({ connection: target_connection, dialect, output_dir: temporary_dir, quiet: true });
		const resolved_file_path = resolve(file_path);
		await mkdir(dirname(resolved_file_path), { recursive: true });
		await Bun.write(resolved_file_path, Bun.file(dump_path));
	} finally {
		await rm(temporary_dir, { recursive: true, force: true });
	}
}

export async function restore_test_database(target_connection: string, file_path: string): Promise<void> {
	assert_test_target(target_connection);
	const dialect = dump_dialect(target_connection);
	await restore_database_dump(target_connection, dialect, file_path);
}

async function restore_database_dump(target_connection: string, dialect: DumpDialect, file_path: string): Promise<void> {
	const dump_file = Bun.file(file_path);
	if (!(await dump_file.exists())) throw new Error(`Dump file not found: ${file_path}`);
	if (dialect === "mysql") await restore_mysql_dump(target_connection, dump_file);
	else await restore_sqlite_copy(target_connection, file_path);
}

async function restore_mysql_dump(target_connection: string, dump_file: ReturnType<typeof Bun.file>): Promise<void> {
	const target_database = parse_mysql_connection(target_connection).database;
	const admin_db = new SQL(mysql_admin_url(target_connection));
	try {
		await admin_db.connect();
		await admin_db.unsafe(`DROP DATABASE IF EXISTS ${quote_mysql_identifier(target_database)}`);
		await admin_db.unsafe(`CREATE DATABASE ${quote_mysql_identifier(target_database)}`);
	} finally {
		await admin_db.close();
	}

	const { cmd, password } = mysql_restore_command(target_connection);
	let restore_process: ReturnType<typeof Bun.spawn>;
	try {
		restore_process = Bun.spawn({
			cmd,
			env: { ...Bun.env, MYSQL_PWD: password },
			stdin: dump_file.stream(),
			stdout: "ignore",
			stderr: "pipe",
		});
	} catch (error) {
		throw new Error(`Could not start mysql: ${error instanceof Error ? error.message : String(error)}.`);
	}

	const stderr = restore_process.stderr as ReadableStream<Uint8Array>;
	const stderr_promise = new Response(stderr).text();
	const [exit_code, error_output] = await Promise.all([restore_process.exited, stderr_promise]);
	if (exit_code !== 0) throw new Error(error_output.trim() || `mysql restore failed with exit code ${exit_code}.`);
}

async function restore_sqlite_copy(target_connection: string, dump_path: string): Promise<void> {
	const target_path = sqlite_database_path(target_connection);
	const resolved_dump_path = resolve(dump_path);
	const resolved_target_path = resolve(target_path);
	if (resolved_dump_path === resolved_target_path) throw new Error("SQLite dump and target paths must differ");

	await mkdir(dirname(resolved_target_path), { recursive: true });
	await delete_file_if_present(resolved_target_path);
	await delete_file_if_present(`${resolved_target_path}-wal`);
	await delete_file_if_present(`${resolved_target_path}-shm`);
	await Bun.write(resolved_target_path, Bun.file(resolved_dump_path));
}

async function remove_sqlite_data(file_path: string): Promise<void> {
	const database = new SQL(`sqlite:${file_path}`);
	try {
		await database.unsafe("PRAGMA foreign_keys = OFF");
		const trigger_rows = await database.unsafe("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL ORDER BY name") as Array<{ name: string; sql: string }>;
		for (const trigger of trigger_rows) await database.unsafe(`DROP TRIGGER ${quote_sqlite_identifier(trigger.name)}`);

		const table_rows = await database.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as Array<{ name: string }>;
		for (const table of table_rows) await database.unsafe(`DELETE FROM ${quote_sqlite_identifier(table.name)}`);

		const sequence_rows = await database.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'") as Array<{ name: string }>;
		if (sequence_rows.length > 0) await database.unsafe("DELETE FROM sqlite_sequence");
		for (const trigger of trigger_rows) await database.unsafe(trigger.sql);
		await database.unsafe("VACUUM");
	} finally {
		await database.close();
	}
}

async function summarize_database(connection: string, dialect: DumpDialect): Promise<DatabaseSummary> {
	const database = new SQL(connection);
	try {
		const table_names = dialect === "mysql"
			? await mysql_table_names(database)
			: await sqlite_table_names(database);
		let rows = 0;
		for (const table_name of table_names) {
			const quoted_name = dialect === "mysql"
				? quote_mysql_identifier(table_name)
				: quote_sqlite_identifier(table_name);
			const count_rows = await database.unsafe(`SELECT COUNT(*) AS row_count FROM ${quoted_name}`) as Array<Record<string, unknown>>;
			rows += Number(count_rows[0]?.row_count ?? 0);
		}
		return { tables: table_names.length, rows };
	} finally {
		await database.close();
	}
}

async function mysql_table_names(database: SQL): Promise<string[]> {
	const rows = await database.unsafe("SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME") as Array<Record<string, unknown>>;
	return rows.map((row) => String(row.table_name ?? row.TABLE_NAME));
}

async function sqlite_table_names(database: SQL): Promise<string[]> {
	const rows = await database.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as Array<{ name: string }>;
	return rows.map((row) => row.name);
}

function mysql_admin_url(connection_string: string): URL {
	const url = new URL(connection_string);
	url.pathname = "/";
	return url;
}

function quote_mysql_identifier(identifier: string): string {
	return `\`${identifier.replaceAll("`", "``")}\``;
}

function quote_sqlite_identifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function assert_test_target(connection_string: string): void {
	const database_name = extract_db_name(connection_string);
	const lower_database_name = database_name.toLowerCase();
	if (!lower_database_name.includes("test")) {
		throw new Error(`Target database "${database_name}" does not contain "test" in its name. Refusing to replace a non-test database.`);
	}
}

async function delete_file_if_present(file_path: string): Promise<void> {
	const file = Bun.file(file_path);
	if (await file.exists()) await file.delete();
}

function mask_password(connection_string: string): string {
	const match = connection_string.match(/^(mysql:\/\/)([^:]*)(:)([^@]*)(@.*)/);
	if (!match) return connection_string;
	return `${match[1]! + match[2]! + match[3]!}***${match[5]}`;
}

function option_path(args: readonly string[], option: string): string | undefined {
	const index = args.indexOf(option);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a file path`);
	return value;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const is_dry_run = args.includes("--dry-run");
	const skip_confirm = args.includes("--yes") || args.includes("-y");
	const no_data = args.includes("--no-data");
	const is_quiet = args.includes("--quiet");
	const has_snapshot = args.includes("--snapshot");
	const has_restore = args.includes("--restore");
	if (has_snapshot && has_restore) throw new Error("Use either --snapshot or --restore, not both");

	const snapshot_path = option_path(args, "--snapshot");
	const restore_path = option_path(args, "--restore");
	const target_connection = get_connection_string("TEST");
	assert_test_target(target_connection);

	if (snapshot_path) {
		await snapshot_test_database(target_connection, snapshot_path);
		console.log(`Snapshot saved to ${snapshot_path}`);
		return;
	}
	if (restore_path) {
		await restore_test_database(target_connection, restore_path);
		console.log("Restore complete.");
		return;
	}

	const source_connection = get_connection_string("DEV");
	const source_dialect = dump_dialect(source_connection);
	const target_dialect = dump_dialect(target_connection);
	if (source_dialect !== target_dialect) {
		throw new Error(`Source (${source_dialect}) and target (${target_dialect}) DB types must match`);
	}

	if (!is_quiet) {
		console.log(`Source: ${mask_password(source_connection)}`);
		console.log(`Target: ${mask_password(target_connection)}`);
		if (no_data) console.log("Mode: DDL only (no data)");
	}
	if (is_dry_run) {
		console.log("Mode: dry-run (no changes)");
		return;
	}

	if (!skip_confirm) {
		const answer = prompt("Regenerate the test database? [y/N]");
		if (!answer || (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes")) {
			console.log("Aborted.");
			return;
		}
	}

	const summary = await regenerate_test_database({ source_connection, target_connection, no_data });
	if (is_quiet) console.log(`${summary.tables} tables, ${summary.rows} rows`);
	else console.log("Clone complete.");
}

if (import.meta.path === Bun.main) await main().catch((error) => {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
