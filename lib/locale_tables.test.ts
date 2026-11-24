/**
 * Runtime locale-table resolution.
 *
 * The config is mocked so these stay independent of the repo's actual
 * supported_locales.ts, which changes as locales are added and removed.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "sl-si", "de-at", "nl-nl"],
	default_locale: "en-us",
	active_locales: ["en-us", "sl-si", "de-at"],
	locale_names: {},
	locale_aliases: {},
}));

const { all_locale_tables, clone_locales, is_default_locale, locale_table } = await import("./locale_tables");

describe("locale_table", () => {
	test("resolves the default locale to the base table", () => {
		expect(locale_table("frameworks", "en-us")).toBe("frameworks");
	});

	test("suffixes a configured non-default locale", () => {
		expect(locale_table("frameworks", "sl-si")).toBe("frameworks_sl_si");
		expect(locale_table("frameworks", "de-at")).toBe("frameworks_de_at");
	});

	test("falls back to the base table for an empty locale", () => {
		expect(locale_table("frameworks", "")).toBe("frameworks");
	});

	test("falls back to the base table for an unconfigured locale", () => {
		// ctx.locale comes from a header or cookie, so it must never be able to
		// name a table that does not exist.
		expect(locale_table("frameworks", "fr-fr")).toBe("frameworks");
		expect(locale_table("frameworks", "'; DROP TABLE frameworks; --")).toBe("frameworks");
	});

	test("resolves an inactive preparation locale to its clone table", () => {
		expect(locale_table("frameworks", "nl-nl")).toBe("frameworks_nl_nl");
	});
});

describe("all_locale_tables", () => {
	test("lists the base table first, then one per non-default locale", () => {
		expect(all_locale_tables("frameworks")).toEqual(["frameworks", "frameworks_sl_si", "frameworks_de_at", "frameworks_nl_nl"]);
	});

	test("never includes a clone for the default locale", () => {
		expect(all_locale_tables("frameworks")).not.toContain("frameworks_en_us");
	});

	test("includes clones for inactive preparation locales", () => {
		expect(all_locale_tables("frameworks")).toContain("frameworks_nl_nl");
	});
});

describe("clone_locales", () => {
	test("excludes the default locale", () => {
		expect(clone_locales()).toEqual(["sl-si", "de-at", "nl-nl"]);
	});
});

describe("is_default_locale", () => {
	test("treats empty as the default", () => {
		expect(is_default_locale("")).toBe(true);
		expect(is_default_locale("en-us")).toBe(true);
		expect(is_default_locale("sl-si")).toBe(false);
	});
});
