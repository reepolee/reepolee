/**
 * Auth middleware helpers.
 *
 * Usage in your router / render wrapper:
 *
 * const session = await resolve_session(req);
 * // Pass session.current_user into every render() call so templates always
 * // have access to the logged-in user (or null).
 *
 * // To protect a route:
 * const guard = require_auth(session, req);
 * if (guard) return guard;   // redirect to /login
 */

import { default_language } from "$config/supported_languages";
import { localized_url, resolve_lang } from "$lib/route";
import type { BunRequest } from "bun";

import { get_session_id_from_request } from "./cookies";
import { get_session, type Session_data } from "./session_store";
import { get_user_by_id, get_user_by_username, to_public_user } from "./sql";
import type { User_public } from "./types";

const IS_AGENT = Bun.argv.includes("--agent");

// ---------------------------------------------------------------------------
// Live-authz cache
//
// resolve_session re-reads the user on every authenticated request so module
// changes / deletions apply without waiting for the 7-day session TTL. That is
// one DB query per request on a hot path, so results are cached in-process for
// a few seconds. In-memory (not Redis) on purpose: a hit costs zero network
// hops - a Redis lookup would just trade the MySQL round-trip for a Redis one -
// and the short TTL keeps revocation effectively immediate. With multiple
// server instances the staleness window is per-instance but bounded by the TTL.
// ---------------------------------------------------------------------------

const AUTHZ_CACHE_TTL_MS = 5_000;

type Authz_entry = { exists: boolean; modules_tags: string; expires_at: number; };

const _authz_cache = new Map<number, Authz_entry>();

/**
 * Live authorization view of a user: whether they still exist and their current
 * modules_tags. Cached in-process for AUTHZ_CACHE_TTL_MS to avoid a DB read on
 * every authenticated request.
 */
async function get_live_authz(user_id: number): Promise<Authz_entry> {
	const now = Date.now();
	const cached = _authz_cache.get(user_id);
	if (cached && cached.expires_at > now) { return cached; }

	const live_user = await get_user_by_id(user_id);
	const entry: Authz_entry = {
		exists: !!live_user,
		modules_tags: live_user?.modules_tags ?? "",
		expires_at: now + AUTHZ_CACHE_TTL_MS,
	};
	_authz_cache.set(user_id, entry);
	return entry;
}

/**
 * Drop a user's cached authorization entry so the next request re-reads the DB.
 * Call after mutating a user's modules_tags (or deleting them) to make the
 * change take effect immediately instead of within the TTL.
 *
 * The cache is per-process, so a write that bypasses this seam is stale for up
 * to AUTHZ_CACHE_TTL_MS per server instance. Current callers are the admin
 * users CRUD (update_record / delete_record in routes/system/users/sql.ts).
 * If you add another write path for a user's modules_tags (or delete a user)
 * anywhere else, call invalidate_authz(id) there too so revocation is immediate.
 */
export function invalidate_authz(user_id: number): void { _authz_cache.delete(user_id); }

// Optional shared secret for agent-mode auth. The agent server already binds
// to 127.0.0.1 only (see start_server) and requires --dev, so the header is
// never reachable off-box; AGENT_SECRET is defense-in-depth for shared local
// machines / misconfigured proxies. When set, the X-Agent-Secret header must
// match before X-Agent-User-Username is honored.
const AGENT_SECRET = Bun.env.AGENT_SECRET;

export interface Auth_context {
	session_id: string | null;
	session: Session_data | null;
	// Convenience object safe to spread into render() data.
	current_user: User_public | null;
}

/**
 * Resolve the session from an incoming request.
 * Always returns an Auth_context - never throws.
 */
