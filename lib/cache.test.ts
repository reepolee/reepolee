import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { sanitize_env_value } from "$lib/env";
import { RedisClient } from "bun";

// ---------------------------------------------------------------------------
// Guard bypass - cache.ts exits if CACHE_ENABLED without REDIS_URL.
// We need REDIS_URL set before the dynamic import, then restore immediately.
// ---------------------------------------------------------------------------

const _restore_cache = process.env.CACHE_ENABLED;
const _restore_redis = process.env.REDIS_URL;
process.env.CACHE_ENABLED = "true";
process.env.REDIS_URL = "redis://guard-bypass";

const { create_cache } = await import("./cache");

if (_restore_cache === undefined) {
	delete process.env.CACHE_ENABLED;
} else {
	process.env.CACHE_ENABLED = _restore_cache;
}
if (_restore_redis === undefined) {
	delete process.env.REDIS_URL;
} else {
	process.env.REDIS_URL = _restore_redis;
}

// ---------------------------------------------------------------------------
// Real Redis test client - uses DB 1 to avoid clobbering the dev server.
// Skips gracefully (like generator/user.test.ts) when TEST_REDIS_URL is not
// set, so a Redis-free install (the .env.example default) still runs the rest
// of the suite instead of process.exit-ing the whole run.
// ---------------------------------------------------------------------------

const raw_test_redis_url = Bun.env.TEST_REDIS_URL;
const TEST_REDIS_URL = raw_test_redis_url ? sanitize_env_value(raw_test_redis_url) : null;

if (!TEST_REDIS_URL) { console.error("[cache.test.ts] TEST_REDIS_URL not set - skipping Redis-dependent tests"); }

const run = TEST_REDIS_URL ? describe : describe.skip;

let redis: RedisClient;

beforeEach(async () => {
	if (!TEST_REDIS_URL) return;
	redis = new RedisClient(TEST_REDIS_URL);
	await redis.send("FLUSHDB", []);
});

afterAll(async () => { if (redis) await redis.close(); });

function fresh_cache() { return create_cache(redis); }

// ---------------------------------------------------------------------------
// Tests: cache.search
// ---------------------------------------------------------------------------

