import { expect, test } from "bun:test";

import { extract_untranslated, merge_missing_source_keys, sync_target_to_source } from "./translation_merge";

test("extract_untranslated sends only values marked missing", () => {
	const english = {
		labels: {
			missing: "Missing value",
			intentionally_english: "Serial number",
			translated: "Save",
		},
	};
	const locale = sync_target_to_source(english, {
		labels: {
			missing: "::missing:: Missing value",
			intentionally_english: "Serial number",
			translated: "Shrani",
		},
	}, false);

	expect(extract_untranslated(english, locale)).toEqual({
		labels: { missing: "Missing value" },
	});
});

test("a fresh locale marks every English leaf as missing", () => {
	const english = { actions: { save: "Save", cancel: "Cancel {count}" } };

	expect(sync_target_to_source(english, {}, false)).toEqual({
		actions: { save: "::missing:: Save", cancel: "::missing:: Cancel {count}" },
	});
});

test("sync preserves target-only translations", () => {
	const english = { labels: { title: "Title" } };
	const slovenian = {
		labels: {
			title: "Naslov",
			legacy_label: "Stari naslov",
		},
		legacy_section: { value: "Ohrani" },
	};

	expect(sync_target_to_source(english, slovenian, false)).toEqual(slovenian);
});

test("generator source merge adds keys without overwriting or deleting file-first values", () => {
	const existing = {
		labels: { title: "Team title", custom_label: "Custom label" },
		ui: { custom_hint: "Custom hint" },
	};
	const generated = {
		labels: { title: "Title", school: "School" },
		ui: { title: "Team" },
	};

	expect(merge_missing_source_keys(existing, generated)).toEqual({
		labels: { title: "Team title", custom_label: "Custom label", school: "School" },
		ui: { custom_hint: "Custom hint", title: "Team" },
	});
});
