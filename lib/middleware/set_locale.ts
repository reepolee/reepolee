import { default_locale } from "$config/supported_locales";
import { match_accept_language } from "$lib/accept_language";
import { get_cookie } from "$lib/cookies";
import { wants_json } from "$lib/wants_json";
import type { BunRequest } from "bun";

import { detect_locale, resolve_localized_path } from "../route_map";
import type { Middleware } from "./types";

const LOCALE_COOKIE_NAME = "locale";
const LOCALE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

// Build Set-Cookie header value for a given locale (lowercase BCP 47 form).
function make_locale_cookie(locale: string, secure: boolean): string {
	const parts = [`${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}`, "Path=/", `Max-Age=${LOCALE_COOKIE_MAX_AGE_S}`, "SameSite=Lax"];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

/**
 * 400 for a JSON request whose locale is missing or not one we serve.
 *
 * The body names the supported locales so a build failure says what to fix
 * rather than leaving the caller to guess.
 */
function locale_required_response(requested: string | null, locales: readonly string[]): Response {
	const detail = requested
		? `Accept-Language "${requested}" matches no supported locale.`
		: "Accept-Language is required on JSON requests.";
	return Response.json(
		{ error: "locale_required", message: detail, supported_locales: locales },
		{ status: 400 },
	);
}

/**
 * Middleware that resolves the request locale and writes it to the `X-Locale`
 * header (the single source downstream code reads). Sets/updates the `locale`
 * cookie on explicit `?locale=xx-yy` switches and localized-path visits, and
 * redirects locale switches to the localized URL.
 *
 * Precedence for page requests: ?locale= query > localized path > cookie >
 * Accept-Language > default_locale. Matching is case-insensitive ("de-at" ==
 * "DE-AT") but every value is normalized to the lowercase BCP 47 form
 * immediately; the header and cookie always carry that lowercase form.
 * Accept-Language is checked only when no cookie, query, or path locale is
 * present (first visit). The derived locale is persisted as a cookie.
 *
 * JSON requests are stricter. With no explicit locale (query, path or cookie)
 * they must carry an `Accept-Language` naming a supported locale, or they get
 * a 400. There is no default-locale fallback: content lives in locale-suffixed
 * tables, so guessing would silently serve the wrong language to a build.
 *
 * An inbound `X-Locale` is never honoured - it is written here and downstream
 * code trusts it as already validated against the allowed locales.
 *
 * @param locales allowed locales in lowercase BCP 47 form (e.g., ['en-us','de-at'])
 */
export function set_locale(locales: readonly string[]): Middleware {
	const allowed = new Set(locales.map((locale) => locale.toLowerCase()));
	const to_canonical = (value: string | null | undefined): string | undefined => value ? (allowed.has(value.toLowerCase()) ? value.toLowerCase() : undefined) : undefined;

	return async (req: BunRequest, next) => {
		const url = new URL(req.url);
		const candidate = to_canonical(url.searchParams.get("locale"));
		const cookie_locale = to_canonical(get_cookie(req, LOCALE_COOKIE_NAME));
		const secure = url.protocol === "https:";

		// Detect locale implied by the URL path (e.g. /o-nas -> sl-si, /users -> en-us)
		// Only for GET/HEAD - non-page requests (POST/PUT/DELETE) use cookie or default
		const detected = req.method === "GET" || req.method === "HEAD" ? detect_locale(url.pathname) : null;
		const path_locale = to_canonical(detected);

		// The user's chosen/explicit locale (from cookie) - for mismatch detection
		if (cookie_locale) { req.headers.set("X-Locale-Preferred", cookie_locale); }

		// JSON clients must state their locale, and it must be one we serve.
		//
		// Content lives in locale-suffixed tables and an unresolved locale reads
		// the base table, so a typo or a missing header would silently ship the
		// wrong language. HTTP treats Accept-Language as a preference that may go
		// unhonoured; for an API that is a silent-corruption path, so an absent or
		// unmatched locale is rejected instead of being resolved to a default.
		//
		// Browsers keep preference semantics: this applies to JSON requests only.
		// path_locale is deliberately excluded here - it is a page-navigation
		// signal (does this URL spell a localized route?) and resolves to the
		// default locale for any untranslated path, which would silently
		// override an explicit Accept-Language on every unaliased API route.
		const is_json_request = wants_json(req);
		if (is_json_request && !candidate && !cookie_locale) {
			const requested = req.headers.get("Accept-Language");
			const matched = match_accept_language(requested, locales);
			if (!matched) {
				return locale_required_response(requested, locales);
			}
			req.headers.set("X-Locale", matched);
			return next(req);
		}

		// Query param overrides everything
		let final_locale: string;
		let from_accept_language = false;
		if (candidate) {
			final_locale = candidate;
		} else if (path_locale) {
			final_locale = path_locale;
		} else if (cookie_locale) {
			final_locale = cookie_locale;
		} else {
			// No cookie, no query, no localized path - try Accept-Language
			// before falling back to default. On first visit this derives the
			// locale from the browser's language preference and persists it.
			const accept_language = req.headers.get("Accept-Language");
			const detected = match_accept_language(accept_language, locales);
			if (detected) {
				final_locale = detected;
				from_accept_language = true;
			} else {
				final_locale = default_locale;
			}
		}

		// --- Inject X-Locale ---
		req.headers.set("X-Locale", final_locale);

		// --- Redirect to localized path on explicit locale switch ---
		if (candidate) {
			const localized = resolve_localized_path(url.pathname, candidate);
			if (localized) {
				url.searchParams.delete("locale");
				const remaining_query = url.searchParams.toString();
				const redirect_url = localized + (remaining_query ? `?${remaining_query}` : "");

				return new Response(null, {
					status: 302,
					headers: { Location: redirect_url, "Set-Cookie": make_locale_cookie(candidate, secure) },
				});
			}
		}

		// Call downstream
		const res = await next(req);

		// Determine whether a cookie should be set (or updated)
		let cookie_to_set: string | undefined;

		if (candidate) {
			// Explicit ?locale=xx-yy - always set cookie
			cookie_to_set = make_locale_cookie(candidate, secure);
		} else if (path_locale && !cookie_locale) {
			// Locale inferred from path and no valid cookie exists yet - persist it
			cookie_to_set = make_locale_cookie(path_locale, secure);
		} else if (path_locale && cookie_locale && cookie_locale !== path_locale) {
			// Locale from path differs from cookie - update cookie to match path
			cookie_to_set = make_locale_cookie(path_locale, secure);
		} else if (from_accept_language && !cookie_locale && final_locale !== default_locale) {
			// Accept-Language derived a non-default locale on first visit - persist it
			cookie_to_set = make_locale_cookie(final_locale, secure);
		} else if (from_accept_language && cookie_locale && cookie_locale !== final_locale) {
			// Accept-Language differs from stale cookie - update cookie
			cookie_to_set = make_locale_cookie(final_locale, secure);
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
