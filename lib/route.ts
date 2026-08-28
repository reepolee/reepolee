/**
 * Route utilities - extracted from lib/helpers.ts
 *
 * Functions for route namespace resolution, prefix normalization, and URL
 * localization. Translation lookup lives on `ctx.translations`, resolved by
 * `create_ctx()` in `lib/request_context.ts`.
 */

import { MAIN_APP_POSIX, PLATFORM_DIR } from "$config/paths";
import { active_locales, default_locale } from "$config/supported_locales";
import { get_cookie } from "$lib/cookies";
import { canonical_locale } from "$lib/locale";
import { resolve_route_module_namespace, resolve_route_module_template_namespace } from "$lib/route_module";
import type { BunRequest } from "bun";

import { resolve_localized } from "./route_map";

/**
 * Resolve the request locale: validated X-Locale header (written by the
 * set_locale middleware) > locale cookie > default_locale. Matching is
 * case-insensitive; the returned value is always canonical BCP 47 ("en-us").
 * The one parser for every consumer - create_ctx, auth redirects, and
 * fallback (unrouted) requests where the middleware did not run.
 */
export function resolve_locale(req: BunRequest): string {
	const header = canonical_locale(req.headers.get("X-Locale"));
	if (header && (active_locales as readonly string[]).includes(header)) return header;

	const cookie = canonical_locale(get_cookie(req, "locale"));
	if (cookie && (active_locales as readonly string[]).includes(cookie)) return cookie;

	return default_locale;
}

export function get_locale_from_request(req: BunRequest): string | undefined {
	const raw = req.headers.get("x-locale");
	if (!raw) return undefined;

	return canonical_locale(raw) ?? default_locale;
}

export function route_namespace_from_dir(dir: string): string {
	// Normalize separators - replace double backslashes with forward slashes
	const normalized = dir.replaceAll("\\", "/");

	// Roots whose subtrees carry plain, views-relative namespaces: the main app
	// and the shared platform tree. `platform/auth/login` is namespace
	// "auth/login" exactly as `<main>/auth/login` would be, which is what lets
	// a shared route render and translate identically from every app.
	for (const root of [MAIN_APP_POSIX, PLATFORM_DIR]) {
		const root_segment = `/${root}`;
		const idx = normalized.lastIndexOf(`${root_segment}/`);
		if (idx !== -1) { return normalized.substring(idx + root_segment.length + 1); }

		// Also accept a path ending at the root itself (no trailing slash)
		const end_idx = normalized.lastIndexOf(root_segment);
		if (end_idx !== -1 && end_idx + root_segment.length === normalized.length) { return ""; }
	}

	const module_namespace = resolve_route_module_namespace(dir);
	if (module_namespace) return module_namespace;

	throw new Error(`route_namespace_from_dir(): path is not under ${MAIN_APP_POSIX}, ${PLATFORM_DIR}, or a mounted route module: ${dir}`);
}

/**
 * Resolve a template path relative to the views root or mounted module root.
 * Mounted app prefixes belong to translations only and must not become part of
 * the TemplateEngine mount key.
 */
export function route_template_namespace_from_dir(dir: string): string {
	const normalized = dir.replaceAll("\\", "/");
	for (const root of [MAIN_APP_POSIX, PLATFORM_DIR]) {
		const root_segment = `/${root}`;
		const idx = normalized.lastIndexOf(`${root_segment}/`);
		if (idx !== -1) return normalized.substring(idx + root_segment.length + 1);
		const end_idx = normalized.lastIndexOf(root_segment);
		if (end_idx !== -1 && end_idx + root_segment.length === normalized.length) return "";
	}

	const module_namespace = resolve_route_module_template_namespace(dir);
	if (module_namespace) return module_namespace;

	throw new Error(`route_template_namespace_from_dir(): path is not under ${MAIN_APP_POSIX}, ${PLATFORM_DIR}, or a mounted route module: ${dir}`);
}

/**
 * Normalize a raw prefix string to clean (no slashes) and route (leading /) forms.
 *
 * Input: any of "admin/", "/admin", "//admin///", "admin"
 * Returns: { clean: "admin", route: "/admin" }
 * Input: ""
 * Returns: { clean: "", route: "" }
 */
export function normalize_prefix(raw: string): { clean: string; route: string; } {
	const clean = raw.trim().replace(/^\/+|\/+$/g, "");
	return { clean, route: clean ? `/${clean}` : "" };
}

/**
 * Localize a canonical URL path (e.g., "/users?offset=10") to the target language's alias.
 * Preserves query strings.
 *
 * O(1) via pre-built route maps.
 */
export function localized_url(path: string, locale: string): string {
	const qs_idx = path.indexOf("?");
	const path_only = qs_idx === -1 ? path : path.slice(0, qs_idx);
	const qs = qs_idx === -1 ? "" : path.slice(qs_idx);

	const localized = resolve_localized(path_only, locale);
	if (localized) { return localized + qs; }

	return path;
}
