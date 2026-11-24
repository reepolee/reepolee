export interface LocaleSuggestion {
	code: string;
	name: string;
}

const eu_and_balkan_locales = ["bg-bg", "bs-ba", "cnr-me", "cs-cz", "da-dk", "de-at", "de-be", "de-de", "el-cy", "el-gr", "en-ie", "et-ee", "fi-fi", "fr-be", "fr-fr", "fr-lu", "ga-ie", "hr-hr", "hu-hu", "it-it", "lb-lu", "lt-lt", "lv-lv", "mk-mk", "mt-mt", "nl-be", "nl-nl", "pl-pl", "pt-pt", "ro-ro", "sk-sk", "sl-si", "sq-al", "sq-xk", "sr-rs", "sv-fi", "sv-se", "tr-tr", "es-es"] as const;

function locale_display_name(code: string, display_locale: string = "en"): string {
	const [language, region] = code.split("-");
	const tag = region ? `${language}-${region.toUpperCase()}` : language!;
	return new Intl.DisplayNames([display_locale], { type: "language" }).of(tag) || code;
}

export function list_locale_suggestions(configured_codes: readonly string[], archived_codes: readonly string[], display_locale: string = "en"): LocaleSuggestion[] {
	const configured = new Set(configured_codes);
	const codes = new Set<string>([...eu_and_balkan_locales, ...archived_codes]);
	const suggestions: LocaleSuggestion[] = [];
	for (const code of codes) {
		if (configured.has(code)) continue;
		suggestions.push({ code, name: locale_display_name(code, display_locale) });
	}
	return suggestions.sort((left, right) => left.name.localeCompare(right.name) || left.code.localeCompare(right.code));
}
