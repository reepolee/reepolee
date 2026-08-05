// Distribution default - packed by reelease in place of supported_locales.ts
// Contains only the base locale. Run `bun add:locale <code>` to add more.
// Locale codes are lowercase BCP 47 ("en-us"); see supported_locales.ts.

// all locales with translations/content
export const locales = ["en-us"] as const;

// locale chooser from this list
export const active_locales = ["en-us"] as const;

export const default_locale = "en-us";

export const locale_names: Record<string, string> = { "en-us": "EN" };

// UI-string serving aliases: requests for the key locale render the value
// locale's translations (e.g. { "de-at": "de-de" }).
export const locale_aliases: Record<string, string> = {};
