import { describe, expect, test } from "bun:test";

import { match_accept_language, parse_accept_language } from "$lib/accept_language";

const ALL = ["en-us", "sl-si", "fr-fr"];

describe("parse_accept_language", () => {
	test("single tag", () => {
		expect(parse_accept_language("sl-si")).toEqual(["sl-si"]);
	});

	test("orders by descending quality", () => {
		const parsed = parse_accept_language("en;q=0.8,sl-si;q=1.0,fr-fr;q=0.9");
		expect(parsed).toEqual(["sl-si", "fr-fr", "en"]);
	});

	test("missing q defaults to 1 and keeps header order", () => {
		const parsed = parse_accept_language("sl-si,fr-fr");
		expect(parsed).toEqual(["sl-si", "fr-fr"]);
	});

	test("drops q=0 rejections", () => {
		const parsed = parse_accept_language("sl-si;q=0,fr-fr;q=0.5");
		expect(parsed).toEqual(["fr-fr"]);
	});

	test("tolerates whitespace", () => {
		const parsed = parse_accept_language(" sl-si ; q=0.9 , fr-fr ");
		expect(parsed).toEqual(["fr-fr", "sl-si"]);
	});

	test("empty and null headers", () => {
		expect(parse_accept_language("")).toEqual([]);
		expect(parse_accept_language(null)).toEqual([]);
		expect(parse_accept_language(undefined)).toEqual([]);
	});
});

describe("match_accept_language", () => {
	test("matches an allowed locale", () => {
		expect(match_accept_language("sl-si", ALL)).toBe("sl-si");
	});

	// Matching is case-insensitive; the returned locale is always lowercase.
	test("matches case-insensitively and returns the lowercase form", () => {
		expect(match_accept_language("SL-si", ALL)).toBe("sl-si");
	});

	test("picks the highest-quality allowed locale", () => {
		expect(match_accept_language("de-de;q=1.0,sl-si;q=0.8", ALL)).toBe("sl-si");
	});

	test("skips unknown tags rather than failing", () => {
		expect(match_accept_language("xx-xx,fr-fr", ALL)).toBe("fr-fr");
	});

	// The locale tables are keyed on full BCP 47 tags, so widening a bare
	// primary subtag would be guessing which region the client meant.
	test("does not widen a bare primary subtag", () => {
		expect(match_accept_language("sl", ALL)).toBeUndefined();
	});

	test("ignores the wildcard", () => {
		expect(match_accept_language("*", ALL)).toBeUndefined();
	});

	test("no match returns undefined", () => {
		expect(match_accept_language("de-de,ja-jp", ALL)).toBeUndefined();
	});

	test("browser-style weighted list", () => {
		const header = "sl-si,sl;q=0.9,en-us;q=0.8,en;q=0.7";
		expect(match_accept_language(header, ALL)).toBe("sl-si");
	});
});
