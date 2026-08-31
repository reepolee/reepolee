import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { format_bcp47 } from "$lib/locale";
import TemplateEngine from "$lib/template_engine";
import { DEFAULT_HELPER_NAMES } from "$lib/helper_names";
import { MAIN_APP } from "$config/paths";

// Direct component renders (render("components/X", ...)) resolve names
// relative to views_dir, so this one points at the project root.
const engine = new TemplateEngine({ views: process.cwd(), cache: false, ext: ".ree", helper_names: DEFAULT_HELPER_NAMES });

// Nested custom-element resolution (<localized-field-tabs> including
// <localized-panel>) instead finds components/ under the configured
// project_root - matching lib/template.ts's real engine, whose views_dir is
// the main app tree, nested below the project root.
const nested_engine = new TemplateEngine({ views: join(process.cwd(), MAIN_APP), project_root: process.cwd(), cache: false, ext: ".ree", helper_names: DEFAULT_HELPER_NAMES });
const helpers = { format_bcp47 };

const localization = {
	active_locales: ["en-us", "sl-si", "de-de", "de-at"],
	default_locale: "en-us",
	locale_names: { "en-us": "English", "sl-si": "Slovenščina", "de-de": "Deutsch", "de-at": "Deutsch (AT)" },
	copy_action: "/products/1/copy-locale",
	record: { title: "Original title", price: 12 },
	fields: [{ name: "title", label: "Title", type: "text" }],
	// Every locale holds a real row, so build_localization_props resolves a
	// value for every (field, locale) pair - a locale that has not been
	// translated yet carries a clone of the default locale's value.
	values: {
		"title|de-de": "Deutscher Titel",
		"title|de-at": "Original title",
		"body|de-de": "Deutscher Text",
		"notes|de-de": "Deutsche Notizen",
		"active|de-de": "1",
		"starts_on|de-de": "2026-01-01",
	},
	errors: {},
	stale: {},
};

const translations = {
	localization: {
		reset_to_default: "Reset to default",
		source_changed_since_copy: "The original changed since this was copied from",
	},
	actions: { cancel: "Cancel" },
	selectors: { "0": "No", "1": "Yes" },
};

function render(template: string, data: Record<string, any>): Promise<string> {
	return engine.render(template, { translations, attributes: data, helpers });
}

function render_nested(template: string, data: Record<string, any>): Promise<string> {
	return nested_engine.render_string(template, { ...data, helpers });
}

describe("localized-field-tabs", () => {
	const children = '<field-wrapper data-field="title"><input name="title" /></field-wrapper>';

	test("wraps the default-locale field markup unchanged", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization },
		);
		expect(html).toContain('data-field="title"');
		expect(html).toContain('<input name="title" />');
	});

	test("renders one radio and one label per active locale", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization },
		);
		for (const locale of localization.active_locales) {
			expect(html).toContain(`id="loc-tab-title-${locale}"`);
			expect(html).toContain(`data-locale="${locale}"`);
		}
		expect(html).toContain('name="loc-tab-title"');
	});

	test("shows compact BCP 47 codes and keeps locale names as titles", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization },
		);
		expect(html).toContain('title="English">en-US</label>');
		expect(html).toContain('title="Slovenščina">sl-SI</label>');
		expect(html).toContain('title="Deutsch">de-DE</label>');
	});

	test("checks the default locale's radio when no preferred_locale is set", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization },
		);
		const default_radio = html.match(/<input[^>]*id="loc-tab-title-en-us"[^>]*>/)?.[0] ?? "";
		expect(default_radio).toContain("checked");
	});

	test("checks the preferred locale's radio when it is a configured locale", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization: { ...localization, preferred_locale: "de-de" } },
		);
		const default_radio = html.match(/<input[^>]*id="loc-tab-title-en-us"[^>]*>/)?.[0] ?? "";
		const de_radio = html.match(/<input[^>]*id="loc-tab-title-de-de"[^>]*>/)?.[0] ?? "";
		expect(default_radio).not.toContain("checked");
		expect(de_radio).toContain("checked");
	});

	test("does not render a tabbar when only the default locale is configured", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization: { ...localization, active_locales: ["en-us"] } },
		);
		expect(html).not.toContain("localized-field-tabbar");
		expect(html).not.toContain("localized-tab-radio");
	});

	test("generates a per-locale :has() rule pairing each radio with its panel, no JS required", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization },
		);
		expect(html).toContain(":has(#loc-tab-title-de-de:checked)");
		expect(html).toContain('.localized-tab-panel[data-locale="de-de"]');
	});

	test("renders a zero-JS reset-to-default '×' in the tabbar for each non-default locale", async () => {
		// Lives in the tabbar (fixed position, no layout reflow) rather than
		// inside the panel body, so switching locale tabs never changes field
		// height depending on whether a reset control happens to be present.
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization },
		);
		expect(html).toContain(`formaction="${localization.copy_action}"`);
		expect(html).toContain('name="_copy_field"');
		expect(html).toContain('value="title|de-de"');
		expect(html).toContain('name="_copy_from[de-de]"');
		expect(html).toContain(`value="${localization.default_locale}"`);
		expect(html).toContain("formnovalidate");
		expect(html).not.toContain('value="title|en-us"');
	});

	test("omits the reset control when no copy_action is configured", async () => {
		const html = await render_nested(
			`<localized-field-tabs field="title" localization="{= props.localization }">${children}</localized-field-tabs>`,
			{ localization: { ...localization, copy_action: "" } },
		);
		expect(html).not.toContain("_copy_field");
	});
});

