import { describe, expect, mock, test } from "bun:test";

mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "sl-si", "de-de", "de-at"],
	active_locales: ["sl-si", "en-us", "de-de", "de-at"],
	default_locale: "en-us",
	locale_names: { "en-us": "English", "sl-si": "Slovenščina", "de-de": "Deutsch", "de-at": "Deutsch (AT)" },
	locale_aliases: { "de-at": "de-de" },
}));

const locale_lib = await import("./locale");

describe("locale helpers", () => {
	test("locale_short_code uppercases the language part", () => {
		expect(locale_lib.locale_short_code("en-us")).toBe("EN");
		expect(locale_lib.locale_short_code("sl-si")).toBe("SL");
		expect(locale_lib.locale_short_code("de-at")).toBe("DE");
		expect(locale_lib.locale_short_code("fil-ph")).toBe("FIL");
	});

	describe("normalize_locale", () => {
		test("lowercases valid BCP 47 tags", () => {
			expect(locale_lib.normalize_locale("en-us")).toBe("en-us");
			expect(locale_lib.normalize_locale("EN-us")).toBe("en-us");
			expect(locale_lib.normalize_locale("DE-AT")).toBe("de-at");
		});

		test("canonicalizes via Intl (deprecated aliases, scripts, numeric regions)", () => {
			expect(locale_lib.normalize_locale("iw-IL")).toBe("he-il");
			expect(locale_lib.normalize_locale("zh-Hant-TW")).toBe("zh-hant-tw");
			expect(locale_lib.normalize_locale("es-419")).toBe("es-419");
		});

		test("throws on invalid tags", () => {
			expect(() => locale_lib.normalize_locale("123")).toThrow();
			expect(() => locale_lib.normalize_locale("en-")).toThrow();
			expect(() => locale_lib.normalize_locale("a b")).toThrow();
			expect(() => locale_lib.normalize_locale("")).toThrow();
		});
	});

	describe("format_bcp47", () => {
		test("restores conventional casing at presentation boundaries", () => {
			expect(locale_lib.format_bcp47("en-us")).toBe("en-US");
			expect(locale_lib.format_bcp47("sl-si")).toBe("sl-SI");
			expect(locale_lib.format_bcp47("de-at")).toBe("de-AT");
		});
	});

	describe("format_og_locale", () => {
		test("uses the underscore form for Open Graph", () => {
			expect(locale_lib.format_og_locale("en-us")).toBe("en_US");
			expect(locale_lib.format_og_locale("sl-si")).toBe("sl_SI");
			expect(locale_lib.format_og_locale("de-at")).toBe("de_AT");
		});
	});

	describe("canonical_locale", () => {
		test("matches lowercase URL form", () => expect(locale_lib.canonical_locale("de-at")).toBe("de-at"));
		test("matches uppercase form", () => expect(locale_lib.canonical_locale("DE-AT")).toBe("de-at"));
		test("matches canonical form", () => expect(locale_lib.canonical_locale("sl-si")).toBe("sl-si"));
		test("unknown locale returns null", () => expect(locale_lib.canonical_locale("fr-fr")).toBeNull());
		test("empty and null return null", () => {
			expect(locale_lib.canonical_locale("")).toBeNull();
			expect(locale_lib.canonical_locale(null)).toBeNull();
			expect(locale_lib.canonical_locale(undefined)).toBeNull();
		});
	});

	describe("resolve_ui_locale", () => {
		test("aliased locale resolves to its target", () => expect(locale_lib.resolve_ui_locale("de-at")).toBe("de-de"));
		test("unaliased locale resolves to itself", () => expect(locale_lib.resolve_ui_locale("sl-si")).toBe("sl-si"));
	});

	test("unaliased_locales excludes alias sources", () => {
		expect(locale_lib.unaliased_locales()).toEqual(["en-us", "sl-si", "de-de"]);
	});
});
