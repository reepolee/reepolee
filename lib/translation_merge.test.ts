import { expect, test } from "bun:test";

import { extract_untranslated, sync_target_to_source } from "./translation_merge";

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
