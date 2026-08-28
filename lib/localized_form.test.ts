import { describe, expect, mock, test } from "bun:test";

// mock.module is process-global in Bun, so without our own mock this file
// inherits whatever other test files set for $config/supported_locales
// (e.g. helpers.test.ts uses default_locale "sl-si"), which flips which row
// resolve_localized_values treats as the base row. Pin the config here, like
// every other test that depends on it.
mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "sl-si"],
	active_locales: ["en-us", "sl-si"],
	default_locale: "en-us",
	locale_names: { "en-us": "English", "sl-si": "Slovenian" },
	locale_aliases: {},
}));

import { parse_changed_localized_form, resolve_localized_values } from "./localized_form";

describe("resolve_localized_values", () => {
	test("keeps the default locale on the base row when the UI locale is Slovenian", () => {
		const values = resolve_localized_values(
			[{ field_name: "name", label: "Name", input_type: "text" }],
			{ name: "English name" },
			{ "sl-si": { name: "Slovenian name" } },
		);

		expect(values["name|en-us"]).toBe("English name");
		expect(values["name|sl-si"]).toBe("Slovenian name");
	});
});

test("keeps only changed translated fields", () => {
	const params = new URLSearchParams({
		"_lv[name][sl-si]": "Slovensko ime",
		"_original__lv[name][sl-si]": "Slovensko ime",
		"_lv[label][sl-si]": "Spremenjena oznaka",
		"_original__lv[label][sl-si]": "Stara oznaka",
	});

	expect(parse_changed_localized_form(params, [
		{ field_name: "name", label: "Name", input_type: "text" },
		{ field_name: "label", label: "Label", input_type: "text" },
	])).toEqual({ "sl-si": { label: "Spremenjena oznaka" } });
});
