/**
 * Export the active development database to a timestamped SQL file.
 *
 * SQLite is rendered through Bun's SQL API so the backup works without a
 * sqlite3 command-line dependency. MySQL/MariaDB uses the same container CLI
 * convention as the database clone workflow.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { DB_CONNECTION_STRING, db } from "$config/db";
import { db_type } from "$lib/resolve_db_type";

const BACKUP_FOLDER = join(process.cwd(), "sql", db_type, "backup");

interface SqliteMasterRow {
	name: string;
	type: "index" | "table" | "trigger" | "view";
	sql: string | null;
}

interface SqliteColumnInfo {
	name: string;
	hidden: number;
}

/** Build a filesystem-safe, human-readable backup filename. */
export function timestamped_backup_filename(date = new Date()): string {
	const timestamp = date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
	return `backup-${timestamp}.sql`;
}

/** Export the active database and return its project-relative SQL path. */
export async function backup_database(): Promise<string> {
	await mkdir(BACKUP_FOLDER, { recursive: true });
	const output_path = join(BACKUP_FOLDER, timestamped_backup_filename());

	try {
		if (db_type === "sqlite") await backup_sqlite(output_path);
		else await backup_mysql(output_path);
	} catch (error) {
		await Bun.file(output_path).delete();
		throw error;
	}

	return join("sql", db_type, "backup", output_path.slice(BACKUP_FOLDER.length + 1));
}

async function backup_sqlite(output_path: string): Promise<void> {
	const writer = Bun.file(output_path).writer();

	try {
		const objects = await db.unsafe(
			"SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'view' THEN 4 WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 END, name"
		) as SqliteMasterRow[];
		const tables = objects.filter((object) => object.type === "table" && object.sql);
		const views = objects.filter((object) => object.type === "view" && object.sql);
		const indexes = objects.filter((object) => object.type === "index" && object.sql);
		const triggers = objects.filter((object) => object.type === "trigger" && object.sql);

		write_line(writer, "PRAGMA foreign_keys = OFF;");
		for (const view of views) write_line(writer, `DROP VIEW IF EXISTS ${quote_sqlite_identifier(view.name)};`);
		for (const table of tables) write_line(writer, `DROP TABLE IF EXISTS ${quote_sqlite_identifier(table.name)};`);
		write_line(writer, "BEGIN TRANSACTION;");

		for (const table of tables) {
			write_line(writer, ensure_statement_terminator(table.sql!));
			const columns = await writable_sqlite_columns(table.name);
			const rows = await db.unsafe(`SELECT * FROM ${quote_sqlite_identifier(table.name)}`) as Record<string, unknown>[];
			write_batched_inserts(writer, table.name, columns, rows);
		}

		for (const index of indexes) write_line(writer, ensure_statement_terminator(index.sql!));
		for (const trigger of triggers) write_line(writer, ensure_statement_terminator(trigger.sql!));
		for (const view of views) write_line(writer, ensure_statement_terminator(view.sql!));
		write_line(writer, "COMMIT;");
		write_line(writer, "PRAGMA foreign_keys = ON;");
	} finally {
		await writer.end();
	}
}

async function writable_sqlite_columns(table_name: string): Promise<SqliteColumnInfo[]> {
	const rows = await db.unsafe(`PRAGMA table_xinfo(${quote_sqlite_identifier(table_name)})`) as SqliteColumnInfo[];
	return rows.filter((column) => column.hidden === 0);
}

async function backup_mysql(output_path: string): Promise<void> {
	const connection = new URL(DB_CONNECTION_STRING);
	const user = decodeURIComponent(connection.username || "root");
	const password = decodeURIComponent(connection.password || "");
	const database = decodeURIComponent(connection.pathname.replace(/^\//, ""));
	const container_engine = Bun.env.CONTAINER_ENGINE ?? "podman";
	const dump_process = Bun.spawn({
		cmd: [
			container_engine,
			"exec",
			"mariadb",
			"mariadb-dump",
			"-u",
			user,
			`-p${password}`,
			"--no-create-db",
			"--single-transaction",
			"--quick",
			"--extended-insert",
			"--triggers",
			"--routines",
			"--events",
			"--hex-blob",
			database,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr_promise = new Response(dump_process.stderr).text();
	const writer = Bun.file(output_path).writer();
	try {
		for await (const chunk of dump_process.stdout) writer.write(chunk);
		const [exit_code, stderr] = await Promise.all([dump_process.exited, stderr_promise]);
		if (exit_code !== 0) throw new Error(stderr.trim() || "Database backup failed.");
		await writer.end();
	} catch (error) {
		await writer.end();
		throw error;
	}
}

function quote_sqlite_identifier(name: string): string {
	return `"${name.replaceAll("\"", "\"\"")}"`;
}

function ensure_statement_terminator(statement: string): string {
	const trimmed = statement.trim();
	return trimmed.endsWith(";") ? trimmed : `${trimmed};`;
}

const INSERT_BATCH_SIZE = 100;

function write_batched_inserts(
	writer: { write(chunk: string): unknown; },
	table_name: string,
	columns: SqliteColumnInfo[],
	rows: Record<string, unknown>[],
): void {
	for (const statement of sqlite_insert_statements(table_name, columns, rows)) write_line(writer, statement);
}

/** Build bounded multi-row INSERT statements for a SQLite table. */
export function sqlite_insert_statements(
	table_name: string,
	columns: SqliteColumnInfo[],
	rows: Record<string, unknown>[],
): string[] {
	if (rows.length === 0) return [];
	const quoted_table = quote_sqlite_identifier(table_name);
	const column_names = columns.map((column) => quote_sqlite_identifier(column.name)).join(", ");
	const statements: string[] = [];
	for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
		const values = rows.slice(start, start + INSERT_BATCH_SIZE).map((row) =>
			`(${columns.map((column) => sqlite_literal(row[column.name])).join(", ")})`
		).join(",\n");
		statements.push(`INSERT INTO ${quoted_table} (${column_names}) VALUES\n${values};`);
	}
	return statements;
}

function write_line(writer: { write(chunk: string): unknown; }, line: string): void {
	writer.write(`${line}\n`);
}

export function sqlite_literal(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	if (typeof value === "bigint") return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	if (value instanceof Uint8Array) {
		const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
		return `X'${hex}'`;
	}
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return `'${String(text).replaceAll("'", "''")}'`;
}
