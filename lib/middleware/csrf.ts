/**
 * CSRF Protection Middleware
 *
 * Uses the Double-Submit Cookie pattern:
 * 1. A random `csrf_token` cookie is set on every response (if missing)
 * 2. Every HTML form includes a hidden `_csrf_token` field with the same value
 * 3. On state-changing requests (POST, PUT, PATCH, DELETE), the middleware
 * compares the token from the request body/header against the cookie
 * 4. Skips validation for GET, HEAD, OPTIONS, and validation endpoints
 *
 * The token is also set as `X-CSRF-Token` request header so render()
 * can inject it into template data.
 */

import { get_cookie } from "$lib/cookies";
import { uuid_v7 } from "$lib/uuid";
import type { BunRequest } from "bun";

import type { Middleware } from "./types";

const CSRF_COOKIE_NAME = "csrf_token";
const CSRF_FIELD_NAME = "_csrf_token";
const CSRF_HEADER_NAME = "X-CSRF-Token";
const CSRF_MAX_AGE_S = 86400; // 24 hours

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

/**
 * Extract CSRF token from the request body (form-encoded, multipart, or JSON).
 * Also checks the X-CSRF-Token header for AJAX requests.
 */
async function extract_csrf_token(req: BunRequest): Promise<string | null> {
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
			const body = await cloned.json();
			const json_token = body?.[CSRF_FIELD_NAME];
			if (typeof json_token === "string" && json_token) { return json_token; }
		} catch {
			return null;
		}
	}

	return null;
}

/**
 * Build a Set-Cookie header value for the CSRF token.
 */
function make_csrf_cookie(token: string, secure: boolean): string {
	const parts = [`${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`, "Path=/", `Max-Age=${CSRF_MAX_AGE_S}`, "SameSite=Strict"];
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
			// Generate a token if one doesn't exist yet - do this BEFORE calling next()
			// so the handler can read it via req.headers.get("X-CSRF-Token").
			const token = existing_token || uuid_v7();
			req.headers.set(CSRF_HEADER_NAME, token);

			const res = await next(req);

			// Only set the cookie on the response if this is a fresh token
			if (!existing_token) {
				const out_headers = new Headers(res.headers);
				out_headers.append("Set-Cookie", make_csrf_cookie(token, secure));
				return new Response(res.body, {
					status: res.status,
					statusText: res.statusText,
					headers: out_headers,
				});
			}

			return res;
		}

		// For state-changing methods (POST, PUT, PATCH, DELETE): validate CSRF
		// Skip validation endpoints
		if (should_skip_validation(path) || is_validate_path(path) || skip_set.has(path)) {
			// Pass through without CSRF validation
			if (existing_token) { req.headers.set(CSRF_HEADER_NAME, existing_token); }
			return next(req);
		}

		if (!existing_token) {
			return Response.json({ error: "Missing CSRF token cookie." }, { status: 403 });
		}

		const body_token = await extract_csrf_token(req);

		if (!body_token || body_token !== existing_token) {
			return Response.json({ error: "Invalid CSRF token." }, { status: 403 });
		}

		// Set the token header so downstream code can access it
		req.headers.set(CSRF_HEADER_NAME, existing_token);

		return next(req);
	};
}
