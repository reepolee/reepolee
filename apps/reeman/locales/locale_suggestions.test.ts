import { expect, test } from "bun:test";

import { list_locale_suggestions } from "./locale_suggestions";

test("offers EU, Balkan, and archived locales that are not configured", () => {
	const suggestions = list_locale_suggestions(["en-us", "sl-si"], ["is-is", "sl-si"]);
	const codes = suggestions.map((suggestion) => suggestion.code);

	expect(codes).toContain("hr-hr");
	expect(codes).toContain("sq-al");
	expect(codes).toContain("is-is");
	expect(codes).not.toContain("sl-si");
});

test("localizes suggestion names to the display locale, defaulting to English", () => {
	const english = list_locale_suggestions(["en-us", "sl-si"], [], "en").find((s) => s.code === "de-de");
	expect(english?.name).toBe("German (Germany)");

	const slovenian = list_locale_suggestions(["en-us", "sl-si"], [], "sl").find((s) => s.code === "de-de");
	expect(slovenian?.name).not.toBe(english?.name);
	expect(slovenian?.name).not.toBe("de-de");
});
