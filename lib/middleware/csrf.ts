/**
 * CSRF Protection Middleware
 *
 * Tokens are HMAC-signed by `Bun.CSRF`, carry their own expiry, and are bound
 * to the requesting browser's identity. The token still travels the same way it
 * always did - a `csrf_token` cookie plus a `_csrf_token` form field or
 * `X-CSRF-Token` header - so forms, templates and the upload endpoints are
 * unchanged. Only the comparison changed.
 *
 * ## What the binding buys
 *
 * The previous scheme put a `uuid_v7()` in a cookie and compared it to the
 * submitted field. That proves the submitter can read the cookie, but the token
 * itself was bound to nothing: a token lifted from one user validated for any
 * other. `Bun.CSRF` has no `sessionId` parameter, so the binding is built here
 * by deriving a per-identity secret (`<server secret>:<identity>`). A token
 * issued for one identity fails `verify()` under another.
 *
 * ## Which identity
 *
 * Logged-in requests bind to the `sid` session cookie. Anonymous ones - login,
 * register, invite, which is exactly where CSRF matters most - have no session
 * yet, so they bind to `csrf_sid`, a dedicated opaque per-browser id issued
 * alongside the token.
 *
 * Verification accepts *either* binding. That is what carries a user across
 * login: the token in their form was issued anonymously against `csrf_sid`, but
 * by the time a later form posts they have a `sid` too, and a session id that
 * rotates on login would otherwise invalidate every open form.
 *
 * ## No legacy fallback
 *
 * There is deliberately no compatibility path for the old unsigned tokens. The
 * only way to accept one is the cookie-equality comparison, and that comparison
 * is transplantable by construction - keeping it would leave the binding above
 * inert. A dual-accept window would be required to upgrade a live deployment
 * without 403ing forms that were already open in a browser; this app has no
 * public users yet, so the window is unnecessary and the weaker path simply
 * does not exist. Anyone holding a pre-upgrade token gets one 403 and a fresh
 * signed token on the next GET.
 */

import { get_cookie } from "$lib/cookies";
import { get_session_id_from_request } from "$lib/session";
import { uuid_v7 } from "$lib/uuid";
import { env_available } from "$config/env_vars";
import type { BunRequest } from "bun";

import type { Middleware } from "./types";

const CSRF_COOKIE_NAME = "csrf_token";
// Opaque per-browser id used as the binding identity for requests with no
// session. HttpOnly - nothing client-side ever needs to read it.
const CSRF_SID_COOKIE_NAME = "csrf_sid";
const CSRF_FIELD_NAME = "_csrf_token";
const CSRF_HEADER_NAME = "X-CSRF-Token";
const CSRF_MAX_AGE_S = 86400; // 24 hours
const CSRF_MAX_AGE_MS = CSRF_MAX_AGE_S * 1000;

// Same floor as RELOAD_SECRET - a short secret defeats the point of signing.
const MIN_CSRF_SECRET_LENGTH = 32;

// Routes that mutate state but are exempt from CSRF validation.
const SKIP_VALIDATION_PATHS = new Set(
	[
		// Validation endpoints - they are POST but only read & validate, never mutate
		"/login/validate",
		"/register/validate",
		"/invite/validate",
		"/profile/validate",
		"/password/validate",
	],
);

// ---------------------------------------------------------------------------
// Server secret
// ---------------------------------------------------------------------------

// Matches the convention in rate_limit.ts - the app's real prod signal is the
// --prod argv flag, not NODE_ENV.
function is_production(): boolean {
	const argv = process.argv;
	return argv.includes("--prod") && !argv.includes("--test") && !argv.includes("--agent");
}

let cached_secret: string | null = null;

/**
 * The stable server-side signing secret.
 *
 * Production requires `CSRF_SECRET` in the environment: it must survive a
 * restart, because a secret regenerated per boot invalidates every in-flight
 * form on every deploy. Development and tests fall back to a per-process
 * random value so a fresh checkout runs with no setup.
 *
 * Call `assert_csrf_secret()` at boot so a misconfigured production server
 * fails to start rather than 403ing every request.
 */
