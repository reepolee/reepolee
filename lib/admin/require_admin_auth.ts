/**
 * Admin authentication helper - extracted from server.ts.
 *
 * Validates the X-Reload-Secret header against RELOAD_SECRET env var.
 * Returns the caller identity string for logging.
 * Returns null if authentication fails (caller should return the Response).
 */

import { timingSafeEqual } from "node:crypto";

const MIN_RELOAD_SECRET_LENGTH = 32;

export interface AuthResult {
	ok: true;
	caller: string;
}

export interface AuthFailure {
	ok: false;
	response: Response;
}

export type AuthOutcome = AuthResult | AuthFailure;

export function internal_admin_endpoints_enabled(): boolean {
	return Bun.env.INTERNAL_ADMIN_ENDPOINTS?.trim().toLowerCase() === "true";
}

function configured_reload_secret(): string | null {
	const reload_secret = Bun.env.RELOAD_SECRET?.trim();
	if (!reload_secret || reload_secret.length < MIN_RELOAD_SECRET_LENGTH) return null;
	return reload_secret;
}

function secrets_match(header_secret: string | null, reload_secret: string): boolean {
	if (!header_secret) return false;
	const expected = Buffer.from(reload_secret);
	const received = Buffer.from(header_secret);
	if (received.length !== expected.length) return false;
	return timingSafeEqual(received, expected);
}

/**
 * Require admin-level authentication via the RELOAD_SECRET header.
 *
 * @param req - The incoming request
 * @param action_name - Name of the action for logging (e.g. "reload", "rate-limit status")
 * @returns AuthResult with caller info, or AuthFailure with a 401 Response
 */
export function require_admin_auth(req: Request, action_name: string): AuthOutcome {
	const url = new URL(req.url);
	const caller = req.headers.get("X-Forwarded-For") || req.headers.get("X-Real-IP") || url.hostname;

	if (!internal_admin_endpoints_enabled()) { return { ok: false, response: new Response("Not Found", { status: 404 }) }; }

	const reload_secret = configured_reload_secret();
	const header_secret = req.headers.get("X-Reload-Secret");
	if (!reload_secret || !secrets_match(header_secret, reload_secret)) {
		console.log(`[${action_name}] Unauthorized attempt from ${caller}`);
		return { ok: false, response: new Response("Unauthorized", { status: 401 }) };
	}

	return { ok: true, caller };
}
