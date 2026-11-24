// Supported locales
//
// A locale is a full lowercase BCP 47 language-region identifier ("en-us",
// "sl-si", "de-at"). Lowercase is the canonical application identity: it is
// used in config, variables, DB keys, filenames and URLs. Conventional
// casing ("en-US") is applied only at presentation boundaries via
// lib/locale.ts format_bcp47(). It is the single localization axis: one
// locale is one complete visitor experience (UI strings, content, prices).
//
// {locale}.json files or optional locales/{locale}.json directories are the source of truth for UI strings.
// Run:
// bun reeman sync-translations
// to sync missing keys across all unaliased locales via AI.

export const locales = [
	"en-us",
	"sl-si",
] as const;

// locale chooser from this list
export const active_locales = [
	"en-us"
] as const;

// first served without selection; its content lives in the source columns
export const default_locale = "en-us";

export const locale_names: Record<string, string> = {
	"en-us": "English",
	"sl-si": "Slovenščina",
};

// UI-string serving aliases: requests for the key locale render the value
// locale's translations (e.g. { "de-at": "de-de" }). One level only; targets
// must not themselves be aliased. Content values are never aliased - they are
// copied per locale in the CRUD editor.
export const locale_aliases: Record<string, string> = {};
