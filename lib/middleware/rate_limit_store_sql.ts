/**
 * Rate limit store backed by SQL (SQLite / MySQL) via Bun native SQL.
 *
 * Implements the same KV contract as the Redis client (incr / expire / get)
 * so `check_rate_limit()` works unchanged against either backend.
 *
 * Two things Redis gives for free and SQL does not:
 * 1. Atomic increment - handled with a single upsert .. RETURNING statement, so
 *    no read-modify-write window exists between concurrent requests.
 * 2. Key expiry - emulated with an `expires_at` column: `get()` ignores expired
 *    rows (lazy expiry) and `cleanup_expired()` sweeps them (see bootstrap).
 */
import { db, DB_CONNECTION_STRING } from "$config/db";
import { now_epoch_ms } from "$lib/temporal";

import type { RateLimitStore } from "./rate_limit";

// Default lifetime applied on first insert. check_rate_limit() immediately
// follows a first incr with expire(), which overwrites this with the real
// window. It only has to outlive that round trip.
const DEFAULT_TTL_MS = 120 * 1000;

const connection_prefix = DB_CONNECTION_STRING.toLowerCase();
const is_mysql = connection_prefix.startsWith("mysql://");

/**
 * Atomically increment a counter and return the post-increment value.
 *
 * The upsert must be a single statement: a read-modify-write would let two
 * concurrent requests both read N and both write N+1, undercounting the limit.
 *
 * An existing but expired row is treated as absent - the update branch resets
 * `count` to 1 and re-arms `expires_at` rather than continuing the old tally.
 * Without that reset a stale row from a previous window would inflate the new one.
 *
 * Dialects diverge here and nowhere else in this file: SQLite spells the upsert
 * `ON CONFLICT .. DO UPDATE`, MySQL/MariaDB `ON DUPLICATE KEY UPDATE`. Both
 * support RETURNING (SQLite 3.35+, MariaDB 10.5+), which is what makes the
 * post-increment value readable without a second round trip.
 */
async function incr_sqlite(key: string, now: number, expires_at: number): Promise<number> {
	const rows = await db`
		INSERT INTO rate_limit_counters (counter_key, count, expires_at)
		VALUES (${key}, 1, ${expires_at})
		ON CONFLICT(counter_key) DO UPDATE SET
			count = CASE WHEN rate_limit_counters.expires_at > ${now} THEN rate_limit_counters.count + 1 ELSE 1 END,
			expires_at = CASE WHEN rate_limit_counters.expires_at > ${now} THEN rate_limit_counters.expires_at ELSE ${expires_at} END
		RETURNING count
	`;
	const row = rows[0];
	return Number(row?.count ?? 0);
}

async function incr_mysql(key: string, now: number, expires_at: number): Promise<number> {
	// `rate_limit_counters.expires_at` is qualified so it always reads the stored
	// row, never the value being inserted. The count assignment is evaluated
	// before the expires_at assignment, so the CASE below still sees the old
	// expiry when deciding whether to continue or reset the tally.
	const rows = await db`
		INSERT INTO rate_limit_counters (counter_key, count, expires_at)
		VALUES (${key}, 1, ${expires_at})
		ON DUPLICATE KEY UPDATE
			count = CASE WHEN rate_limit_counters.expires_at > ${now} THEN rate_limit_counters.count + 1 ELSE 1 END,
			expires_at = CASE WHEN rate_limit_counters.expires_at > ${now} THEN rate_limit_counters.expires_at ELSE ${expires_at} END
		RETURNING count
	`;
	const row = rows[0];
	return Number(row?.count ?? 0);
}

async function incr(key: string): Promise<number> {
	const now = now_epoch_ms();
	const expires_at = now + DEFAULT_TTL_MS;
	return is_mysql ? incr_mysql(key, now, expires_at) : incr_sqlite(key, now, expires_at);
}

/**
 * Set the remaining lifetime of a counter, in seconds.
 * The row already exists (incr() created it), so this only moves `expires_at`.
 */
async function expire(key: string, seconds: number): Promise<void> {
	const expires_at = now_epoch_ms() + seconds * 1000;
	await db`UPDATE rate_limit_counters SET expires_at = ${expires_at} WHERE counter_key = ${key}`;
}

/**
 * Read a counter. Expired rows read as absent (null), mirroring Redis TTL
 * semantics - the sweep deletes them later.
 */
async function get(key: string): Promise<string | null> {
	const now = now_epoch_ms();
	const rows = await db`SELECT count FROM rate_limit_counters WHERE counter_key = ${key} AND expires_at > ${now}`;
	const row = rows[0];
	return row ? String(row.count) : null;
}

/**
 * Rows touched by a DELETE/UPDATE. The two dialects report this differently:
 * SQLite fills `count` and leaves `affectedRows` null, MySQL does the reverse.
 */
function affected_rows(result: unknown): number {
	const res = result as { count?: number | null; affectedRows?: number | null; };
	return Number(res?.affectedRows ?? res?.count ?? 0);
}

/**
 * Delete every rate limit counter. Backs the admin reset endpoint.
 */
async function reset_all(): Promise<number> {
	const result = await db`DELETE FROM rate_limit_counters`;
	return affected_rows(result);
}

/**
 * Snapshot of all live counters, for the admin status endpoint.
 * `ttl` is seconds remaining, matching the Redis TTL command's units.
 */
async function list_all(): Promise<Array<{ key: string; count: number; ttl: number; }>> {
	const now = now_epoch_ms();
	const rows = await db`SELECT counter_key, count, expires_at FROM rate_limit_counters WHERE expires_at > ${now}`;
	return rows.map((row: any) => ({
		key: String(row.counter_key),
		count: Number(row.count),
		ttl: Math.max(0, Math.round((Number(row.expires_at) - now) / 1000)),
	}));
}

/**
 * Delete expired counter rows. Rate limit windows are short (60s), so without
 * a periodic sweep these rows accumulate forever - lazy expiry in get() hides
 * them but never reclaims the space.
 */
async function cleanup_expired(): Promise<number> {
	const now = now_epoch_ms();
	const result = await db`DELETE FROM rate_limit_counters WHERE expires_at <= ${now}`;
	return affected_rows(result);
}

export default { incr, expire, get, reset_all, list_all, cleanup_expired } satisfies RateLimitStore & {
	reset_all: () => Promise<number>;
	list_all: () => Promise<Array<{ key: string; count: number; ttl: number; }>>;
	cleanup_expired: () => Promise<number>;
};

export { cleanup_expired, expire, get, incr, list_all, reset_all };
