import { redis as default_redis } from "bun";

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const CACHE_ENABLED = Bun.env.CACHE_ENABLED?.trim().toLowerCase() === "true";

if (CACHE_ENABLED && !Bun.env.REDIS_URL) {
	console.error("\u001b[31m✗ CACHE_ENABLED=true requires REDIS_URL to be set\u001b[0m");
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_TTL_S = 300; // 5 minutes

// Size guards (env-overridable, defaults safe for 256MB Redis)

/**
 * Maximum serialized bytes for a cached value.
 * Set via CACHE_MAX_BYTES env var (e.g. "1048576" for 1 MB).
 */
const MAX_CACHE_BYTES = parseInt(Bun.env.CACHE_MAX_BYTES || "", 10) || 512 * 1024;

/**
 * Maximum record count for cached query results (fast pre-check).
 * Set via CACHE_MAX_RECORDS env var (e.g. "2000").
 */
const MAX_CACHE_RECORDS = parseInt(Bun.env.CACHE_MAX_RECORDS || "", 10) || 500;

// ---------------------------------------------------------------------------
// Key builder
// ---------------------------------------------------------------------------

function serialize_val(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (Array.isArray(v)) { return `[${v.map(serialize_val).join(",")}]`; }
	if (typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, val]) => `${k}:${serialize_val(val)}`)
			.join(",");
		return `{${entries}}`;
	}
	return String(v);
}

function make_key(route: string, params: Record<string, unknown>): string {
	const parts: string[] = [route];
	for (const [k, v] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
		if (v !== null && v !== undefined && v !== "") { parts.push(`${k}:${serialize_val(v)}`); }
	}
	return `sql:cache:${parts.join(":")}`;
}

// ---------------------------------------------------------------------------
// Request coalescing - deduplicate concurrent cache misses (stampede protection)
// ---------------------------------------------------------------------------

const pending_queries = new Map();

// ---------------------------------------------------------------------------
// SCAN helper - iterate SCAN until cursor returns to 0
// ---------------------------------------------------------------------------

async function scan_all_keys(redis_client: typeof default_redis, pattern: string, count: number = 100): Promise<string[]> {
	const all_keys: string[] = [];
	let cursor = "0";

	do {
		const result = (await redis_client.send("SCAN", [cursor, "MATCH", pattern, "COUNT", String(count)])) as [string, string[]];
		cursor = result[0];
		const keys = result[1];
		all_keys.push(...keys);
	} while (cursor !== "0");

	return all_keys;
}

// ---------------------------------------------------------------------------
// Public API - factory function for testability
// ---------------------------------------------------------------------------

