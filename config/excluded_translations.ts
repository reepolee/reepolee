// Key-path prefixes exempt from the generic translation sync's "untranslated"
// detection (lib/translation_merge.ts's extract_untranslated). These keys hold
// cross-language name data (e.g. the native name of a language, or its name
// translated into another language) that is intentionally identical across
// locales in some cases (a language's own native name) and is instead
// populated by generator/add_locale.ts's dedicated AI calls when a locale is
// added. Without this exclusion, the generic sync pipeline treats an
// identical value as "never translated" and re-sends it to the AI on every
// sync run.
export const excluded_translation_prefixes: string[] = [
	"ui.language_name",
	"ui.language_names",
	"ui.language_names_to",
	"ui.seconds",
	"ui.ttl",
];

export function is_excluded_translation_path(key_path: string): boolean {
	return excluded_translation_prefixes.some((prefix) => key_path === prefix || key_path.startsWith(`${prefix}.`));
}
