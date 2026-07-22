// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

import { uuid_v7 } from "$lib/uuid";
import { RedisClient } from "bun";

import { destroy_user_sessions_in_redis } from "./session_store_redis_helpers";
import type { Session_data, SessionStore } from "./types";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const SESSION_TTL_S = Math.floor(SESSION_TTL_MS / 1000);
const KEY_PREFIX = "session:";

const REDIS_URL = Bun.env.REDIS_URL;
if (!REDIS_URL) {
	console.error("\u001b[31m[session] REDIS_URL not set - cannot use Redis session store.\u001b[0m");
	console.error("\u001b[31m[session] Set REDIS_URL or change SESSION_STORE to \"sql\".\u001b[0m");
	throw new Error("SESSION_STORE=redis requires REDIS_URL to be set");
}

const redis = new RedisClient(REDIS_URL);

// ---------------------------------------------------------------------------
// KV abstraction
// ---------------------------------------------------------------------------

async function kv_get(key: string): Promise<Session_data | null> {
	const raw = await redis.get(`${KEY_PREFIX}${key}`);
	if (!raw) return null;
	return JSON.parse(raw) as Session_data;
}

async function kv_delete(key: string): Promise<void> { await redis.del(`${KEY_PREFIX}${key}`); }

async function kv_has(key: string): Promise<boolean> {
	const result = await redis.exists(`${KEY_PREFIX}${key}`);
	return result === 1;
}

async function kv_set(key: string, value: Session_data): Promise<void> { await redis.set(`${KEY_PREFIX}${key}`, JSON.stringify(value), "EX", SESSION_TTL_S); }

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function generate_session_id(): string { return uuid_v7(); }

async function create_session(session_id: string, data: Omit<Session_data, "created_at">): Promise<void> {
	await kv_set(session_id, { ...data, created_at: Temporal.Now.instant().epochMilliseconds });
}

async function get_session(session_id: string): Promise<Session_data | null> {
	const session = await kv_get(session_id);
	if (!session) return null;

	if (Temporal.Now.instant().epochMilliseconds - session.created_at > SESSION_TTL_MS) {
		await kv_delete(session_id);
		return null;
	}

	return session;
}

async function destroy_session(session_id: string): Promise<void> { await kv_delete(session_id); }

async function destroy_user_sessions(user_id: number): Promise<void> { await destroy_user_sessions_in_redis(redis, user_id, KEY_PREFIX); }

// Redis expires keys natively via the EX TTL set in kv_set, so there is
// nothing to sweep.
async function cleanup_expired(): Promise<number> { return 0; }

async function refresh_session(session_id: string, partial: Partial<Omit<Session_data, "created_at">>): Promise<void> {
	const existing = await kv_get(session_id);
	if (!existing) return;
	await kv_set(session_id, { ...existing, ...partial });
}

export default {
	kv_get,
	kv_delete,
	kv_has,
	create_session,
	get_session,
	destroy_session,
	destroy_user_sessions,
	refresh_session,
	generate_session_id,
	cleanup_expired,
} satisfies SessionStore;

console.log("\u001b[34mUsing Session store REDIS\u001b[0m");
