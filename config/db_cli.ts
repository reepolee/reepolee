/**
 * CLI-specific database connection - reconnectable singleton with a keepalive
 * timer. Split out of config/db.ts so the server, worker, and tests never pay
 * for the extra pool + interval that only standalone CLI scripts (reeman,
 * generators) need.
 *
 * Use `db_cli` as a tagged template (live binding - reassignment propagates
 * to all importers via ES module semantics). Call `sync_db_cli()` when
 * CONNECTION_STRING changes at runtime (e.g. after "Set database type").
 */
import { require_env } from "$lib/env";
import { SQL } from "bun";

import { DB_CONNECTION_STRING } from "./db";

let _cached_url: string = DB_CONNECTION_STRING;
// Keepalive timer prevents the event loop from exiting before SQL queries
// complete in standalone CLI scripts (e.g. reeman generator). Without this,
// Bun may exit while an async query is still in-flight when there is no
// other pending I/O (e.g. after stdin is paused by select_from_list).
let _cli_keepalive: Timer | null = setInterval(() => {}, 2_147_483_647);

export let db_cli: SQL = new SQL(DB_CONNECTION_STRING);

// SQLite only allows one writer at a time. Without WAL + a busy timeout, the
// generator/reeman connection and the dev server's own connection collide
// instantly with SQLITE_BUSY instead of the second connection briefly waiting.
async function apply_sqlite_pragmas(connection: SQL, url: string): Promise<void> {
	if (!url.toLowerCase().startsWith("sqlite:")) return;
	await connection`PRAGMA journal_mode = WAL`;
	await connection`PRAGMA busy_timeout = 1000`;
}

await apply_sqlite_pragmas(db_cli, DB_CONNECTION_STRING);

/**
 * Reconnect db_cli if CONNECTION_STRING has changed at runtime.
 * Returns true if a new connection was created.
 */
export async function sync_db_cli(): Promise<boolean> {
	const raw = Bun.env.CONNECTION_STRING?.trim() || require_env("CONNECTION_STRING");
	const new_url = raw.replace(/^["']|["']$/g, "");

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
