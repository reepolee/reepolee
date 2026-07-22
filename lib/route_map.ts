/**
 * Route Map - O(1) localized <-> canonical URL resolution.
 *
 * On app start, builds two Maps per language from the final assembled route table.
 * All current and future CRUD routes are included automatically.
 *
 * Dynamic segment placeholders (:id, :token) are preserved as-is.
 * Non-translated routes get identity mapping in all languages.
 */

import type { RouteTable } from "./middleware/types";
import { match_pattern } from "./url_pattern";

// Transliterate and normalize to URL-safe ASCII.
export function slugify(text: string): string {
	if (!text) return "";
	return text.normalize("NFKD")
		.toLowerCase()
		.replace(/\p{Diacritic}/gu, "")
		.replace(/ß/g, "ss")
		.replace(/æ/g, "ae")
		.replace(/œ/g, "oe")
		.replace(/[^a-z0-9_]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LangMaps {
	localized_to_canonical: Map<string, string>;
	canonical_to_localized: Map<string, string>;
}

interface RouteMapSet {
	by_lang: Map<string, LangMaps>;
	// All localized pattern keys that contain ":param" placeholders, per language.
	localized_patterns: Map<string, string[]>;
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let current_maps: RouteMapSet | null = null;
let cached_routes: RouteTable | null = null;
let cached_languages: readonly string[] | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function path_matches_pattern(pattern: string, actual: string): boolean { return match_pattern(pattern, actual) !== null; }

// ---------------------------------------------------------------------------
// Build - called at app start with the final assembled route table
// ---------------------------------------------------------------------------

/**
 * Precompute a flat index of all route-name-bearing objects in a translations
 * tree, keyed by their leaf key. This replaces recursive tree-walking with
 * a single O(1) lookup per route segment.
 */
function build_route_name_index(lang_translations: Record<string, any> | undefined): Map<string, Record<string, any>> {
	const index = new Map();

	if (!lang_translations) return index;

	function walk(obj: Record<string, any>) {
		for (const [key, value] of Object.entries(obj)) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			if (typeof value.route_name === "string" && value.route_name) { index.set(key, value); }
			walk(value);
		}
	}
	walk(lang_translations);

	return index;
}

export function build_route_maps(translations: Record<string, any>, routes: RouteTable, languages: readonly string[]): void {
	cached_routes = routes;
	cached_languages = languages;
	const by_lang = new Map();
	const localized_patterns = new Map();

	for (const lang of languages) {
		by_lang.set(lang, { localized_to_canonical: new Map(), canonical_to_localized: new Map() });
		localized_patterns.set(lang, []);
	}

	// Root always maps to itself
	for (const lang of languages) {
		by_lang.get(lang)?.localized_to_canonical.set("/", "/");
		by_lang.get(lang)?.canonical_to_localized.set("/", "/");
	}

	const canonical_paths = Object.keys(routes);

	// Precompile route-name indexes per language - one full tree walk per
	// language instead of a tree walk per route segment.
	const route_name_indexes = new Map();
	for (const lang of languages) {
		route_name_indexes.set(lang, build_route_name_index(translations[lang]));
	}

	for (const canonical_path of canonical_paths) {
		if (canonical_path === "/") continue;

		const segments = canonical_path.split("/").filter(Boolean);

		for (const lang of languages) {
			const maps = by_lang.get(lang)!;
			const lang_translations = translations[lang] as Record<string, any> | undefined;

			if (!lang_translations) {
				maps.localized_to_canonical.set(canonical_path, canonical_path);
				maps.canonical_to_localized.set(canonical_path, canonical_path);
				continue;
			}

			const route_name_index = route_name_indexes.get(lang)!;
			let current: Record<string, any> | undefined = lang_translations;
			const localized_segments: string[] = [];

			for (const segment of segments) {
				if (segment.startsWith(":")) {
					localized_segments.push(segment);
					continue;
				}

				let candidate = current?.[segment];
				if (candidate === undefined) { candidate = route_name_index.get(segment); }

				if (candidate && typeof candidate === "object" && typeof candidate.route_name === "string" && candidate.route_name) {
					const alias = slugify(candidate.route_name);
					localized_segments.push(alias);
					current = candidate;
				} else {
					// No translation or empty route_name -> identity
					localized_segments.push(segment);
					current = candidate ?? undefined;
				}
			}

			const localized_path = `/${localized_segments.join("/")}`;

			maps.localized_to_canonical.set(localized_path, canonical_path);
			maps.canonical_to_localized.set(canonical_path, localized_path);

			if (localized_path.includes(":")) { localized_patterns.get(lang)?.push(localized_path); }
		}
	}

	current_maps = { by_lang, localized_patterns };
}

export function get_route_maps(): RouteMapSet {
	if (!current_maps) { throw new Error("Route maps not built yet. Call build_route_maps() first."); }
	return current_maps;
}

export function reload_route_maps(translations: Record<string, any>, routes?: RouteTable, languages?: readonly string[]): void {
	build_route_maps(translations, routes ?? cached_routes!, languages ?? cached_languages!);
}

// ---------------------------------------------------------------------------
// O(1) lookups
// ---------------------------------------------------------------------------

/**
 * Given a localized URL path, return the canonical route pattern.
 *
 * Handles both exact matches (static routes) and pattern matches
 * (routes with dynamic segments like /some/path/123 -> :id).
 */
export function resolve_canonical(localized_path: string, lang: string): string | null {
	if (!current_maps) return null;

	const maps = current_maps.by_lang.get(lang);
	if (!maps) return null;

	// 1. Exact match
	const exact = maps.localized_to_canonical.get(localized_path);
	if (exact) return exact;

	// 2. Pattern match (for paths with actual dynamic segment values)
	const patterns = current_maps.localized_patterns.get(lang);
	if (patterns) {
		for (const pattern of patterns) {
			if (path_matches_pattern(pattern, localized_path)) { return maps.localized_to_canonical.get(pattern) ?? null; }
		}
	}

	// 3. Try to match against canonical patterns (the path might be canonical
	// but with actual values instead of :param placeholders)
	// Only when lang is the canonical language (default_language)
	for (const [pattern, _localized] of maps.canonical_to_localized) {
		if (!pattern.includes(":")) continue;
		if (match_pattern(pattern, localized_path)) return pattern;
	}

	return null;
}

/**
 * Given a canonical route path, return the localized version for the given language.
 *
 * Handles both cases:
 * 1. Exact canonical pattern match:  /register/:username/:invitation_code  -> /registracija/:username/:invitation_code
 * 2. Actual param values:  /register/ales/uuid  -> /registracija/ales/uuid
 *
 * Falls back to returning the original path if no mapping found.
 */
export function resolve_localized(canonical_path: string, lang: string): string | null {
	if (!current_maps) return null;

	const maps = current_maps.by_lang.get(lang);
	if (!maps) return null;

	// 1. Exact match (canonical pattern key)
	const exact = maps.canonical_to_localized.get(canonical_path);
	if (exact) return exact;

	// 2. Pattern match: path may have actual values instead of :param placeholders
	for (const [pattern, localized_pattern] of maps.canonical_to_localized) {
		if (!pattern.includes(":")) continue;

		const params = match_pattern(pattern, canonical_path);
		if (params) {
			// Replace :param placeholders in localized pattern with actual values
			const localized_parts = localized_pattern.split("/").filter(Boolean);
			const result_parts = localized_parts.map((part) => {
				if (part.startsWith(":")) {
					const param_name = part.slice(1);
					return params[param_name] ?? part;
				}
				return part;
			});
			return `/${result_parts.join("/")}`;
		}
	}

	return null;
}

/**
 * Resolve a (potentially localized) path to its equivalent in the target language.
 *
 * 1. If the path is canonical -> look up localized in target language.
 * 2. If the path is localized in some language -> find canonical, then localize.
 * 3. If not found in any map -> null (non-localized or dynamic-param path).
 */
export function resolve_localized_path(current_path: string, target_lang: string): string | null {
	// 1. Try direct: current_path may be canonical
	const direct = resolve_localized(current_path, target_lang);
	if (direct) return direct;

	// 2. Try all languages: current_path may be localized in some other language
	const maps = get_route_maps();
	for (const [, lang_maps] of maps.by_lang) {
		const canonical = lang_maps.localized_to_canonical.get(current_path);
		if (canonical) {
			const target_localized = resolve_localized(canonical, target_lang);
			if (target_localized) return target_localized;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

/**
 * Detect which language a URL path belongs to by matching against each
 * language's localized route keys.
 *
 * Returns the language code if the path is uniquely identifiable, or null
 * if the path is the same in all languages (not localized).
 */
export function detect_lang(localized_path: string): string | null {
	if (!current_maps) return null;

	let matched_lang: string | null = null;
	let match_count = 0;

	for (const [lang, maps] of current_maps.by_lang) {
		if (maps.localized_to_canonical.has(localized_path)) {
			matched_lang = lang;
			match_count++;
			continue;
		}

		// Pattern match
		const patterns = current_maps.localized_patterns.get(lang);
		if (patterns) {
			for (const pattern of patterns) {
				if (path_matches_pattern(pattern, localized_path)) {
					matched_lang = lang;
					match_count++;
					break;
				}
			}
		}
	}

	// No match, or matches in ALL languages (non-localized path) -> null
	if (match_count === 0 || match_count === current_maps.by_lang.size) { return null; }

	return matched_lang;
}

// ---------------------------------------------------------------------------
// Expand route aliases using the pre-built maps
// ---------------------------------------------------------------------------

import type { RouteHandler } from "./middleware/types";

/**
 * Expand a route table with language-specific aliases using the O(1)
 * canonical_to_localized maps. Requires build_route_maps() to have run.
 */
export function expand_route_aliases_from_maps(routes: RouteTable, languages: readonly string[]): RouteTable {
	const expanded: Record<string, RouteHandler> = { ...routes };

	for (const [path, handler] of Object.entries(routes)) {
		if (path === "/") continue;

		for (const lang of languages) {
			const localized = resolve_localized(path, lang);
			if (localized && localized !== path && !(localized in expanded)) { expanded[localized] = handler; }
		}
	}

	return expanded;
}
