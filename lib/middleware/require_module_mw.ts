import { default_locale } from "$config/supported_locales";
import { canonical_locale } from "$lib/locale";
import { localized_url } from "$lib/route";
import { has_module, resolve_session } from "$root/routes/system/auth/middleware";
import type { BunRequest } from "bun";

import type { Middleware } from "./types";

function detect_locale(req: BunRequest): string {
	const from_header = canonical_locale(req.headers.get("X-Locale"));
	if (from_header) return from_header;

	const cookie_locale = parse_cookie_locale(req);
	if (cookie_locale) return cookie_locale;

	return default_locale;
}

/**
 * Middleware that requires an authenticated session.
 * Redirects to localized /login if no valid session exists.
 */
export function require_auth_mw(): Middleware {
	return async (req, next) => {
		const session = await resolve_session(req);
		if (!session.current_user) {
			const locale = detect_locale(req);
			const redirect_to = encodeURIComponent(req.url);
			return Response.redirect(`${localized_url("/login", locale)}?redirect=${redirect_to}`, 303);
		}
		// Re-set X-Locale-Preferred so downstream render() can use it
		const cookie_locale = parse_cookie_locale(req);
		if (cookie_locale) { req.headers.set("X-Locale-Preferred", cookie_locale); }
		return next(req);
	};
}

/**
 * Middleware that requires the user to have a specific module in their modules field.
 * Modules are comma-separated (e.g. "admin,system").
 * Redirects to localized /login if not authenticated, returns 403 if module missing.
 */
export function require_module_mw(module_code: string): Middleware {
	return async (req, next) => {
		const session = await resolve_session(req);
		if (!session.current_user) {
			const locale = detect_locale(req);
			const redirect_to = encodeURIComponent(req.url);
			return Response.redirect(`${localized_url("/login", locale)}?redirect=${redirect_to}`, 303);
		}

		if (!has_module(session.current_user.modules_tags, module_code)) { return new Response("Forbidden", { status: 403 }); }

		// Re-set X-Locale-Preferred so downstream render() can use it
		const cookie_locale = parse_cookie_locale(req);
		if (cookie_locale) { req.headers.set("X-Locale-Preferred", cookie_locale); }

		return next(req);
	};
}

/**
 * Parse the locale cookie from a request header, canonicalized to BCP 47.
 */
function parse_cookie_locale(req: BunRequest): string | null {
	const cookie_header = req.headers.get("cookie") ?? "";
	const match = cookie_header.match(/(?:^|;\s*)locale=([^;]+)/);
	return match ? canonical_locale(decodeURIComponent(match[1]!)) : null;
}
