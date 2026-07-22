import { redis } from "bun";

// Key schemas:
// flag config:    ff:flag:{name}         (hash: enabled, rollout_pct, description)
// user override:  ff:user:{user_id}:{name} (string: "1" | "0")
// allowlist:      ff:allow:{name}          (set of user_ids)

const FLAG_PREFIX = "ff:flag";
const USER_PREFIX = "ff:user";
const ALLOW_PREFIX = "ff:allow";

// Whether Redis is expected to be available.
const REDIS_AVAILABLE = !!Bun.env.REDIS_URL;

export interface FlagConfig {
	enabled: boolean;
	rollout_pct: number;
	description: string;
}

// Deterministic hash for consistent user bucketing (no random flip-flop)
function bucket_user(user_id: string, flag_name: string): number {
	let hash = 0;
	const str = `${flag_name}:${user_id}`;
	for (let i = 0; i < str.length; i++) {
		hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
	}
	return hash % 100;
}

// Admin: create or update a flag

export async function set_flag(name: string, config: Partial<FlagConfig>): Promise<void> {
	if (!REDIS_AVAILABLE) return;
	const key = `${FLAG_PREFIX}:${name}`;
	const fields: string[] = [];

	if (config.enabled !== undefined) fields.push("enabled", config.enabled ? "1" : "0");
	if (config.rollout_pct !== undefined) fields.push("rollout_pct", String(config.rollout_pct));
	if (config.description !== undefined) fields.push("description", config.description);

	if (fields.length) await redis.hmset(key, fields);
}

// Admin: delete a flag entirely

export async function delete_flag(name: string): Promise<void> {
	if (!REDIS_AVAILABLE) return;
	await Promise.all([redis.del(`${FLAG_PREFIX}:${name}`), redis.del(`${ALLOW_PREFIX}:${name}`)]);
}

// Admin: manage allowlist

export async function add_to_allowlist(flag_name: string, ...user_ids): Promise<void> {
	if (!REDIS_AVAILABLE) return;
	for (const id of user_ids) {
		await redis.sadd(`${ALLOW_PREFIX}:${flag_name}`, id);
	}
}

export async function remove_from_allowlist(flag_name: string, ...user_ids): Promise<void> {
	if (!REDIS_AVAILABLE) return;
	for (const id of user_ids) {
		await redis.srem(`${ALLOW_PREFIX}:${flag_name}`, id);
	}
}

// Admin: per-user override (force on/off regardless of rollout)

export async function set_user_override(flag_name: string, user_id: string, value: boolean, ttl_seconds?: number): Promise<void> {
	if (!REDIS_AVAILABLE) return;
	const key = `${USER_PREFIX}:${user_id}:${flag_name}`;
	await redis.set(key, value ? "1" : "0");
	if (ttl_seconds) await redis.expire(key, ttl_seconds);
}

export async function clear_user_override(flag_name: string, user_id: string): Promise<void> {
	if (!REDIS_AVAILABLE) return;
	await redis.del(`${USER_PREFIX}:${user_id}:${flag_name}`);
}

// Core: evaluate a flag for a user
// Resolution order:
// 1. Per-user override
// 2. Allowlist membership
// 3. Global enabled + rollout %

export async function is_enabled(flag_name: string, user_id: string): Promise<boolean> {
	if (!REDIS_AVAILABLE) return false;
	try {
		const [override_val, config_fields, in_allowlist] = await Promise.all([
			redis.get(`${USER_PREFIX}:${user_id}:${flag_name}`),
			redis.hmget(`${FLAG_PREFIX}:${flag_name}`, ["enabled", "rollout_pct"]),
			redis.sismember(`${ALLOW_PREFIX}:${flag_name}`, user_id),
		]);

		// 1. Hard override
		if (override_val !== null) return override_val === "1";

		// 2. Allowlist
		if (in_allowlist) return true;

		// 3. Global rollout
		const [enabled, rollout_pct] = config_fields ?? [];
		if (!enabled || enabled === "0") return false;

		const pct = Number(rollout_pct ?? 100);
		return bucket_user(user_id, flag_name) < pct;
	} catch {
		return false;
	}
}

// Bulk: evaluate multiple flags at once

export async function get_flags(flag_names: string[], user_id: string): Promise<Record<string, boolean>> {
	if (!REDIS_AVAILABLE) { return Object.fromEntries(flag_names.map((name) => [name, false])); }
	const results = await Promise.all(flag_names.map((name) => is_enabled(name, user_id)));
	return Object.fromEntries(flag_names.map((name, i) => [name, results[i]]));
}

// Admin: list all flags with their config

export async function list_flags(): Promise<Record<string, FlagConfig>> {
	if (!REDIS_AVAILABLE) return {};
	const keys = (await redis.send("KEYS", [`${FLAG_PREFIX}:*`])) as string[];
	if (!keys.length) return {};

	const configs = await Promise.all(keys.map((key) => redis.hmget(key, ["enabled", "rollout_pct", "description"])));

	return Object.fromEntries(keys.map((key, i) => {
		const [enabled, rollout_pct, description] = configs[i] ?? [];
		const name = key.replace(`${FLAG_PREFIX}:`, "");
		return [
			name,
			{
				enabled: enabled === "1",
				rollout_pct: Number(rollout_pct ?? 100),
				description: description ?? "",
			} satisfies FlagConfig,
		];
	}));
}
