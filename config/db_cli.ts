/**
 * CLI-specific database connection - reconnectable singleton with a keepalive
 * timer. Split out of config/db.ts so the server, worker, and tests never pay
 * for the extra pool + interval that only standalone CLI scripts (reeman,
 * generators) need.
 *
 * Use `db_cli` as a tagged template (live binding - reassignment propagates
 * to all importers via ES module semantics). Call `sync_db_cli()` when
 * DEV_CONNECTION_STRING changes at runtime (e.g. after "Set database type").
 *
 * Pinned to DEV_CONNECTION_STRING: these are development tools and must never
 * open a connection to the production database, whatever flags they are given.
 */
import { get_connection_string } from "$lib/env";
import { SQL } from "bun";

const DEV_CONNECTION_STRING = get_connection_string("DEV");

let _cached_url: string = DEV_CONNECTION_STRING;
// Keepalive timer prevents the event loop from exiting before SQL queries
// complete in standalone CLI scripts (e.g. reeman generator). Without this,
// Bun may exit while an async query is still in-flight when there is no
// other pending I/O (e.g. after stdin is paused by select_from_list).
let _cli_keepalive: Timer | null = setInterval(() => {}, 2_147_483_647);

export let db_cli: SQL = new SQL(DEV_CONNECTION_STRING);

// SQLite only allows one writer at a time. Without WAL + a busy timeout, the
// generator/reeman connection and the dev server's own connection collide
// instantly with SQLITE_BUSY instead of the second connection briefly waiting.
async function apply_sqlite_pragmas(connection: SQL, url: string): Promise<void> {
	if (!url.toLowerCase().startsWith("sqlite:")) return;
	// Set the timeout before the recovery checkpoint. The checkpoint takes a
	// writer lock, so setting it afterwards cannot protect this query when
	// several dev:all processes open SQLite at the same time.
	await connection`PRAGMA busy_timeout = 5000`;
	// Recover from unclean shutdown: checkpoint any pending WAL entries
	// so the connection doesn't fail with SQLITE_BUSY_RECOVERY (errno 261)
	// when WAL files are left behind by a killed process.
	await connection`PRAGMA wal_checkpoint(TRUNCATE)`;
	await connection`PRAGMA journal_mode = WAL`;
}

await apply_sqlite_pragmas(db_cli, DEV_CONNECTION_STRING);

/**
 * Reconnect db_cli if DEV_CONNECTION_STRING has changed at runtime.
 * Returns true if a new connection was created.
 */
export async function sync_db_cli(): Promise<boolean> {
	const new_url = get_connection_string("DEV");

	if (new_url === _cached_url) return false;

	// Close old connection (fire-and-forget - if it's stale it may already be dead)
	db_cli.close().catch(() => {
		/* old connection may already be dead */
	});
	if (_cli_keepalive) { clearInterval(_cli_keepalive); }

	// Create new connection
	_cached_url = new_url;
	_cli_keepalive = setInterval(() => {}, 2_147_483_647);
	db_cli = new SQL(new_url);
	await apply_sqlite_pragmas(db_cli, new_url);

	const new_prefix = new_url.split(":")[0]?.toLowerCase() || "?";
	console.log(`\x1b[34mDB reconnected: ${new_prefix.toUpperCase()}\x1b[0m`);
	return true;
}

export async function close_db_cli(): Promise<void> {
	if (_cli_keepalive) {
		clearInterval(_cli_keepalive);
		_cli_keepalive = null;
	}
	await db_cli.close();
}