run("cache.search", () => {
	test("caches result on first call, returns cached on second (query_fn not called again)", async () => {
		const c = fresh_cache();
		let call_count = 0;
		const query_fn = async () => {
			call_count++;
			return { data: "hello" };
		};

		const result1 = await c.search("/test/route", { id: 1 }, ["test_table"], query_fn);
		expect(result1).toEqual({ data: "hello" });
		expect(call_count).toBe(1);

		const result2 = await c.search("/test/route", { id: 1 }, ["test_table"], query_fn);
		expect(result2).toEqual({ data: "hello" });
		expect(call_count).toBe(1);
	});

	test("returns fresh result when params differ (cache miss)", async () => {
		const c = fresh_cache();
		let call_count = 0;
		const query_fn = async () => {
			call_count++;
			return { data: `result-${call_count}` };
		};

		await c.search("/test", { id: 1 }, ["t"], query_fn);
		expect(call_count).toBe(1);

		const result = await c.search("/test", { id: 2 }, ["t"], query_fn);
		expect(result).toEqual({ data: "result-2" });
		expect(call_count).toBe(2);
	});

	test("registers cache key in dependency set for each view_dep", async () => {
		const c = fresh_cache();
		await c.search("/route", { x: 1 }, ["table_a", "table_b"], async () => ({ ok: true }));

		// Both dep sets should have 1 member each
		const deps_a = await redis.smembers("sql:deps:table_a");
		const deps_b = await redis.smembers("sql:deps:table_b");
		expect(deps_a.length).toBe(1);
		expect(deps_b.length).toBe(1);

		// Both sets reference the same cache key
		expect(deps_a[0]).toBe(deps_b[0]);
	});

	test("caches complex data types (arrays, objects, primitives)", async () => {
		const c = fresh_cache();
		const query_fn = async () => ({
			records: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
			total: 2,
		});

		const result1 = await c.search("/users", { limit: 10 }, ["users"], query_fn);
		expect(result1.records).toHaveLength(2);
		expect(result1.total).toBe(2);

		const result2 = await c.search("/users", { limit: 10 }, ["users"], query_fn);
		expect(result2).toEqual(result1);
	});

	test("skips caching when result exceeds MAX_CACHE_BYTES", async () => {
		const c = fresh_cache();
		let call_count = 0;

		const big_result = {
			records: Array.from({ length: 10000 }).fill(null).map((_, i) => ({
				id: i,
				name: "A".repeat(200),
				vat_number: i * 1000,
				registration_number: `REG-${i}`,
			})),
			total: 10000,
		};

		const query_fn = async () => {
			call_count++;
			return big_result;
		};

		const result1 = await c.search("/big", { limit: 10000 }, ["big_table"], query_fn);
		expect(result1).toBe(big_result);
		expect(call_count).toBe(1);

		const result2 = await c.search("/big", { limit: 10000 }, ["big_table"], query_fn);
		expect(result2).toBe(big_result);
		expect(call_count).toBe(2); // too large to cache
	});

	test("caches small results normally (below MAX_CACHE_BYTES)", async () => {
		const c = fresh_cache();
		let call_count = 0;

		const small_result = { records: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }], total: 2 };

		const query_fn = async () => {
			call_count++;
			return small_result;
		};

		const result1 = await c.search("/small", { limit: 10 }, ["small_table"], query_fn);
		expect(result1).toEqual(small_result);
		expect(call_count).toBe(1);

		const result2 = await c.search("/small", { limit: 10 }, ["small_table"], query_fn);
		expect(result2).toEqual(small_result);
		expect(call_count).toBe(1);
	});

	test("falls back to query_fn on Redis error", async () => {
		const c = fresh_cache();
		await redis.close();

		try {
			let call_count = 0;
			const query_fn = async () => {
				call_count++;
				return { ok: true };
			};

			const result = await c.search("/fragile", { x: 1 }, ["t"], query_fn);
			expect(result).toEqual({ ok: true });
			expect(call_count).toBe(1);

			// Second call - Redis still closed, falls back again (no cache storage)
			const result2 = await c.search("/fragile", { x: 1 }, ["t"], query_fn);
			expect(result2).toEqual({ ok: true });
			expect(call_count).toBe(2);
		} finally {
			redis = new RedisClient(TEST_REDIS_URL);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: cache.invalidate
// ---------------------------------------------------------------------------

run("cache.invalidate", () => {
	test("removes all cache keys for the given table", async () => {
		const c = fresh_cache();
		await c.search("/r1", { q: 1 }, ["table_a"], async () => "value1");
		await c.search("/r2", { q: 2 }, ["table_a"], async () => "value2");
		await c.search("/r3", { q: 3 }, ["table_b"], async () => "value3");

		await c.invalidate("table_a");

		const dep_a = await redis.smembers("sql:deps:table_a");
		const dep_b = await redis.smembers("sql:deps:table_b");
		expect(dep_a.length).toBe(0);
		expect(dep_b.length).toBe(1);
	});

	test("cache miss after invalidation - query_fn runs again", async () => {
		const c = fresh_cache();
		let call_count = 0;
		const query_fn = async () => {
			call_count++;
			return { data: "value" };
		};

		await c.search("/route", { id: 1 }, ["t"], query_fn);
		expect(call_count).toBe(1);

		await c.invalidate("t");

		await c.search("/route", { id: 1 }, ["t"], query_fn);
		expect(call_count).toBe(2);
	});

	test("invalidate is a no-op for tables with no cached entries", async () => {
		const c = fresh_cache();
		await c.invalidate("nonexistent");
		// Should not throw
	});

	test("invalidate clears dependency set after deleting cache keys", async () => {
		const c = fresh_cache();
		await c.search("/r", { p: 1 }, ["x"], async () => "val");

		const deps_before = await redis.smembers("sql:deps:x");
		expect(deps_before.length).toBe(1);

		await c.invalidate("x");

		const deps_after = await redis.smembers("sql:deps:x");
		expect(deps_after.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: cache.get_status
// ---------------------------------------------------------------------------

run("cache.get_status", () => {
	test("returns status with cache entries", async () => {
		const c = fresh_cache();
		await c.search("/r1", { q: 1 }, ["table_a"], async () => "v1");
		await c.search("/r2", { q: 2 }, ["table_b"], async () => "v2");

		const status = await c.get_status();
		expect(status?.enabled).toBe(true);
		expect(status?.total_cache_keys).toBe(2);
		expect(status?.total_dep_keys).toBe(2);
	});

	test("returns sorted tables by cache_key_count descending", async () => {
		const c = fresh_cache();
		await c.search("/r1", {}, ["table_a"], async () => "v1");
		await c.search("/r2", {}, ["table_a"], async () => "v2");
		await c.search("/r3", {}, ["table_a"], async () => "v3");
		await c.search("/r4", {}, ["table_b"], async () => "v4");

		const status = await c.get_status();
		const table_a = status?.tables.find((t) => t.name === "table_a");
		const table_b = status?.tables.find((t) => t.name === "table_b");
		expect(table_a?.cache_key_count).toBe(3);
		expect(table_b?.cache_key_count).toBe(1);
	});

	test("returns empty tables when no dep keys exist", async () => {
		const c = fresh_cache();
		const status = await c.get_status();
		expect(status?.tables).toEqual([]);
	});

	test("handles Redis error gracefully", async () => {
		await redis.close();
		try {
			const c = create_cache(new RedisClient(TEST_REDIS_URL));
			// get_status has internal try/catch - should return fallback, not throw
			const status = await c.get_status();
			expect(status?.enabled).toBe(true);
			expect(status?.total_cache_keys).toBe(0);
			expect(status?.tables).toEqual([]);
		} finally {
			redis = new RedisClient(TEST_REDIS_URL);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: cache.invalidate_all
// ---------------------------------------------------------------------------

run("cache.invalidate_all", () => {
	test("deletes all sql:* keys", async () => {
		const c = fresh_cache();
		await c.search("/r1", { q: 1 }, ["t1"], async () => "v1");
		await c.search("/r2", { q: 2 }, ["t2"], async () => "v2");

		const result = await c.invalidate_all();
		expect(result.deleted).toBeGreaterThan(0);

		// Verify nothing left
		const keys = await redis.send("KEYS", ["sql:*"]);
		expect((keys as string[]).length).toBe(0);
	});

	test("returns 0 when no keys exist", async () => {
		const c = fresh_cache();
		const result = await c.invalidate_all();
		expect(result).toEqual({ deleted: 0 });
	});

	test("throws on Redis error", async () => {
		await redis.close();
		try {
			// Redis is now down - invalidate_all should throw
			const c = fresh_cache();
			await expect(c.invalidate_all()).rejects.toThrow();
		} finally {
			redis = new RedisClient(TEST_REDIS_URL);
		}
	});
});

// ---------------------------------------------------------------------------
// Tests: cache.is_enabled
// ---------------------------------------------------------------------------

run("cache.is_enabled", () => test("returns true when CACHE_ENABLED=true", () => {
	const c = fresh_cache();
	expect(c.is_enabled()).toBe(true);
}));

// ---------------------------------------------------------------------------
// Tests: cache.search - edge cases
// ---------------------------------------------------------------------------

run("cache.search - edge cases", () => test("handles null and empty params in key generation", async () => {
	const c = fresh_cache();
	let call_count = 0;

	await c.search("/route", {
		id: 1,
		optional: null,
		empty: "",
		skip: undefined,
	}, ["t"], async () => {
		call_count++;
		return { ok: true };
	});

	expect(call_count).toBe(1);

	await c.search("/route", {
		id: 1,
		optional: null,
		empty: "",
		skip: undefined,
	}, ["t"], async () => {
		call_count++;
		return { ok: true };
	});
	expect(call_count).toBe(1);
}));
