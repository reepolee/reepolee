/**
 * Naming utilities shared across the generators - pluralization,
 * singularization, and casing. One home instead of copies scattered through
 * ddl_cache.ts, schema/file_writer.ts, and crud/helpers.ts.
 *
 * URL slugs come from `slugify()` in $lib/route_map - the same function the
 * runtime uses to build localized route aliases.
 */

export function capitalize_first(str: string): string { return str.charAt(0).toUpperCase() + str.slice(1); }

export function singularize(word: string): string {
	const lower = word.toLowerCase();

	const irregulars: Record<string, string> = { people: "person", children: "child" };

	if (irregulars[lower]) return irregulars[lower];
	if (lower.endsWith("ies")) return `${word.slice(0, -3)}y`;
	if (lower.endsWith("ves")) return `${word.slice(0, -3)}f`;
	if (lower.match(/(s|x|z|ch|sh)es$/)) return word.slice(0, -2);
	if (lower.endsWith("s") && !lower.endsWith("ss")) return word.slice(0, -1);
	return word;
}

const IRREGULAR_PLURAL: Record<string, string> = {
	person: "people",
	child: "children",
	mouse: "mice",
	foot: "feet",
	tooth: "teeth",
	goose: "geese",
	man: "men",
	woman: "women",
};

export function pluralize_english(word: string): string {
	const lower = word.toLowerCase();
	if (IRREGULAR_PLURAL[lower]) return IRREGULAR_PLURAL[lower];
	if (lower.endsWith("y") && !lower.endsWith("ay") && !lower.endsWith("ey") && !lower.endsWith("oy") && !lower.endsWith("uy")) { return `${word.slice(0, -1)}ies`; }
	// For words ending in 'z': double the z if preceded by a single vowel (e.g. quiz -> quizzes)
	if (lower.endsWith("z")) {
		// Double the z if preceded by a vowel and not already doubled (zz)
		if (!lower.endsWith("zz") && lower.length > 1 && "aeiou".includes(lower[lower.length - 2]!)) { return `${word}zes`; }
		return `${word}es`;
	}

	if (lower.endsWith("s") || lower.endsWith("x") || lower.endsWith("ch") || lower.endsWith("sh")) { return `${word}es`; }
	return `${word}s`;
}

// ---------------------------------------------------------------------------
// Locale-suffixed table naming
//
// A localized table stores the default locale's content in the base table and
// every other locale's content in a suffixed clone: `frameworks` (en-us, the
// default) plus `frameworks_sl_si`. There is no `frameworks_en_us` - the base
// table IS the default locale, which is what keeps a single-locale app
// generating exactly what it generates today.
//
// Names are only ever built here, never parsed back: locale tables are derived
// output, so nothing needs to recover a locale from a table name.
// ---------------------------------------------------------------------------

/** A BCP 47 locale as a table-name segment: "sl-si" -> "sl_si". */
export function locale_table_segment(locale_code: string): string {
	const lowercased = locale_code.toLowerCase();
	return lowercased.replaceAll("-", "_");
}

/**
 * The physical table holding `table_name`'s content for `locale_code`.
 * Returns the base table for the default locale.
 */
export function locale_table_name(table_name: string, locale_code: string, default_locale_code: string): string {
	if (locale_code === default_locale_code) return table_name;
	const segment = locale_table_segment(locale_code);
	return `${table_name}_${segment}`;
}

/**
 * Every physical table holding `table_name`'s content, base first.
 * Used by the write fan-out and by cache invalidation, which must cover every
 * locale: a write always touches the non-localized columns of every clone.
 */
export function locale_table_names(table_name: string, locale_codes: readonly string[], default_locale_code: string): string[] {
	const names = [table_name];
	for (const locale_code of locale_codes) {
		if (locale_code === default_locale_code) continue;
		names.push(locale_table_name(table_name, locale_code, default_locale_code));
	}
	return names;
}

/** Provenance sidecar columns for a localized field (locale tables only). */
export function locale_source_column(field_name: string): string { return `${field_name}_src`; }

export function locale_hash_column(field_name: string): string { return `${field_name}_hash`; }
