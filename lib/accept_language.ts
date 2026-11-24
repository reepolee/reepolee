/**
 * Accept-Language parsing for the read API.
 *
 * Machine clients (the reeweb SSG) send no cookie and follow no localized
 * path, so `Accept-Language` is the channel they use to ask for a locale.
 * `X-Locale` is deliberately not that channel - it is written by the
 * set_locale middleware and downstream code trusts it as already validated.
 */

interface LanguageRange {
	tag: string;
	quality: number;
}

/**
 * Parse an Accept-Language header into tags ordered by descending quality.
 *
 * Handles the weighted list form ("sl-si,sl;q=0.9,en;q=0.8"). Entries with
 * `q=0` are explicit rejections and are dropped. Malformed weights fall back
 * to 1, matching how browsers treat a missing `q`.
 */
export function parse_accept_language(header: string | null | undefined): string[] {
	if (!header) return [];

	const ranges: LanguageRange[] = [];
	const parts = header.split(",");

	for (const part of parts) {
		const segments = part.trim().split(";");
		const tag = (segments[0] || "").trim();
		if (!tag) continue;

		let quality = 1;
		for (const segment of segments.slice(1)) {
			const [key, value] = segment.split("=");
			if ((key || "").trim().toLowerCase() !== "q") continue;
			const parsed = Number.parseFloat((value || "").trim());
			if (Number.isFinite(parsed)) quality = parsed;
		}

		if (quality <= 0) continue;
		ranges.push({ tag, quality });
	}

	// Stable sort by descending quality - equal weights keep header order,
	// which is the client's own stated preference.
	const sorted = ranges.sort((left, right) => right.quality - left.quality);
	return sorted.map((range) => range.tag);
}

/**
 * Pick the first Accept-Language entry that is an allowed locale.
 *
 * Matching is exact on the full BCP 47 tag, case-insensitively ("sl-si" ==
 * "SL-SI"); the returned locale is always the lowercase canonical form. A
 * bare primary subtag ("sl") is not widened to a regional locale: the locale
 * tables are keyed on full tags, so guessing which region a client meant
 * would silently serve the wrong content. A wildcard ("*") is ignored for the
 * same reason - it states no preference.
 *
 * Returns the lowercase canonical form from `locales`, or undefined when
 * nothing matches.
 */
export function match_accept_language(header: string | null | undefined, locales: readonly string[]): string | undefined {
	const requested = parse_accept_language(header);
	if (requested.length === 0) return undefined;

	const allowed = new Set(locales.map((locale) => locale.toLowerCase()));

	for (const tag of requested) {
		if (tag === "*") continue;
		const lowered = tag.toLowerCase();
		if (allowed.has(lowered)) return lowered;
	}

	return undefined;
}