export function create_cache(redis_client: typeof default_redis) {
	return {
		/**
		 * Wraps a search query with Redis caching and dependency tracking.
		 * On cache miss, stores the result and registers it in dependency sets
		 * for each table in `view_deps`.
		 *
		 * On Redis error, falls back to `query_fn()` directly with a warning.
		 */
		async search<T>(route: string, params: Record<string, unknown>, view_deps: string[], query_fn: () => Promise<T>): Promise<T> {
			if (!CACHE_ENABLED) return query_fn();

			const cache_key = make_key(route, params);

			try {
				const cached = await redis_client.get(cache_key);
				if (cached) { return JSON.parse(cached) as T; }

				// Cache stampede protection: coalesce concurrent misses for the same key.
				// If another request is already fetching this key, join that promise instead
				// of executing query_fn a second time.
				const pending = pending_queries.get(cache_key);
				if (pending) { return pending as Promise<T>; }

				// Start new query and track it in pending map
				const promise = (async () => {
					const result = await query_fn();
					return result;
				})();
				pending_queries.set(cache_key, promise);

				try {
					const result = await promise;

					// Size guard: skip caching if the result is too large for Redis.
					// Fast O(1) pre-check for the common { records, total } shape:
					// avoid serializing 300K records just to measure their size.
					const maybe_records = result && typeof result === "object" && "records" in result ? (result as any).records : null;
					if (Array.isArray(maybe_records) && maybe_records.length > MAX_CACHE_RECORDS) {
						console.warn(`[cache] Skipping ${cache_key}: ${maybe_records.length} records exceeds ${MAX_CACHE_RECORDS} limit`);
						return result;
					}

					const payload_json = JSON.stringify(result);
					if (payload_json.length > MAX_CACHE_BYTES) {
						console.warn(`[cache] Skipping ${cache_key}: ${(payload_json.length / 1024).toFixed(0)}KB exceeds ${MAX_CACHE_BYTES / 1024}KB limit`);
						return result;
					}

					await Promise.all([
						redis_client.set(cache_key, payload_json, "EX", DEFAULT_TTL_S),
						...view_deps.map((table) => redis_client.sadd(`sql:deps:${table}`, cache_key)),
					]);

					return result;
				} finally {
					pending_queries.delete(cache_key);
				}
			} catch (err) {
				pending_queries.delete(cache_key);
				console.warn(`[cache] Redis error for ${route}:`, err);
				return query_fn();
			}
		},

		/**
		 * Invalidates all cached search results that depend on `table_name`.
		 * Reads the dependency SET, deletes all member cache keys, then deletes the SET itself.
		 */
		async invalidate(table_name: string): Promise<void> {
			if (!CACHE_ENABLED) return;
			const dep_key = `sql:deps:${table_name}`;

			try {
				const keys = await redis_client.smembers(dep_key);
				if (keys.length > 0) { await redis_client.del(...keys, dep_key); }
			} catch (err) {
				console.warn(`[cache] Invalidation error for ${table_name}:`, err);
			}
		},

		// ---------------------------------------------------------------------------
		// Admin: Get cache status snapshot
		// ---------------------------------------------------------------------------

		/**
		 * Snapshot of the entire SQL cache: total count, tracked tables, and per-table stats.
		 */
		async get_status(): Promise<{ enabled: boolean; total_cache_keys: number; total_dep_keys: number; tables: Array<{ name: string; cache_key_count: number; }>; } | null> {
			if (!CACHE_ENABLED) {
				return { enabled: false, total_cache_keys: 0, total_dep_keys: 0, tables: [] };
			}

			try {
				const [cache_keys, dep_keys] = await Promise.all([scan_all_keys(redis_client, "sql:cache:*"), scan_all_keys(redis_client, "sql:deps:*")]);
				const tables: { name: string; cache_key_count: number; cache_keys: string[]; }[] = [];

				if (dep_keys.length > 0) {
					const [counts, members] = await Promise.all([
						Promise.all(dep_keys.map((k) => redis_client.scard(k))),
						Promise.all(dep_keys.map((k) => redis_client.smembers(k))),
					]);
					for (let i = 0; i < dep_keys.length; i++) {
						const name = dep_keys[i].replace("sql:deps:", "");
						tables.push({
							name,
							cache_key_count: (counts[i] as number) || 0,
							cache_keys: (members[i] as string[]) || [],
						});
					}
					tables.sort((a, b) => b.cache_key_count - a.cache_key_count);
				}

				return {
					enabled: true,
					total_cache_keys: (cache_keys as string[]).length,
					total_dep_keys: dep_keys.length,
					tables,
				};
			} catch (err) {
				console.warn("[cache] Error getting status:", err);
				return { enabled: true, total_cache_keys: 0, total_dep_keys: 0, tables: [] };
			}
		},

		// ---------------------------------------------------------------------------
		// Admin: Invalidate all cached entries
		// ---------------------------------------------------------------------------

		/**
		 * Invalidates ALL cached search results across all tables.
		 * Deletes every `sql:cache:*` and `sql:deps:*` key from Redis.
		 * Returns the count of deleted keys.
		 */
		async invalidate_all(): Promise<{ deleted: number; }> {
			if (!CACHE_ENABLED) return { deleted: 0 };

			try {
				const all_keys = await scan_all_keys(redis_client, "sql:*");
				if (all_keys.length === 0) return { deleted: 0 };

				const deleted = await redis_client.del(...all_keys);
				return { deleted };
			} catch (err) {
				console.warn("[cache] Error invalidating all:", err);
				throw err;
			}
		},

		// ---------------------------------------------------------------------------
		// Check if caching is enabled (for the admin UI)
		// ---------------------------------------------------------------------------

		is_enabled(): boolean { return CACHE_ENABLED; },
	};
}

// ---------------------------------------------------------------------------
// Default export - production instance backed by Bun's built-in Redis client
// ---------------------------------------------------------------------------

export const cache = create_cache(default_redis);
