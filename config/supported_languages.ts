// Distribution default - packed by reelease in place of supported_languages.ts
// Contains only the base language. Run `bun add:language <code>` to add more.

// all translations
export const languages = ["en"] as const;

// language chooser from this list
export const active_languages = ["en"] as const;

// first served without selection
export const default_language = "en";

export const language_names: Record<string, string> = { en: "English" };

export const language_locales: Record<string, string> = { en: "en-US" };
