/**
 * Rate limit store resolver.
 *
 * Selects the backing store by config rather than hardcoding, mirroring the
 * session store precedent (routes/system/auth/session_store.ts): Redis when
 * REDIS_URL is set, SQL otherwise. Call sites depend on the RateLimitStore
 * contract only, so neither backend leaks past this module.
 */
import { RedisClient } from "bun";

import type { RateLimitStore } from "./rate_limit";
import sql_store from "./rate_limit_store_sql";

export type AdminRateLimitStore = RateLimitStore & {
	reset_all: () => Promise<number>;
	list_all: () => Promise<Array<{ key: string; count: number; ttl: number; }>>;
	cleanup_expired: () => Promise<number>;
};

// ---------------------------------------------------------------------------
// Redis-backed store - wraps the Bun redis client in the same admin contract
// ---------------------------------------------------------------------------

// Built on first use, never at import time: Bun's default `redis` export parses
// REDIS_URL eagerly and throws on an empty or malformed value, which would
// break the very Redis-free installs the SQL store exists to serve.
let redis_client: RedisClient | null = null;

function get_redis(): RedisClient {
	if (!redis_client) { redis_client = new RedisClient(Bun.env.REDIS_URL?.trim()); }
	return redis_client;
}

async function scan_all_rl_keys(pattern: string): Promise<string[]> {
	const redis = get_redis();
	const all_keys: string[] = [];
	let cursor = "0";

	do {
		const result = (await redis.send("SCAN", [cursor, "MATCH", pattern, "COUNT", "100"])) as [string, string[]];
		cursor = result[0];
		all_keys.push(...result[1]);
	} while (cursor !== "0");

	return all_keys;
}

const redis_store: AdminRateLimitStore = {
	incr: (key: string) => {
		const redis = get_redis();
		return redis.incr(key);
	},

	expire: async (key: string, seconds: number) => {
		const redis = get_redis();
		await redis.expire(key, seconds);
	},

	get: (key: string) => {
		const redis = get_redis();
		return redis.get(key);
	},

	reset_all: async () => {
		const keys = await scan_all_rl_keys("rl:*");
		if (!keys.length) return 0;

		const redis = get_redis();
		const deleted = await redis.del(...keys);
		return Number(deleted);
	},

	list_all: async () => {
		const keys = await scan_all_rl_keys("rl:*");
		if (!keys.length) return [];

		const redis = get_redis();
		const counts_promise = Promise.all(keys.map((k) => redis.get(k)));
		const ttls_promise = Promise.all(keys.map((k) => redis.send("TTL", [k]) as Promise<number>));
		const [counts, ttls] = await Promise.all([counts_promise, ttls_promise]);

		return keys.map((key, i) => ({ key, count: Number(counts[i] ?? 0), ttl: Number(ttls[i] ?? -1) }));
	},

	// Redis expires keys natively - nothing to sweep.
	cleanup_expired: async () => 0,
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function is_redis_backed(): boolean { return !!Bun.env.REDIS_URL?.trim(); }

export function resolve_rate_limit_store(): AdminRateLimitStore { return is_redis_backed() ? redis_store : sql_store; }
