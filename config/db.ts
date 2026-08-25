/**
 * Database config - registry pattern.
 * Each DB type declares its own timezone config; adding a new DB means
 * adding a single entry to the CONFIGS map. No ternaries, no dynamic imports.
 */
import { CONNECTION_STRING_VAR, get_connection_string, require_env } from "$lib/env";
import { env_switch_on } from "$config/env_vars";
import { SQL } from "bun";

type DbConfig = { tz_date: string; tz_time: string; tz_datetime: string; tz_timestamp: string; };

const TIME_ZONE = require_env("TIME_ZONE");

const CONFIGS: Record<string, DbConfig> = {
	sqlite: { tz_date: "UTC", tz_time: "UTC", tz_datetime: "UTC", tz_timestamp: TIME_ZONE },
	mysql: { tz_date: TIME_ZONE, tz_time: TIME_ZONE, tz_datetime: TIME_ZONE, tz_timestamp: TIME_ZONE },
};

// The only place that decides between the development and the production
// database. `--prod` (i.e. `bun start`) selects PROD_CONNECTION_STRING, every
// other mode selects DEV_CONNECTION_STRING. Everything else in the repo either
// imports DB_CONNECTION_STRING from here or - for development-only tooling -
// reads DEV_CONNECTION_STRING directly.
export const DB_CONNECTION_STRING = get_connection_string();
const url = DB_CONNECTION_STRING;
const prefix = url.split(":")[0]?.toLowerCase() ?? "";
const config = CONFIGS[prefix];

if (!config) {
	const supported = Object.keys(CONFIGS).join(", ");
	console.error(`\x1b[31mUnsupported DB \`${prefix}\`. Expected ${CONNECTION_STRING_VAR} with one of: ${supported}\x1b[0m`);
	process.exit(1);
}

export const DATE_TZ = config.tz_date;
export const TIME_TZ = config.tz_time;
export const DATETIME_TZ = config.tz_datetime;
export const TIMESTAMP_TZ = config.tz_timestamp;

// The connection lives on globalThis so a `bun --hot` re-evaluation reuses it
// instead of opening (and leaking) a second connection - a whole pool under
// MySQL - and so cached importers and re-evaluated importers hold the same
// object. The connection string is fixed for the life of the process:
// dev_run.ts restarts the app on .env/config changes.
declare global {
	var __reepolee_db: SQL | undefined;
}

export const db: SQL = globalThis.__reepolee_db ?? new SQL(url);

// One-time connection setup. SQLite only allows one writer at a time. Without
// WAL + a busy timeout, the dev server and reeman/generator CLI (a separate
// process/connection) collide instantly with SQLITE_BUSY instead of the second
// connection briefly waiting.
if (!globalThis.__reepolee_db) {
	globalThis.__reepolee_db = db;
	if (prefix === "sqlite") {
		// Set the timeout before the recovery checkpoint. The checkpoint takes a
		// writer lock, so setting it afterwards cannot protect this query when
		// several dev:all processes open SQLite at the same time.
		await db`PRAGMA busy_timeout = 5000`;
		// Recover from unclean shutdown: checkpoint any pending WAL entries
		// so the connection doesn't fail with SQLITE_BUSY_RECOVERY (errno 261)
		// when WAL files are left behind by a killed process.
		await db`PRAGMA wal_checkpoint(TRUNCATE)`;
		await db`PRAGMA journal_mode = WAL`;
	}
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

export async function close_db(): Promise<void> {
	await db.close();
	globalThis.__reepolee_db = undefined;
}

const db_message = `\x1b[34mUsing DB ${prefix.toUpperCase()}\x1b[0m`;
if (env_switch_on("MCP_STDIO")) {
	console.error(db_message);
} else {
	console.log(db_message);
}
