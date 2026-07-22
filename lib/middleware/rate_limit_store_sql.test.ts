import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { db, DB_CONNECTION_STRING } from "$config/db";
import { now_epoch_ms } from "$lib/temporal";

import { cleanup_expired, expire, get, incr, list_all, reset_all } from "./rate_limit_store_sql";

// ---------------------------------------------------------------------------
// Schema - the store's table, mirroring the 01-init .sql files. The store
// binds to $config/db at import time, so these tests exercise whichever
// dialect CONNECTION_STRING points at and the DDL has to match it.
// ---------------------------------------------------------------------------

const is_mysql = DB_CONNECTION_STRING.toLowerCase().startsWith("mysql://");

if (is_mysql) {
	await db`
		CREATE TABLE IF NOT EXISTS rate_limit_counters (
			counter_key VARCHAR(191) NOT NULL PRIMARY KEY,
			count       INT UNSIGNED NOT NULL DEFAULT 0,
			expires_at  BIGINT       NOT NULL,
			INDEX rate_limit_counters_expires_at (expires_at)
		)
	`;
} else {
	await db`
		CREATE TABLE IF NOT EXISTS rate_limit_counters (
			counter_key TEXT    NOT NULL,
			count       INTEGER NOT NULL DEFAULT 0,
			expires_at  INTEGER NOT NULL,
			PRIMARY KEY(counter_key)
		)
	`;
}

beforeEach(async () => { await db`DELETE FROM rate_limit_counters`; });

afterAll(async () => { await db`DELETE FROM rate_limit_counters`; });

// ---------------------------------------------------------------------------
// Tests: incr
// ---------------------------------------------------------------------------

describe("incr", () => {
	test("returns 1, 2, 3 on repeated calls", async () => {
		const first = await incr("rl:login:ip:1.2.3.4:100");
		const second = await incr("rl:login:ip:1.2.3.4:100");
		const third = await incr("rl:login:ip:1.2.3.4:100");

		expect(first).toBe(1);
		expect(second).toBe(2);
		expect(third).toBe(3);
	});

	test("counts each key independently", async () => {
		await incr("rl:login:ip:1.1.1.1:100");
		await incr("rl:login:ip:1.1.1.1:100");
		const other = await incr("rl:login:ip:2.2.2.2:100");

		expect(other).toBe(1);
	});

	test("resets the count when the existing row has expired", async () => {
		const key = "rl:login:ip:9.9.9.9:100";
		await incr(key);
		await incr(key);

		// Force the row into the past - a new window must not inherit the old tally.
		const past = now_epoch_ms() - 1000;
		await db`UPDATE rate_limit_counters SET expires_at = ${past} WHERE counter_key = ${key}`;

		const after_expiry = await incr(key);
		expect(after_expiry).toBe(1);
	});

	// The whole reason the store uses INSERT .. ON CONFLICT .. RETURNING rather
	// than a read-modify-write: concurrent requests must not lose updates.
	test("concurrent increments land exactly once each", async () => {
		const key = "rl:global:ip:5.5.5.5:100";
		const calls = Array.from({ length: 50 }, () => incr(key));
		const results = await Promise.all(calls);

		const stored = await get(key);
		expect(Number(stored)).toBe(50);

		// Every increment saw a distinct post-increment value: 1..50, no dupes.
		const unique = new Set(results);
		expect(unique.size).toBe(50);
		expect(Math.max(...results)).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// Tests: get / expire
// ---------------------------------------------------------------------------

describe("get", () => {
	test("returns null for a missing key", async () => {
		const value = await get("rl:login:ip:missing:100");
		expect(value).toBeNull();
	});

	test("returns the count as a string", async () => {
		await incr("rl:login:ip:3.3.3.3:100");
		const value = await get("rl:login:ip:3.3.3.3:100");
		expect(value).toBe("1");
	});

	test("returns null for an expired row", async () => {
		const key = "rl:login:ip:4.4.4.4:100";
		await incr(key);

		const past = now_epoch_ms() - 1000;
		await db`UPDATE rate_limit_counters SET expires_at = ${past} WHERE counter_key = ${key}`;

		const value = await get(key);
		expect(value).toBeNull();
	});
});

describe("expire", () => {
	test("keeps a row readable within its new lifetime", async () => {
		const key = "rl:login:ip:6.6.6.6:100";
		await incr(key);
		await expire(key, 120);

		const value = await get(key);
		expect(value).toBe("1");
	});

	test("makes a row unreadable once the lifetime has passed", async () => {
		const key = "rl:login:ip:7.7.7.7:100";
		await incr(key);
		await expire(key, -1);

		const value = await get(key);
		expect(value).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Tests: sweep + admin helpers
// ---------------------------------------------------------------------------

describe("cleanup_expired", () => test("deletes only expired rows", async () => {
	const live_key = "rl:login:ip:live:100";
	const dead_key = "rl:login:ip:dead:100";

	await incr(live_key);
	await incr(dead_key);

	const past = now_epoch_ms() - 1000;
	await db`UPDATE rate_limit_counters SET expires_at = ${past} WHERE counter_key = ${dead_key}`;

	const deleted = await cleanup_expired();
	expect(deleted).toBe(1);

	const [row] = await db`SELECT counter_key FROM rate_limit_counters`;
	expect(row.counter_key).toBe(live_key);
}));

describe("reset_all", () => test("deletes every counter", async () => {
	await incr("rl:login:ip:a:100");
	await incr("rl:global:ip:b:100");

	const deleted = await reset_all();
	expect(deleted).toBe(2);

	const rows = await db`SELECT counter_key FROM rate_limit_counters`;
	expect(rows.length).toBe(0);
}));

describe("list_all", () => {
	test("returns live counters with key, count, and ttl", async () => {
		const key = "rl:login:ip:8.8.8.8:100";
		await incr(key);
		await incr(key);
		await expire(key, 120);

		const entries = await list_all();
		expect(entries.length).toBe(1);

		const entry = entries[0];
		expect(entry.key).toBe(key);
		expect(entry.count).toBe(2);
		expect(entry.ttl).toBeGreaterThan(0);
		expect(entry.ttl).toBeLessThanOrEqual(120);
	});

	test("omits expired counters", async () => {
		const key = "rl:login:ip:gone:100";
		await incr(key);

		const past = now_epoch_ms() - 1000;
		await db`UPDATE rate_limit_counters SET expires_at = ${past} WHERE counter_key = ${key}`;

		const entries = await list_all();
		expect(entries.length).toBe(0);
	});
});
