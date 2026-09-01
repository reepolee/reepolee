#!/usr/bin/env bun
/**
 * Development database dump CLI.
 *
 * Usage:
 *   bun dump                              # writes to ./.reepolee/backup-<timestamp>
 *   bun dump --test --output=tmp/database-dump
 *
 * MySQL writes one native mysqldump SQL file. SQLite copies the source
 * database file without opening it.
 */

import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { sanitize_env_value } from "$lib/env";

export type DumpDialect = "mysql" | "sqlite";

export interface MysqlConnection {
	host: string;
	port: string;
	user: string;
	password: string;
	database: string;
}

export function timestamped_backup_folder(date = new Date()): string {
	const timestamp = date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return `backup-${timestamp}`;
}

export function timestamped_backup_directory(project_root = process.cwd(), date = new Date()): string {
	return join(project_root, ".reepolee", timestamped_backup_folder(date));
}

export function parse_mysql_connection(connection_string: string): MysqlConnection {
	const connection = new URL(sanitize_env_value(connection_string));
	const database = decodeURIComponent(connection.pathname.replace(/^\/+/, ""));
	if (!database) throw new Error("MySQL connection string does not contain a database name.");

	return {
		host: connection.hostname || "localhost",
		port: connection.port || "3306",
		user: decodeURIComponent(connection.username || "root"),
		password: decodeURIComponent(connection.password || ""),
		database,
	};
}

export function mysql_dump_command(connection_string: string): { cmd: string[]; password: string } {
	const connection = parse_mysql_connection(connection_string);
	return {
		cmd: [
			"mysqldump",
			`--host=${connection.host}`,
			`--port=${connection.port}`,
			`--user=${connection.user}`,
			"--no-create-db",
			"--single-transaction",
			"--quick",
			"--extended-insert",
			"--triggers",
			"--routines",
			"--events",
			"--hex-blob",
			connection.database,
		],
		password: connection.password,
	};
}

export function sqlite_database_path(connection_string: string): string {
	const connection = sanitize_env_value(connection_string);
	if (!connection.toLowerCase().startsWith("sqlite:")) throw new Error("SQLite connection string must start with sqlite:");

	const database_path = connection.slice("sqlite:".length).replace(/^\/\//, "");
	if (!database_path || database_path === ":memory:") throw new Error("SQLite connection string does not point to a database file.");
	return database_path;
}

export function dump_dialect(connection_string: string): DumpDialect {
	const connection = sanitize_env_value(connection_string).toLowerCase();
	if (connection.startsWith("mysql:")) return "mysql";
	if (connection.startsWith("sqlite:")) return "sqlite";
	throw new Error(`Unsupported database connection: ${connection.split(":")[0]}`);
}

async function dump_mysql(connection_string: string, output_dir: string): Promise<void> {
	const { cmd, password } = mysql_dump_command(connection_string);
	const output_path = join(output_dir, "dump.sql");
	let dump_process: ReturnType<typeof Bun.spawn>;
	try {
		dump_process = Bun.spawn({
			cmd,
			env: { ...Bun.env, MYSQL_PWD: password },
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		throw new Error(`Could not start mysqldump: ${error instanceof Error ? error.message : String(error)}.`);
	}

	const stdout = dump_process.stdout as ReadableStream<Uint8Array>;
	const stderr = dump_process.stderr as ReadableStream<Uint8Array>;
	const stderr_promise = new Response(stderr).text();
	const writer = Bun.file(output_path).writer();
	try {
		for await (const chunk of stdout) writer.write(chunk);
		const [exit_code, stderr] = await Promise.all([dump_process.exited, stderr_promise]);
		if (exit_code !== 0) throw new Error(stderr.trim() || `mysqldump failed with exit code ${exit_code}.`);
		await writer.end();
	} catch (error) {
		await writer.end();
		await Bun.file(output_path).delete();
		throw error;
	}
}

async function copy_sqlite(connection_string: string, output_dir: string): Promise<void> {
	const source_path = sqlite_database_path(connection_string);
	const source_file = Bun.file(source_path);
	if (!(await source_file.exists())) throw new Error(`SQLite database not found: ${source_path}`);

	const output_path = join(output_dir, basename(source_path));
	await Bun.write(output_path, source_file);
}

export interface DumpOptions {
	connection: string;
	dialect: DumpDialect;
	output_dir: string;
}

function parse_options(args: readonly string[]): { use_test: boolean; output_dir: string } {
	const use_test = args.includes("--test");
	const output_arg = args.find((arg) => arg.startsWith("--output="));
	if (args.some((arg) => arg === "--output")) throw new Error("Use --output=DIR for the dump directory");
	const output_dir = output_arg?.slice("--output=".length) || join(".reepolee", timestamped_backup_folder());
	return { use_test, output_dir: resolve(process.cwd(), output_dir) };
}

function print_help(): void {
	console.log(`Usage: bun dump [--test] [--output=DIR]\n\nDumps the development database into DIR (default: ./.reepolee/${timestamped_backup_folder()}):\n  DIR/dump.sql        (MySQL)\n  DIR/<database file> (SQLite)\n\nMySQL uses mysqldump. SQLite copies the database file without opening it.`);
}

export async function run_dump(options: DumpOptions): Promise<void> {
	await mkdir(options.output_dir, { recursive: true });
	if (options.dialect === "mysql") await dump_mysql(options.connection, options.output_dir);
	else await copy_sqlite(options.connection, options.output_dir);
	console.log(`Dump complete: ${options.output_dir}`);
}

async function main(): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		print_help();
		return;
	}
	const args = process.argv.slice(2);
	const parsed = parse_options(args);
	const env_name = parsed.use_test ? "TEST_CONNECTION_STRING" : "DEV_CONNECTION_STRING";
	const connection = sanitize_env_value(Bun.env[env_name] ?? "");
	if (!connection) throw new Error(`Missing ${env_name}`);
	await run_dump({ connection, dialect: dump_dialect(connection), output_dir: parsed.output_dir });
}

if (import.meta.path === Bun.main) await main().catch((error) => {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
