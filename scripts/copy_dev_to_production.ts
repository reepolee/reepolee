/**
 * Replace the production database with the development database.
 *
 * Usage:
 * bun run db:clone-production          # interactive confirmation
 * bun run db:clone-production -- --yes # skip confirmation
 */

import { SQL } from "bun";

const args = process.argv.slice(2);
const skip_confirm = args.includes("--yes") || args.includes("-y");
const raw_source = normalize_connection_string(Bun.env.DEV_CONNECTION_STRING);
const raw_target = normalize_connection_string(Bun.env.PROD_CONNECTION_STRING);

if (!raw_source) fail("DEV_CONNECTION_STRING is not set");
if (!raw_target) fail("PROD_CONNECTION_STRING is not set");

const source_type = connection_type(raw_source);
const target_type = connection_type(raw_target);
if (source_type !== target_type) {
	fail(`Source (${source_type}) and target (${target_type}) DB types must match`);
}
if (raw_source === raw_target) fail("Development and production connection strings must differ");

console.log(`Source: ${mask_password(raw_source)}`);
console.log(`Target: ${mask_password(raw_target)}`);
console.log("WARNING: this permanently replaces the production database.");

if (!skip_confirm) {
	const answer = prompt("Replace production database? [y/N]");
	if (!answer || (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes")) {
		console.log("Aborted.");
		process.exit(0);
	}
}

if (source_type === "sqlite") {
	await copy_sqlite(raw_source, raw_target);
} else if (source_type === "mysql") {
	await copy_mysql(raw_source, raw_target);
} else {
	fail(`Unsupported database type: ${source_type}`);
}

console.log("Production database replaced.");

async function copy_sqlite(source_url: string, target_url: string): Promise<void> {
	const source_path = sqlite_path(source_url);
	const target_path = sqlite_path(target_url);
	if (source_path === target_path) fail("Development and production SQLite files must differ");

	const source_file = Bun.file(source_path);
	if (!(await source_file.exists())) fail(`Development SQLite database not found: ${source_path}`);

	// Flush a possible WAL before copying the database file.
	const source_db = new SQL(source_url);
	try {
		await source_db`PRAGMA wal_checkpoint(TRUNCATE)`;
	} finally {
		await source_db.close();
	}

	const target_file = Bun.file(target_path);
	if (await target_file.exists()) {
		const target_db = new SQL(target_url);
		try {
			await target_db`PRAGMA wal_checkpoint(TRUNCATE)`;
		} finally {
			await target_db.close();
		}
	}

	await Bun.write(target_path, source_file);
}

async function copy_mysql(source_url: string, target_url: string): Promise<void> {
	const source_db = new SQL(source_url);
	const target_db = new SQL(target_url);

	try {
		const source_name_rows = await source_db.unsafe("SELECT DATABASE() AS db_name") as Record<string, unknown>[];
		const target_name_rows = await target_db.unsafe("SELECT DATABASE() AS db_name") as Record<string, unknown>[];
		const source_name = String(source_name_rows[0]?.db_name ?? "");
		const target_name = String(target_name_rows[0]?.db_name ?? "");
		const table_rows = await source_db.unsafe("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
		const table_names = table_rows.map((row: Record<string, unknown>) => String(row.TABLE_NAME));
		const view_rows = await source_db.unsafe("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'VIEW' ORDER BY TABLE_NAME");
		const view_names = view_rows.map((row: Record<string, unknown>) => String(row.TABLE_NAME));

		await target_db.unsafe("SET FOREIGN_KEY_CHECKS = 0");
		try {
			await drop_mysql_objects(target_db);
			for (const table_name of table_names) {
				const create_sql = await show_create_statement(source_db, "TABLE", table_name);
				await target_db.unsafe(create_sql);
				await copy_mysql_table(source_db, target_db, table_name);
				console.log(`  copied  ${table_name}`);
			}
			for (const view_name of view_names) {
				const create_sql = await show_create_statement(source_db, "VIEW", view_name);
				const target_view_sql = rewrite_view_statement(create_sql, source_name, target_name);
				await target_db.unsafe(target_view_sql);
				console.log(`  view    ${view_name}`);
			}
		} finally {
			await target_db.unsafe("SET FOREIGN_KEY_CHECKS = 1");
		}
	} finally {
		await source_db.close();
		await target_db.close();
	}
}

async function drop_mysql_objects(target_db: SQL): Promise<void> {
	const object_rows = await target_db.unsafe("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_TYPE DESC, TABLE_NAME");
	for (const row of object_rows as Record<string, unknown>[]) {
		const table_name = quote_identifier(String(row.TABLE_NAME));
		const object_type = row.TABLE_TYPE === "VIEW" ? "VIEW" : "TABLE";
		await target_db.unsafe(`DROP ${object_type} IF EXISTS ${table_name}`);
	}
}

function rewrite_view_statement(create_sql: string, source_name: string, target_name: string): string {
	const escaped_source_name = source_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const quoted_target_name = quote_identifier(target_name);
	const source_name_pattern = new RegExp(String.raw`\`${escaped_source_name}\``, "g");
	const without_definer = create_sql.replace(/\sDEFINER=`[^`]+`@`[^`]+`/g, "");
	return without_definer.replace(source_name_pattern, quoted_target_name);
}

async function show_create_statement(source_db: SQL, object_type: "TABLE" | "VIEW", object_name: string): Promise<string> {
	const quoted_name = quote_identifier(object_name);
	const rows = await source_db.unsafe(`SHOW CREATE ${object_type} ${quoted_name}`) as Record<string, unknown>[];
	const create_key = object_type === "TABLE" ? "Create Table" : "Create View";
	const create_sql = rows[0]?.[create_key];
	if (typeof create_sql !== "string") fail(`Could not read CREATE ${object_type} for ${object_name}`);
	return create_sql;
}

async function copy_mysql_table(source_db: SQL, target_db: SQL, table_name: string): Promise<void> {
	const quoted_name = quote_identifier(table_name);
	const column_rows = await source_db.unsafe(`SHOW COLUMNS FROM ${quoted_name}`) as Record<string, unknown>[];
	const column_names = column_rows
		.filter((row) => !String(row.Extra ?? "").includes("GENERATED"))
		.map((row) => String(row.Field));
	if (column_names.length === 0) return;

	const source_rows = await source_db.unsafe(`SELECT * FROM ${quoted_name}`) as Record<string, unknown>[];
	if (source_rows.length === 0) return;

	const quoted_columns = column_names.map(quote_identifier).join(", ");
	const placeholders = column_names.map(() => "?").join(", ");
	const insert_sql = `INSERT INTO ${quoted_name} (${quoted_columns}) VALUES (${placeholders})`;
	for (const source_row of source_rows) {
		const values = column_names.map((column_name) => source_row[column_name]);
		await target_db.unsafe(insert_sql, values);
	}
}

function normalize_connection_string(value: string | undefined): string {
	return (value ?? "").replace(/^['\"]|['\"]$/g, "").trim();
}

function connection_type(connection_string: string): string {
	return connection_string.split(":")[0]?.toLowerCase() ?? "";
}

function sqlite_path(connection_string: string): string {
	return connection_string.slice("sqlite:".length).replace(/^\/\//, "");
}

function quote_identifier(identifier: string): string {
	return `\`${identifier.replace(/`/g, "``")}\``;
}

function mask_password(connection_string: string): string {
	const match = connection_string.match(/^(mysql:\/\/)([^:]*)(:)([^@]*)(@.*)/);
	if (!match) return connection_string;
	return `${match[1]! + match[2]! + match[3]!}***${match[5]}`;
}

function fail(message: string): never {
	console.error(`✗ ${message}`);
	process.exit(1);
}
