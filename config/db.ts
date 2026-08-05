/**
 * Database config - registry pattern.
 * Each DB type declares its own timezone config; adding a new DB means
 * adding a single entry to the CONFIGS map. No ternaries, no dynamic imports.
 */
import { require_env } from "$lib/env";
import { SQL } from "bun";

type DbConfig = { tz_date: string; tz_time: string; tz_datetime: string; tz_timestamp: string; };

const TIME_ZONE = require_env("TIME_ZONE");

const CONFIGS: Record<string, DbConfig> = {
	sqlite: { tz_date: "UTC", tz_time: "UTC", tz_datetime: "UTC", tz_timestamp: TIME_ZONE },
	mysql: { tz_date: TIME_ZONE, tz_time: TIME_ZONE, tz_datetime: TIME_ZONE, tz_timestamp: TIME_ZONE },
};

export const DB_CONNECTION_STRING = require_env("CONNECTION_STRING");
const url = DB_CONNECTION_STRING;
const prefix = url.split(":")[0]?.toLowerCase() ?? "";
const config = CONFIGS[prefix];

if (!config) {
	const supported = Object.keys(CONFIGS).join(", ");
	console.error(`\x1b[31mUnsupported DB \`${prefix}\`. Expected CONNECTION_STRING with one of: ${supported}\x1b[0m`);
	process.exit(1);
}

export const DATE_TZ = config.tz_date;
export const TIME_TZ = config.tz_time;
export const DATETIME_TZ = config.tz_datetime;
export const TIMESTAMP_TZ = config.tz_timestamp;

export const db = new SQL(url);

// SQLite only allows one writer at a time. Without WAL + a busy timeout, the
// dev server and reeman/generator CLI (a separate process/connection) collide
// instantly with SQLITE_BUSY instead of the second connection briefly waiting.
if (prefix === "sqlite") {
	await db`PRAGMA journal_mode = WAL`;
	await db`PRAGMA busy_timeout = 1000`;
}

// Schema guard
// Runs at module load time as the earliest possible DB schema check.
// If the modules table is missing, the DB isn't initialized - fail loud.
export async function verify_db_schema(): Promise<void> {
	try {
		await db`SELECT 1 FROM modules LIMIT 1`;
	} catch (error) {
		console.error("\n----------------------------------------");
		console.error("  ✗ DATABASE NOT INITIALIZED");
		console.error("");
		console.error("  Required table 'modules' is missing.");
		console.error("  Run reeman and do a Quick start setup.");
		console.error("----------------------------------------\n");
		throw error;
	}
}

export async function close_db(): Promise<void> { await db.close(); }

console.log(`\x1b[34mUsing DB ${prefix.toUpperCase()}\x1b[0m`);
