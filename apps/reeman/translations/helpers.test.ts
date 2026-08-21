import { describe, expect, test } from "bun:test";

import { build_translation_breadcrumb_items } from "./helpers";

describe("translation breadcrumb items", () => {
	test("keeps the dropdown's dotted name as the final breadcrumb", () => {
		const items = build_translation_breadcrumb_items("Translations", "/translations", "account", "ui.navigation.header");

		expect(items).toEqual([
			{ label: "Translations", href: "/translations" },
			{ label: "account.ui.navigation.header" },
		]);
	});

	test("uses the namespace as the final breadcrumb for root keys", () => {
		const items = build_translation_breadcrumb_items("Translations", "/translations", "account", "");

		expect(items.at(-1)).toEqual({ label: "account" });
	});
});
