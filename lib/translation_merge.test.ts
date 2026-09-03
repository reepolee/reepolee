import { expect, test } from "bun:test";

import { extract_untranslated, sync_lang_to_en } from "./translation_merge";

test("extract_untranslated sends only values marked missing", () => {
	const english = {
		labels: {
			missing: "Missing value",
			intentionally_english: "Serial number",
			translated: "Save",
		},
	};
	const locale = sync_lang_to_en(english, {
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
