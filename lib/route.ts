/**
 * Route utilities - extracted from lib/helpers.ts
 *
 * Functions for route namespace resolution, prefix normalization, and URL
 * localization. Translation lookup lives on `ctx.translations`, resolved by
 * `create_ctx()` in `lib/request_context.ts`.
 */

import { active_languages, default_language, languages } from "$config/supported_languages";
import { get_cookie } from "$lib/cookies";
import type { BunRequest } from "bun";

import { resolve_localized } from "./route_map";

/**
 * Resolve the request language: validated X-Lang header (written by the
 * set_lang middleware) > lang cookie > default_language. The one parser for
 * every consumer - create_ctx, auth redirects, and fallback (unrouted)
 * requests where the middleware did not run.
 */
export function resolve_lang(req: BunRequest): string {
	const header = req.headers.get("X-Lang")?.toLowerCase();
	if (header && active_languages.includes(header as any)) return header;

	const cookie = get_cookie(req, "lang")?.toLowerCase();
	if (cookie && active_languages.includes(cookie as any)) return cookie;

	return default_language;
}

export function get_lang_from_request(req: BunRequest): string | undefined {
	const raw = req.headers.get("x-lang");
	if (!raw) return undefined;

	const normalized = raw.toLowerCase();
	return languages.includes(normalized) ? normalized : default_language;
}

export function route_namespace_from_dir(dir: string): string {
	// Normalize separators - replace double backslashes with forward slashes
	const normalized = dir.replaceAll("\\", "/");

	// Find /routes/ in absolute path
	const idx = normalized.lastIndexOf("/routes/");
	if (idx === -1) {
		// Also accept path ending with /routes (no trailing slash)
		const end_idx = normalized.lastIndexOf("/routes");
		if (end_idx !== -1 && end_idx + "/routes".length === normalized.length) { return ""; }
		throw new Error(`route_namespace_from_dir(): path does not contain "/routes/": ${dir}`);
	}

	// Everything after routes
	const route_segment = "/routes/".length;
	const rel = normalized.substring(idx + route_segment);

	return rel;
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
export function localized_url(path: string, lang: string): string {
	const qs_idx = path.indexOf("?");
	const path_only = qs_idx === -1 ? path : path.slice(0, qs_idx);
	const qs = qs_idx === -1 ? "" : path.slice(qs_idx);

	const localized = resolve_localized(path_only, lang);
	if (localized) { return localized + qs; }

	return path;
}