function csrf_secret(): string {
	if (cached_secret !== null) return cached_secret;

	const from_env = env_available("CSRF_SECRET") ? Bun.env.CSRF_SECRET!.trim() : undefined;

	if (from_env) {
		if (from_env.length < MIN_CSRF_SECRET_LENGTH) {
			throw new Error(`CSRF_SECRET must be at least ${MIN_CSRF_SECRET_LENGTH} characters (got ${from_env.length}).`);
		}
		cached_secret = from_env;
		return cached_secret;
	}

	if (is_production()) {
		throw new Error(
			`CSRF_SECRET is required in production and must be at least ${MIN_CSRF_SECRET_LENGTH} characters. `
				+ `Set it in the systemd unit (operations/reepolee.service) before deploying - `
				+ `without it every form submission would fail after the first restart.`,
		);
	}

	cached_secret = `dev-${uuid_v7()}-${uuid_v7()}`;
	// Bun renders console.warn() in red; this is a development warning, so keep
	// it visible without making it look like a failure.
	console.log("\x1b[93m[csrf] CSRF_SECRET is unset - using an ephemeral per-process secret. Tokens will not survive a restart. This is dev/test only.\x1b[0m");
	return cached_secret;
}

/**
 * Resolve the signing secret at boot so production fails fast on a missing
 * `CSRF_SECRET` rather than 403ing every form submission.
 */
export function assert_csrf_secret(): void { csrf_secret(); }

// ---------------------------------------------------------------------------
// Binding identities
// ---------------------------------------------------------------------------

// Namespaced so a session id can never collide with a csrf_sid value.
function derive_secret(identity: string): string { return `${csrf_secret()}:${identity}`; }

/**
 * Every identity a token from this request may legitimately be bound to, most
 * specific first. Both are accepted on verify so that a session id rotating at
 * login does not invalidate forms rendered moments earlier.
 */
