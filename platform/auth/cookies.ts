/**
 * Cookie utilities for the auth system.
 * Session ID is stored in an HttpOnly, SameSite=Lax cookie.
 */

import { get_session_id_from_request, SESSION_COOKIE_NAME } from "$lib/session";
import { Cookie } from "bun";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days in seconds

export { get_session_id_from_request, SESSION_COOKIE_NAME };

export function should_secure_session_cookie(is_dev = Bun.argv.includes("--dev")): boolean {
	return !is_dev;
}

export function build_session_cookie(session_id: string): Cookie {
	return new Cookie({
		name: SESSION_COOKIE_NAME,
		value: session_id,
		maxAge: COOKIE_MAX_AGE,
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: should_secure_session_cookie(),
	});
}

export function build_clear_cookie(): Cookie {
	return new Cookie({
		name: SESSION_COOKIE_NAME,
		value: "",
		maxAge: 0,
		path: "/",
		httpOnly: true,
		sameSite: "lax",
		secure: should_secure_session_cookie(),
	});
}
