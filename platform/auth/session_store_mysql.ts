/**
 * Session store backed by MySQL via Bun native SQL.
 * All public functions follow a KV contract so the backing store can be
 * swapped to SQLite / Redis / Valkey with zero changes at call-sites.
 */
import { db } from "$config/db";
import { uuid_v7 } from "$lib/uuid";

import type { Session_data, SessionStore } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// ---------------------------------------------------------------------------
// KV abstraction
// ---------------------------------------------------------------------------

async function kv_set(key: string, value: Session_data): Promise<void> {
	const json = JSON.stringify(value);
	await db`
		INSERT INTO sessions (session_code, session_json)
		VALUES (${key}, ${json})
		ON DUPLICATE KEY UPDATE session_json = ${json}
	`;
}

async function kv_get(key: string): Promise<Session_data | null> {
	const [row] = await db`SELECT session_json FROM sessions WHERE session_code = ${key}`;
	return row ? (JSON.parse(row.session_json) as Session_data) : null;
}

async function kv_delete(key: string): Promise<void> { await db`DELETE FROM sessions WHERE session_code = ${key}`; }

async function kv_has(key: string): Promise<boolean> {
	const [row] = await db`SELECT 1 FROM sessions WHERE session_code = ${key}`;
	return !!row;
}

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

async function destroy_user_sessions(user_id: number): Promise<void> {
	await db`DELETE FROM sessions WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(session_json, '$.user_id')) AS UNSIGNED) = ${user_id}`;
}

async function cleanup_expired(): Promise<number> {
	// created_at is epoch-ms stored inside session_json; delete rows older than TTL.
	const cutoff = Temporal.Now.instant().epochMilliseconds - SESSION_TTL_MS;
	const result = await db`DELETE FROM sessions WHERE CAST(JSON_EXTRACT(session_json, '$.created_at') AS UNSIGNED) < ${cutoff}`;
	return Number((result as any)?.affectedRows ?? 0);
}

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

console.log("\u001b[34mUsing Session store MYSQL\u001b[0m");
