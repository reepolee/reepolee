import { expect, test } from "bun:test";

import { sync_target_to_source, type json_obj } from "$lib/translation_merge";

import { insert_missing_translation_rows } from "./translation_sync";

test("CRUD translation seed preserves edited default-locale values", () => {
	const translations: json_obj = {
		ui: { edit_title: "Uredi ekipo" },
	};

	const inserted = insert_missing_translation_rows(translations, [
		{ key_path: "ui.edit_title", value: "Edit Team" },
		{ key_path: "ui.new_title", value: "New Team" },
	]);

	expect(inserted).toBe(1);
	expect(translations).toEqual({
		ui: {
			edit_title: "Uredi ekipo",
			new_title: "New Team",
		},
	});
});

test("CRUD translation seed keeps an existing target-locale translation through structure sync", () => {
	const default_translations: json_obj = {
		ui: {},
	};
	const slovenian_translations: json_obj = {
		ui: { edit_title: "Uredi ekipo" },
	};

	insert_missing_translation_rows(default_translations, [
		{ key_path: "ui.edit_title", value: "Edit Team" },
	]);

	expect(sync_target_to_source(default_translations, slovenian_translations, false)).toEqual(slovenian_translations);
});