export async function resolve_session(req: BunRequest): Promise<Auth_context> {
	// Agent mode: bypass session cookie, use X-Agent-User-Username header or AGENT_USER_USERNAME env var
	if (IS_AGENT) {
		const agent_secret_ok = !AGENT_SECRET || req.headers.get("X-Agent-Secret") === AGENT_SECRET;
		const agent_identity = agent_secret_ok ? (req.headers.get("X-Agent-User-Username") || Bun.env.AGENT_USER_USERNAME) : null;
		if (AGENT_SECRET && !agent_secret_ok && req.headers.get("X-Agent-User-Username")) { console.warn("[agent] Rejected agent auth: missing or invalid X-Agent-Secret"); }
		if (agent_identity) {
			const user_record = await get_user_by_username(agent_identity);
			if (user_record) {
				const current_user = to_public_user(user_record);
				console.log(`[agent] Authenticated as ${agent_identity} (id=${current_user.id})`);
				const fake_session: Session_data = {
					user_id: current_user.id,
					email: current_user.email,
					name: current_user.name,
					nickname: current_user.nickname,
					username: current_user.username,
					avatar_filename: current_user.avatar_filename,
					display_name: current_user.display_name,
					modules_tags: current_user.modules_tags,
					created_at: Date.now(),
				};
				return { session_id: "agent", session: fake_session, current_user };
			}
			console.warn(`[agent] User not found for: ${agent_identity}`);
		}
		// No agent header or unknown user - continues as anonymous
	}

	const session_id = get_session_id_from_request(req);
	if (!session_id) return { session_id: null, session: null, current_user: null };

	const session = await get_session(session_id);
	if (!session) return { session_id, session: null, current_user: null };

	// Re-read the live user so authorization reflects the DB, not the session
	// snapshot: a deleted user invalidates the session, and modules_tags changes
	// (e.g. an admin revoking a module) take effect quickly instead of lingering
	// until the 7-day session TTL expires. Cached in-process for a few seconds.
	const authz = await get_live_authz(session.user_id);
	if (!authz.exists) return { session_id, session: null, current_user: null };

	const current_user: User_public = {
		id: session.user_id,
		email: session.email,
		name: session.name,
		nickname: session.nickname,
		username: session.username ?? "",
		avatar_filename: session.avatar_filename,
		display_name: session.display_name || session.nickname || session.name || session.username || session.email,
		modules_tags: authz.modules_tags,
	};

	// Keep the returned session's authorization field consistent with current_user
	// so any caller reading session.modules_tags sees the live value too.
	const fresh_session: Session_data = { ...session, modules_tags: authz.modules_tags };

	return { session_id, session: fresh_session, current_user };
}

/**
 * Guard helper. Returns a redirect Response if the user is NOT logged in,
 * otherwise returns null (meaning the route may proceed).
 *
 * Usage:
 * const guard = require_auth(auth_ctx, req);
 * if (guard) return guard;
 */
export function require_auth(auth_ctx: Auth_context, req?: BunRequest): Response | null {
	if (auth_ctx.session || auth_ctx.current_user) return null;
	const lang = req ? resolve_lang(req) : default_language;
	let login_url = localized_url("/login", lang);
	if (req) { login_url += `?redirect=${encodeURIComponent(req.url)}`; }
	return Response.redirect(login_url, 303);
}

/**
 * Check whether a comma/whitespace-separated modules_tags string grants the
 * given module. Splits into discrete tags so "admin" does not match
 * "administrator" or "admin_readonly" - a raw substring check would.
 */
export function has_module(modules_tags: string | null | undefined, module_code: string): boolean {
	const tags = (modules_tags || "").split(/[\s,]+/).filter(Boolean);
	return tags.includes(module_code);
}

/**
 * Guard that also checks for a required module (e.g. "admin").
 * Returns a 403 response if the request is anonymous or the user lacks the module.
 *
 * Direct callers must authenticate before calling this helper when they need a
 * login redirect. This helper is still fail-closed for callers that do not use
 * the route middleware.
 */
export function require_module(auth_ctx: Auth_context, module_code: string): Response | null {
	if (!auth_ctx.session && !auth_ctx.current_user) { return new Response("Forbidden", { status: 403 }); }

	if (!has_module(auth_ctx.current_user?.modules_tags, module_code)) { return new Response("Forbidden", { status: 403 }); }
	return null;
}
