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
