/**
 * Locale editor props and form parsing.
 *
 * Storage is one full row per locale, so a cloned value renders as a normal
 * value - there is no "inheriting" state, no `present` map, and no "use
 * original" checkbox to represent.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "sl-si", "de-at"],
	active_locales: ["en-us", "sl-si", "de-at"],
	default_locale: "en-us",
	locale_names: { "en-us": "EN", "sl-si": "SL", "de-at": "DE" },
	locale_aliases: {},
}));

const {
	build_localization_props,
	localized_input_form_state,
	localized_value_key,
	parse_copy_request,
	parse_generate_request,
	parse_localized_form,
	validate_localized_inputs,
} = await import("./localized_form");

const FIELDS = [
	{ field_name: "name", label: "Name", input_type: "text" },
	{ field_name: "tagline", label: "Tagline", input_type: "text" },
];

describe("build_localization_props", () => {
	test("puts the default locale first regardless of config order", () => {
		const props = build_localization_props({ fields: FIELDS, record: {}, copy_action: "/frameworks/1/copy-locale" });
		expect(props.active_locales[0]).toBe("en-us");
	});

	test("reads the default locale's values from the base record", () => {
		const props = build_localization_props({
			fields: FIELDS,
			record: { name: "Ripoli", tagline: "Zero ceremony" },
			copy_action: "/frameworks/1/copy-locale",
		});
		expect(props.values[localized_value_key("name", "en-us")]).toBe("Ripoli");
	});

	test("reads a non-default locale's values from its own row", () => {
		const props = build_localization_props({
			fields: FIELDS,
			record: { name: "Ripoli", tagline: "Zero ceremony" },
			locale_rows: { "sl-si": { name: "Ripoli SL", tagline: "Brez ceremonij" } },
			copy_action: "/frameworks/1/copy-locale",
		});
		expect(props.values[localized_value_key("tagline", "sl-si")]).toBe("Brez ceremonij");
	});

	test("falls back to the base value when a locale has no row yet", () => {
		const props = build_localization_props({
			fields: FIELDS,
			record: { name: "Ripoli", tagline: "Zero ceremony" },
			copy_action: "/frameworks/1/copy-locale",
		});
		expect(props.values[localized_value_key("name", "de-at")]).toBe("Ripoli");
	});

	test("submitted values win over stored ones, so a failed save re-renders what was typed", () => {
		const props = build_localization_props({
			fields: FIELDS,
			record: { name: "Ripoli" },
			locale_rows: { "sl-si": { name: "Stored" } },
			values: { [localized_value_key("name", "sl-si")]: "Typed" },
			copy_action: "/frameworks/1/copy-locale",
		});
		expect(props.values[localized_value_key("name", "sl-si")]).toBe("Typed");
	});

	test("derives the generate action from the copy action", () => {
		const props = build_localization_props({ fields: FIELDS, record: {}, copy_action: "/frameworks/1/copy-locale" });
		expect(props.generate_action).toBe("/frameworks/1/generate-locale");
	});

	test("maps stale notices for O(1) panel lookup", () => {
		const props = build_localization_props({
			fields: FIELDS,
			record: {},
			notices: [{ field_name: "tagline", locale_code: "sl-si", copied_from_locale: "en-us" }],
			copy_action: "/frameworks/1/copy-locale",
		});
		expect(props.stale["tagline|sl-si"]).toBe("en-us");
	});
});

describe("parse_localized_form", () => {
	test("collects submitted values per locale", () => {
		const params = new URLSearchParams();
		params.set("_lv[name][sl-si]", "Ripoli SL");
		params.set("_lv[tagline][sl-si]", "Brez ceremonij");
		const parsed = parse_localized_form(params, FIELDS);
		expect(parsed["sl-si"]).toEqual({ name: "Ripoli SL", tagline: "Brez ceremonij" });
	});

	test("ignores the default locale - its values are the record's own columns", () => {
		const params = new URLSearchParams();
		params.set("_lv[name][en-us]", "should be ignored");
		expect(parse_localized_form(params, FIELDS)["en-us"]).toBeUndefined();
	});

	test("ignores locales that are not configured", () => {
		const params = new URLSearchParams();
		params.set("_lv[name][fr-fr]", "nope");
		expect(parse_localized_form(params, FIELDS)["fr-fr"]).toBeUndefined();
	});
});

describe("validate_localized_inputs", () => {
	const schema = {
		shape: {
			name: { safeParse: (value: unknown) => (typeof value === "string" && value.length > 2 ? { success: true } : { success: false, error: { issues: [{ message: "too_short" }] } }) },
		},
	};

	test("rejects a translation that breaks the source field's rule", () => {
		const errors = validate_localized_inputs({ "sl-si": { name: "x" } }, schema);
		expect(errors[localized_value_key("name", "sl-si")]).toBe("too_short");
	});

	test("accepts a valid translation", () => {
		expect(validate_localized_inputs({ "sl-si": { name: "Ripoli" } }, schema)).toEqual({});
	});

	test("maps a message through the translations when one exists", () => {
		const errors = validate_localized_inputs({ "sl-si": { name: "x" } }, schema, { too_short: "Prekratko" });
		expect(errors[localized_value_key("name", "sl-si")]).toBe("Prekratko");
	});
});

describe("localized_input_form_state", () => {
	test("keys submitted values for the form", () => {
		const state = localized_input_form_state({ "sl-si": { name: "Ripoli SL" } });
		expect(state[localized_value_key("name", "sl-si")]).toBe("Ripoli SL");
	});
});

describe("parse_copy_request", () => {
	test("parses a whole-locale copy", () => {
		const params = new URLSearchParams();
		params.set("_copy_locale", "sl-si");
		params.set("_copy_from[sl-si]", "en-us");
		expect(parse_copy_request(params)).toEqual({ from_locale: "en-us", to_locale: "sl-si", field_name: null });
	});

	test("parses a single-field copy", () => {
		const params = new URLSearchParams();
		params.set("_copy_field", "tagline|sl-si");
		params.set("_copy_from[sl-si]", "en-us");
		expect(parse_copy_request(params)).toEqual({ from_locale: "en-us", to_locale: "sl-si", field_name: "tagline" });
	});

	test("rejects copying a locale onto itself", () => {
		const params = new URLSearchParams();
		params.set("_copy_locale", "sl-si");
		params.set("_copy_from[sl-si]", "sl-si");
		expect(parse_copy_request(params)).toBeNull();
	});

	test("rejects an unconfigured locale", () => {
		const params = new URLSearchParams();
		params.set("_copy_locale", "fr-fr");
		params.set("_copy_from[fr-fr]", "en-us");
		expect(parse_copy_request(params)).toBeNull();
	});
});

describe("parse_generate_request", () => {
	test("parses a generate request", () => {
		const params = new URLSearchParams();
		params.set("_generate_locale", "sl-si");
		params.set("_copy_from[sl-si]", "en-us");
		expect(parse_generate_request(params)).toEqual({ from_locale: "en-us", to_locale: "sl-si" });
	});

	test("returns null without a target", () => {
		expect(parse_generate_request(new URLSearchParams())).toBeNull();
	});
});
