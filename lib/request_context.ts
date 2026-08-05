import { get_cookie, get_toast_cookies } from "$lib/cookies";
import { resolve_ui_locale } from "$lib/locale";
import { resolve_locale, route_namespace_from_dir } from "$lib/route";
import { translations } from "$lib/i18n";
import { get_available_prefixes } from "$lib/modules";
import { deep_merge, get_nested } from "$lib/object";
import { resolve_session } from "$root/routes/system/auth/middleware";
import type { BunRequest } from "bun";
export interface Toast {
	key: string;
	type: string;
	message: string;
}

// Translation merge cache - per (ui_locale, dir). Aliased locales share their
// target's cache entries. The whole map is dropped when
// TranslationRepository.version changes (translations.reload()), so stale
// versions never accumulate.
const _merged_translations_cache = new Map<string, Record<string, any>>();
let _merged_cache_version = -1;

function resolve_translations(ui_locale: string, route_dir: string | null): Record<string, any> {
	const _dir = route_dir ?? "";

	if (translations.version !== _merged_cache_version) {
		_merged_translations_cache.clear();
		_merged_cache_version = translations.version;
	}

	const cache_key = `${ui_locale}:${_dir}`;
	const cached = _merged_translations_cache.get(cache_key);
	if (cached) { return cached; }

	const locale_translations = translations.get(ui_locale) || {};
	const root_translations = locale_translations.routes || {};
	const route_translations = get_nested(locale_translations, _dir);

	const ret = deep_merge(structuredClone(root_translations), route_translations);
	_merged_translations_cache.set(cache_key, ret);

	return ret;
}

export class RequestContext {
	readonly req: BunRequest;
	request_url: string | undefined;
	prefix: string | null = null;

	// Populated by create_ctx(). `locale` is the visitor's full BCP 47 locale
	// (the single localization axis); `ui_locale` is the locale whose UI
	// strings serve this request (alias-resolved, e.g. de-at -> de-de).
	locale: string = "en-us";
	ui_locale: string = "en-us";
	preferred_locale: string | null = null;

	// Populated by create_ctx() from session resolution
	user: Record<string, any> | null = null;

	// Dark mode preference from theme cookie
	dark_mode: boolean = false;

	// CSS class for theme: "dark", "light", or "" (auto-detect via prefers-color-scheme)
	theme_class: string = "";

	// Populated by route handlers via get_toast_cookies()
	toasts: Toast[] = [];

	// Route directory relative to views root (e.g. "examples/kitchen_sink")
	route_dir: string | null = null;

	// Merged translations for this request's lang + route namespace (+ root fallback).
	// Resolved once here, reused by handler logic (ctx.translations.errors, etc.)
	// and by render() to build props.translations for the template.
	translations: Record<string, any> = {};

	constructor(req: BunRequest) { this.req = req; }
}

/**
 * Create a RequestContext from a raw BunRequest, enriched with language,
 * URL prefix, session user, toasts, and other global request metadata.
 * Use this at the top of any route handler to opt into the ctx pattern.
 *
 * Session is resolved here (one DB query per request, cached in ctx.user)
 * so render() and templates can access the current user without additional DB hits.
 * Routes that don't call create_ctx (legacy req-based) still get session from render().
 */
export async function create_ctx(req: BunRequest, meta_dir?: string): Promise<RequestContext> {
	const ctx = new RequestContext(req);
	const url = new URL(req.url);
	ctx.request_url = url.pathname + url.search;

	// Compute route_dir from caller's __dirname if provided
	if (meta_dir) { ctx.route_dir = route_namespace_from_dir(meta_dir); }

	// Detect prefix from URL path
	const pathname = url.pathname;
	for (const p of get_available_prefixes()) {
		if (pathname === `/${p}` || pathname.startsWith(`/${p}/`)) {
			ctx.prefix = p;
			break;
		}
	}

	// Dark mode from theme cookie
	const theme = get_cookie(req, "theme");
	ctx.dark_mode = theme === "dark";
	ctx.theme_class = theme ? (theme === "dark" ? "dark" : "light") : "";

	// Locale: one parser for the whole app (header > cookie > default)
	ctx.locale = resolve_locale(req);
	ctx.ui_locale = resolve_ui_locale(ctx.locale);

	const preferred = req.headers.get("X-Locale-Preferred");
	ctx.preferred_locale = preferred;

	// Resolve session for navbar/user context (one DB query)
	const session = await resolve_session(req);
	ctx.user = session.current_user;

	ctx.toasts = get_toast_cookies(req);

	ctx.translations = resolve_translations(ctx.ui_locale, ctx.route_dir);

	return ctx;
}
