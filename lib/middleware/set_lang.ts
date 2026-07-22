import { default_language } from "$config/supported_languages";
import { get_cookie } from "$lib/cookies";
import type { BunRequest } from "bun";

import { detect_lang, resolve_localized_path } from "../route_map";
import type { Middleware } from "./types";

const LANG_COOKIE_NAME = "lang";
const LANG_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

// Build Set-Cookie header value for a given language.
function make_lang_cookie(lang: string, secure: boolean): string {
	const parts = [`${LANG_COOKIE_NAME}=${encodeURIComponent(lang)}`, "Path=/", `Max-Age=${LANG_COOKIE_MAX_AGE_S}`, "SameSite=Lax"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * Middleware that resolves the request language and writes it to the `X-Lang`
 * header (the single source downstream code reads). Sets/updates the `lang`
 * cookie on explicit `?lang=xx` switches and localized-path visits, and
 * redirects language switches to the localized URL.
 *
 * Precedence: ?lang= query > localized path > cookie > default_language.
 *
 * @param languages allowed language codes (e.g., ['en','de','sl'])
 */
export function set_lang(languages: readonly string[]): Middleware {
	const allowed = new Set(languages.map((l) => l.toLowerCase()));

	return async (req: BunRequest, next) => {
		const url = new URL(req.url);
		const candidate = url.searchParams.get("lang")?.toLowerCase();
		const cookie_lang = get_cookie(req, LANG_COOKIE_NAME)?.toLowerCase() || undefined;
		const secure = url.protocol === "https:";

		// Detect language implied by the URL path (e.g. /o-nas -> sl, /users -> en)
		// Only for GET/HEAD - non-page requests (POST/PUT/DELETE) use cookie or default
		const path_lang = req.method === "GET" || req.method === "HEAD" ? detect_lang(url.pathname) : null;

		// The user's chosen/explicit language (from cookie) - for mismatch detection
		if (cookie_lang && allowed.has(cookie_lang)) { req.headers.set("X-Lang-Preferred", cookie_lang); }

		// Query param overrides everything
		let final_lang: string;
		if (candidate && allowed.has(candidate)) {
			final_lang = candidate;
		} else if (path_lang && allowed.has(path_lang)) {
			final_lang = path_lang;
		} else if (cookie_lang && allowed.has(cookie_lang)) {
			final_lang = cookie_lang;
		} else {
			final_lang = default_language;
		}

		// --- Inject X-Lang ---
		req.headers.set("X-Lang", final_lang);

		// --- Redirect to localized path on explicit language switch ---
		if (candidate && allowed.has(candidate)) {
			const localized = resolve_localized_path(url.pathname, candidate);
			if (localized) {
				url.searchParams.delete("lang");
				const remaining_query = url.searchParams.toString();
				const redirect_url = localized + (remaining_query ? `?${remaining_query}` : "");

				return new Response(null, {
					status: 302,
					headers: { Location: redirect_url, "Set-Cookie": make_lang_cookie(candidate, secure) },
				});
			}
		}

		// Call downstream
		const res = await next(req);

		// Determine whether a cookie should be set (or updated)
		let cookie_to_set: string | undefined;

		if (candidate && allowed.has(candidate)) {
			// Explicit ?lang=xx - always set cookie
			cookie_to_set = make_lang_cookie(candidate, secure);
		} else if (path_lang && allowed.has(path_lang) && (!cookie_lang || !allowed.has(cookie_lang))) {
			// Language inferred from path and no valid cookie exists yet - persist it
			cookie_to_set = make_lang_cookie(path_lang, secure);
		} else if (path_lang && allowed.has(path_lang) && cookie_lang && allowed.has(cookie_lang) && cookie_lang !== path_lang) {
			// Language from path differs from cookie - update cookie to match path
			cookie_to_set = make_lang_cookie(path_lang, secure);
		}

		if (cookie_to_set) {
			const out_headers = new Headers(res.headers);
			out_headers.append("Set-Cookie", cookie_to_set);
			return new Response(res.body, {
				status: res.status,
				statusText: res.statusText,
				headers: out_headers,
			});
		}

		return res;
	};
}