function binding_identities(req: BunRequest): string[] {
	const identities: string[] = [];

	const sid = get_session_id_from_request(req);
	if (sid) identities.push(`sid:${sid}`);

	const anon = get_cookie(req, CSRF_SID_COOKIE_NAME);
	if (anon) identities.push(`anon:${anon}`);

	return identities;
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/**
 * Extract CSRF token from the request body (form-encoded, multipart, or JSON).
 * Also checks the X-CSRF-Token header for AJAX requests.
 */
export async function extract_csrf_token(req: BunRequest): Promise<string | null> {
	// 1. Check header (used by AJAX/fetch requests)
	const header_token = req.headers.get(CSRF_HEADER_NAME);
	if (header_token) return header_token;

	const content_type = req.headers.get("content-type") || "";

	// 2. Try formData (handles both url-encoded and multipart)
	if (content_type.includes("application/x-www-form-urlencoded") || content_type.includes("multipart/form-data")) {
		try {
			const cloned = req.clone();
			const fd = await cloned.formData();
			const form_token = fd.get(CSRF_FIELD_NAME);
			if (typeof form_token === "string" && form_token) { return form_token; }
		} catch {
			// fall through to other methods
		}
	}

	// 3. Try JSON body (for AJAX requests that didn't use the header)
	if (content_type.includes("application/json")) {
		try {
			const cloned = req.clone();
			const body = (await cloned.json()) as Record<string, unknown>;
			const json_token = body?.[CSRF_FIELD_NAME];
			if (typeof json_token === "string" && json_token) { return json_token; }
		} catch {
			return null;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Validate a submitted token against the request: does it carry a valid
 * signature for one of this request's binding identities?
 *
 * `Bun.CSRF.verify` throws on a non-string or empty token rather than returning
 * false, so every call is guarded.
 */
export function verify_csrf_token(req: BunRequest, submitted: string | null): boolean {
	if (!submitted) return false;

	for (const identity of binding_identities(req)) {
		try {
			if (Bun.CSRF.verify(submitted, { secret: derive_secret(identity), maxAge: CSRF_MAX_AGE_MS })) { return true; }
		} catch {
			// Malformed token for this identity - try the next one.
		}
	}

	return false;
}

/**
 * Validate the CSRF token for a state-changing request. Returns a 403 Response
 * on failure, or null when valid.
 *
 * Used directly by the upload endpoints, which are wired at the fetch-handler
 * level and never pass through `csrf_mw`. They share this implementation so the
 * two paths cannot drift apart.
 */
export async function require_valid_csrf(req: BunRequest): Promise<Response | null> {
	// With no identity to bind against there is nothing a token could verify
	// under, so the request is rejected before the body is even read.
	if (!binding_identities(req).length) {
		return Response.json({ error: "Missing CSRF token cookie." }, { status: 403 });
	}

	const submitted = await extract_csrf_token(req);
	if (!verify_csrf_token(req, submitted)) {
		return Response.json({ error: "Invalid CSRF token." }, { status: 403 });
	}

	return null;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Build a Set-Cookie header value for the CSRF token.
 */
function make_csrf_cookie(token: string, secure: boolean): string {
	const parts = [`${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`, "Path=/", `Max-Age=${CSRF_MAX_AGE_S}`, "SameSite=Strict"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * Build a Set-Cookie header value for the anonymous binding id. HttpOnly - only
 * the server derives secrets from it.
 */
function make_csrf_sid_cookie(id: string, secure: boolean): string {
	const parts = [`${CSRF_SID_COOKIE_NAME}=${encodeURIComponent(id)}`, "Path=/", `Max-Age=${CSRF_MAX_AGE_S}`, "SameSite=Strict", "HttpOnly"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * Check if a request path should be skipped for CSRF validation.
 */
function should_skip_validation(pathname: string): boolean {
	// Validation endpoints
	if (SKIP_VALIDATION_PATHS.has(pathname)) return true;

	// Static files / API endpoints without state changes
	if (pathname.startsWith("/__")) return true;

	return false;
}

/**
 * Check if the pathname ends with "/validate" (catch-all for generated CRUD).
 */
function is_validate_path(pathname: string): boolean { return pathname.endsWith("/validate"); }

/**
 * CSRF middleware.
 *
 * - Safe methods (GET, HEAD, OPTIONS): Ensures CSRF cookie exists, passes token to templates
 * - State-changing methods (POST, PUT, PATCH, DELETE): Validates token, returns 403 if invalid
 */
export function csrf_mw(additional_skip_paths: string[] = []): Middleware {
	const skip_set = new Set(additional_skip_paths);

	return async (req: BunRequest, next) => {
		const url = new URL(req.url);
		const path = url.pathname;
		const method = req.method.toUpperCase();

		const existing_token = get_cookie(req, CSRF_COOKIE_NAME);
		const secure = url.protocol === "https:";

		// For safe methods: ensure CSRF token exists before handler runs,
		// so handlers always see a valid token via the request header.
		if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
			// The anonymous binding id has to exist before a token can be bound to
			// it, so mint one on the same response when it is missing.
			const existing_anon = get_cookie(req, CSRF_SID_COOKIE_NAME);
			const anon_id = existing_anon || uuid_v7();

			// Reuse a still-valid token; re-issue anything expired, forged or bound
			// to an identity this request no longer has.
			const reusable = !!existing_token && verify_csrf_token(req, existing_token);
			const sid = get_session_id_from_request(req);
			const token = reusable ? existing_token : Bun.CSRF.generate(derive_secret(sid ? `sid:${sid}` : `anon:${anon_id}`), { expiresIn: CSRF_MAX_AGE_MS });

			req.headers.set(CSRF_HEADER_NAME, token);

			const res = await next(req);

			if (reusable && existing_anon) { return res; }

			const out_headers = new Headers(res.headers);
			if (!existing_anon) { out_headers.append("Set-Cookie", make_csrf_sid_cookie(anon_id, secure)); }
			if (!reusable) { out_headers.append("Set-Cookie", make_csrf_cookie(token, secure)); }

			return new Response(res.body, {
				status: res.status,
				statusText: res.statusText,
				headers: out_headers,
			});
		}

		// For state-changing methods (POST, PUT, PATCH, DELETE): validate CSRF
		// Skip validation endpoints
		if (should_skip_validation(path) || is_validate_path(path) || skip_set.has(path)) {
			// Pass through without CSRF validation
			if (existing_token) { req.headers.set(CSRF_HEADER_NAME, existing_token); }
			return next(req);
		}

		// With no identity to bind against there is nothing a token could verify
		// under, so reject before reading the body.
		if (!binding_identities(req).length) {
			return Response.json({ error: "Missing CSRF token cookie." }, { status: 403 });
		}

		const body_token = await extract_csrf_token(req);

		if (!body_token || !verify_csrf_token(req, body_token)) {
			return Response.json({ error: "Invalid CSRF token." }, { status: 403 });
		}

		// Set the token header so downstream code can access it
		req.headers.set(CSRF_HEADER_NAME, body_token);

		return next(req);
	};
}
