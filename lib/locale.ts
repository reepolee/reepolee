/**
 * Locale helpers - the one place that understands the shape of a locale code.
 *
 * Canonical storage/config form is lowercase BCP 47 ("en-us", "de-at").
 * URLs, filenames, DB keys, cookies and comparisons all use this form.
 * Every incoming locale is normalized to lowercase immediately via
 * normalize_locale() (Intl.getCanonicalLocales + toLowerCase).
 * Conventional presentation casing ("en-US") is applied only at output
 * boundaries via format_bcp47().
 *
 * The config is validated at first import and fails loudly on any
 * malformed locale, unknown alias, alias chain, or aliased default.
 */

import { active_locales, default_locale, locale_aliases, locales } from "$config/supported_locales";

/**
 * Validate a BCP 47 tag and return its canonical lowercase form.
 *
 * Structural validation is delegated to Intl: invalid tags throw a
 * RangeError. Intl also canonicalizes deprecated aliases and normalizes
 * casing; we then lowercase the result so the application identity is
 * always all-lowercase:
 *   "EN-us"       -> "en-us"
 *   "iw-IL"       -> "he-il"
 *   "zh-Hant-TW"  -> "zh-hant-tw"
 *   "es-419"      -> "es-419"
 */
export function normalize_locale(value: string): string {
	const canonical_locales = Intl.getCanonicalLocales(value);
	const canonical_locale = canonical_locales[0];

	if (!canonical_locale) {
		throw new Error(`Invalid locale: "${value}"`);
	}

	return canonical_locale.toLowerCase();
}

/**
 * Conventional presentation casing ("en-us" -> "en-US"). Use only at
 * presentation boundaries (e.g. <html lang>, hreflang, og:locale) where
 * conventional casing is desired; the application identity stays lowercase.
 */
export function format_bcp47(locale: string): string {
	return Intl.getCanonicalLocales(locale)[0]!;
}

/** Open Graph locale form ("en-us" -> "en_US"). */
export function format_og_locale(locale: string): string {
	return format_bcp47(locale).replace("-", "_");
}

/**
 * Compact uppercase language code for tight UI ("en-us" -> "EN",
 * "de-at" -> "DE", "fil-ph" -> "FIL"). Used where full locale names do not
 * fit, e.g. the sidebar locale switcher links. This reads the first subtag
 * so 3-letter language codes are preserved.
 */
export function locale_short_code(locale: string): string {
	return locale.split("-")[0]!.toUpperCase();
}

/**
 * Case-insensitive match of any spelling ("de-at", "DE-AT") against the
 * configured locales. Returns the canonical lowercase form or null.
 *
 * Deliberately Intl-free (hot middleware path): the config is already
 * validated as lowercase BCP 47 at import, so lowercasing + membership is
 * all the normalization this needs.
 */
export function canonical_locale(value: string | null | undefined): string | null {
	if (!value) return null;
	const lowered = value.toLowerCase();
	return (locales as readonly string[]).includes(lowered) ? lowered : null;
}

/**
 * Resolve the locale whose UI strings (co-located JSON files) serve this
 * request. Aliased locales (e.g. de-at -> de-de) share their target's
 * strings; everything else resolves to itself.
 */
export function resolve_ui_locale(locale: string): string {
	return locale_aliases[locale] ?? locale;
}

/** Locales that own translation files (alias targets and unaliased locales). */
export function unaliased_locales(): string[] {
	return (locales as readonly string[]).filter((locale) => !locale_aliases[locale]);
}

function assert_valid_locale_config(): void {
	const all = locales as readonly string[];
	if (all.length === 0) throw new Error("supported_locales: locales must not be empty");
	for (const locale of all) {
		let normalized: string;
		try {
			normalized = normalize_locale(locale);
		} catch {
			throw new Error(`supported_locales: "${locale}" is not a valid BCP 47 locale`);
		}
		if (normalized !== locale) {
			throw new Error(`supported_locales: "${locale}" must be the lowercase BCP 47 form (e.g. "en-us", not "${normalized}")`);
		}
	}
	const unique = new Set(all.map((locale) => locale.toLowerCase()));
	if (unique.size !== all.length) throw new Error("supported_locales: duplicate locales (comparison is case-insensitive)");
	for (const locale of active_locales as readonly string[]) {
		if (!all.includes(locale)) throw new Error(`supported_locales: active locale "${locale}" is not in locales`);
	}
	if (!all.includes(default_locale)) throw new Error(`supported_locales: default_locale "${default_locale}" is not in locales`);
	if (locale_aliases[default_locale]) throw new Error(`supported_locales: default_locale "${default_locale}" must not be aliased`);
	for (const [from, to] of Object.entries(locale_aliases)) {
		if (!all.includes(from)) throw new Error(`supported_locales: alias source "${from}" is not in locales`);
		if (!all.includes(to)) throw new Error(`supported_locales: alias target "${to}" is not in locales`);
		if (from === to) throw new Error(`supported_locales: alias "${from}" points at itself`);
		if (locale_aliases[to]) throw new Error(`supported_locales: alias chain "${from}" -> "${to}" -> "${locale_aliases[to]}" (targets must be unaliased)`);
	}
}

assert_valid_locale_config();
