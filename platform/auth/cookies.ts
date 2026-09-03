/**
 * Cookie utilities for the auth system.
 * Session ID is stored in an HttpOnly, SameSite=Lax cookie.
 */

import { get_session_id_from_request, SESSION_COOKIE_NAME } from "$lib/session";
import { Cookie } from "bun";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days in seconds

export { get_session_id_from_request, SESSION_COOKIE_NAME };

export function should_secure_session_cookie(req: Request): boolean {
	const trust_proxy = Bun.env.TRUST_PROXY?.trim();
	const trust_cloudflare = trust_proxy?.toLowerCase() === "cloudflare";
	if (trust_cloudflare) {
		const forwarded_proto = req.headers.get("X-Forwarded-Proto");
		const normalized_proto = forwarded_proto?.trim();
		return normalized_proto?.toLowerCase() === "https";
	}
	return new URL(req.url).protocol === "https:";
}

export function build_session_cookie(session_id: string, req: Request): Cookie {
	return new Cookie({
		name: SESSION_COOKIE_NAME,
		value: session_id,
		maxAge: COOKIE_MAX_AGE,
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: should_secure_session_cookie(req),
	});
}

export function build_clear_cookie(req: Request): Cookie {
	return new Cookie({
		name: SESSION_COOKIE_NAME,
		value: "",
		maxAge: 0,
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: should_secure_session_cookie(req),
	});
}
