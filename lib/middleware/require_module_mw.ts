import { default_language } from "$config/supported_languages";
import { localized_url } from "$lib/route";
import { has_module, resolve_session } from "$root/routes/system/auth/middleware";
import type { BunRequest } from "bun";

import type { Middleware } from "./types";

function detect_lang(req: BunRequest): string {
	const from_header = req.headers.get("X-Lang");
	if (from_header) return from_header;

	const cookie_lang = parse_cookie_lang(req);
	if (cookie_lang) return cookie_lang;

	return default_language;
}

/**
 * Middleware that requires an authenticated session.
 * Redirects to localized /login if no valid session exists.
 */
export function require_auth_mw(): Middleware {
	return async (req, next) => {
		const session = await resolve_session(req);
		if (!session.current_user) {
			const lang = detect_lang(req);
			const redirect_to = encodeURIComponent(req.url);
			return Response.redirect(`${localized_url("/login", lang)}?redirect=${redirect_to}`, 303);
		}
		// Re-set X-Lang-Preferred so downstream render() can use it
		const cookie_lang = parse_cookie_lang(req);
		if (cookie_lang) { req.headers.set("X-Lang-Preferred", cookie_lang); }
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
			const lang = detect_lang(req);
			const redirect_to = encodeURIComponent(req.url);
			return Response.redirect(`${localized_url("/login", lang)}?redirect=${redirect_to}`, 303);
		}

		if (!has_module(session.current_user.modules_tags, module_code)) { return new Response("Forbidden", { status: 403 }); }

		// Re-set X-Lang-Preferred so downstream render() can use it
		const cookie_lang = parse_cookie_lang(req);
		if (cookie_lang) { req.headers.set("X-Lang-Preferred", cookie_lang); }

		return next(req);
	};
}

/**
 * Parse the lang cookie from a request header.
 */
function parse_cookie_lang(req: BunRequest): string | null {
	const cookie_header = req.headers.get("cookie") ?? "";
	const match = cookie_header.match(/lang=([^;]+)/);
	return match ? decodeURIComponent(match[1]).toLowerCase() : null;
}