describe("localized-panel", () => {
	test("binds one translation input to its field and locale", async () => {
		const html = await render("components/localized-panel", { "field-name": "title", locale: "de-de", localization });
		expect(html).toContain('data-field="title"');
		expect(html).toContain('data-locale="de-de"');
		expect(html).toContain('name="_lv[title][de-de]"');
		expect(html).toContain("Deutscher Titel");
	});

	test("renders an untranslated locale's cloned value as an ordinary editable input", async () => {
		// A locale whose row still holds a clone of the default locale is not a
		// distinct state: the value is real, editable, and rendered normally.
		const html = await render("components/localized-panel", { "field-name": "title", locale: "de-at", localization });
		expect(html).toContain('value="Original title"');
		expect(html).not.toContain("disabled");
		expect(html).not.toContain("placeholder=");
	});

	test("renders long, Markdown, boolean, and date controls with their source-compatible types", async () => {
		const with_fields = (fields: any[]) => ({ ...localization, fields });
		const body = await render("components/localized-panel", { "field-name": "body", locale: "de-de", localization: with_fields([{ name: "body", type: "textarea" }]) });
		const markdown = await render("components/localized-panel", { "field-name": "notes", locale: "de-de", localization: with_fields([{ name: "notes", type: "markdown" }]) });
		const active = await render("components/localized-panel", { "field-name": "active", locale: "de-de", localization: with_fields([{ name: "active", type: "boolean" }]) });
		const date = await render("components/localized-panel", { "field-name": "starts_on", locale: "de-de", localization: with_fields([{ name: "starts_on", type: "date" }]) });
		expect(body).toContain("<textarea");
		expect(body).toContain("Deutscher Text");
		expect(markdown).toContain("<markdown-editor");
		expect(markdown).toContain("Deutsche Notizen");
		expect(markdown).toContain("data-localized-value");
		expect(active).toContain("<select");
		expect(date).toContain('type="date"');
		expect(date).toContain('value="2026-01-01"');
	});

	test("shows field-local errors and stale-copy notices", async () => {
		const flagged = {
			...localization,
			errors: { "title|de-de": "too_short" },
			stale: { "title|de-de": "en-us" },
		};
		const html = await render("components/localized-panel", { "field-name": "title", locale: "de-de", localization: flagged });
		expect(html).toContain('id="error-title|de-de"');
		expect(html).toContain("data-localized-stale");
		expect(html).toContain("English");
	});

	test("escapes translated values", async () => {
		const hostile = {
			...localization,
			values: { "title|de-de": '<script>alert("x")</script>' },
		};
		const html = await render("components/localized-panel", { "field-name": "title", locale: "de-de", localization: hostile });
		expect(html).not.toContain('<script>alert("x")</script>');
		expect(html).toContain("&lt;script&gt;");
	});
});
