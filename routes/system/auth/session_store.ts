import type { SessionStore } from "./types";

const SESSION_STORE = (Bun.env.SESSION_STORE || "sql").toLowerCase();

async function resolve_store(): Promise<SessionStore> {
	// Redis - requires REDIS_URL to be set
	if (SESSION_STORE === "redis") {
		try {
			const mod = await import("./session_store_redis");
			return mod.default;
		} catch (err) {
			console.error("\u001b[31m[session] Failed to load Redis session store - falling back to SQL session store.\u001b[0m", err instanceof Error ? err.message : String(err));
			// Fall through to SQL-based fallback
		}
	}

	// SQL-based - auto-detect MySQL or SQLite from CONNECTION_STRING
	const is_mysql = (Bun.env.CONNECTION_STRING || "").toLowerCase().startsWith("mysql://");
	const mod = is_mysql ? await import("./session_store_mysql") : await import("./session_store_sqlite");
	return mod.default;
}

const store: SessionStore = await resolve_store();

export const { kv_get, kv_delete, kv_has, create_session, get_session, destroy_session, destroy_user_sessions, refresh_session, generate_session_id, cleanup_expired } = store;

export type { Session_data, SessionStore } from "./types";
