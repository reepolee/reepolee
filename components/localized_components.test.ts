import { describe, expect, test } from "bun:test";

import TemplateEngine from "$lib/template_engine";

const engine = new TemplateEngine({ views: process.cwd(), cache: false, ext: ".ree" });

const localization = {
	active_locales: ["en-us", "sl-si", "de-de", "de-at"],
	default_locale: "en-us",
	locale_names: { "en-us": "English", "sl-si": "Slovenščina", "de-de": "Deutsch", "de-at": "Deutsch (AT)" },
	copy_action: "/products/1/copy-locale",
	record: { title: "Original title", price: 12 },
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
		add_language: "Add translation language",
		remove_translation: "Remove translation",
		remove_translation_title: "Remove translation?",
		remove_translation_message: "Remove the translation for",
		open_original: "Open original entries in a new tab",
		translate_all_title: "Translate all localized fields?",
		translate_all_message: "This is the first translation for",
		only_this_field: "Only this field",
		all_fields: "All localized fields",
		source_changed_since_copy: "The original changed since this was copied from",
	},
	actions: { cancel: "Cancel" },
	selectors: { "0": "No", "1": "Yes" },
};

const title_field = { name: "title", label: "Title", type: "text" };

function render(template: string, data: Record<string, any>): Promise<string> {
	return engine.render(template, { translations, attributes: data });
}

describe("localized editor marker", () => {
	test("renders configured locale metadata without a general tab list", async () => {
		const html = await render("components/localized-tabs", { localization });
		expect(html).toContain("data-localized-editor");
		expect(html).toContain('data-default-locale="en-us"');
		expect(html).toContain('data-remove-label="Remove translation"');
		for (const locale of localization.active_locales) {
			expect(html).toContain(`data-localized-locale="${locale}"`);
		}
		expect(html).not.toContain('role="tablist"');
		expect(html).not.toContain("localized-tab");
	});

	test("renders the first-language choice dialog", async () => {
		const html = await render("components/localized-tabs", { localization });
		expect(html).toContain("data-localized-first-language-dialog");
		expect(html).toContain("Translate all localized fields?");
		expect(html).toContain("Only this field");
		expect(html).toContain("All localized fields");
	});

	test("renders the translation-removal confirmation dialog", async () => {
		const html = await render("components/localized-tabs", { localization });
		expect(html).toContain("data-localized-remove-dialog");
		expect(html).toContain("Remove translation?");
		expect(html).toContain("Remove the translation for");
		expect(html).toContain("data-localized-remove-confirm");
	});
});

describe("localized field panel", () => {
	test("binds one translation input to its field and locale", async () => {
		const html = await render("components/localized-panel", { field: title_field, locale: "de-de", localization });
		expect(html).toContain('data-field="title"');
		expect(html).toContain('data-locale="de-de"');
		expect(html).toContain('name="_lv[title][de-de]"');
		expect(html).toContain("Deutscher Titel");
	});

	test("renders an untranslated locale's cloned value as an ordinary editable input", async () => {
		// A locale whose row still holds a clone of the default locale is not a
		// distinct state: the value is real, editable, and rendered normally.
		const html = await render("components/localized-panel", { field: title_field, locale: "de-at", localization });
		expect(html).toContain('value="Original title"');
		expect(html).not.toContain("disabled");
		expect(html).not.toContain("placeholder=");
	});

	test("renders long, Markdown, boolean, and date controls with their source-compatible types", async () => {
		const body = await render("components/localized-panel", { field: { name: "body", type: "textarea" }, locale: "de-de", localization });
		const markdown = await render("components/localized-panel", { field: { name: "notes", type: "markdown" }, locale: "de-de", localization });
		const active = await render("components/localized-panel", { field: { name: "active", type: "boolean" }, locale: "de-de", localization });
		const date = await render("components/localized-panel", { field: { name: "starts_on", type: "date" }, locale: "de-de", localization });
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
		const html = await render("components/localized-panel", { field: title_field, locale: "de-de", localization: flagged });
		expect(html).toContain('id="error-title|de-de"');
		expect(html).toContain("data-localized-stale");
		expect(html).toContain("English");
	});

	test("escapes translated values", async () => {
		const hostile = {
			...localization,
			values: { "title|de-de": '<script>alert("x")</script>' },
		};
		const html = await render("components/localized-panel", { field: title_field, locale: "de-de", localization: hostile });
		expect(html).not.toContain('<script>alert("x")</script>');
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("localized-copy-bar compatibility", () => {
	test("does not render the removed record-wide controls", async () => {
		const html = await render("components/localized-copy-bar", { locale: "de-de", localization });
		expect(html.trim()).toBe("");
	});
});
