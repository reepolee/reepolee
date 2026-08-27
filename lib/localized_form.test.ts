import { describe, expect, test } from "bun:test";

import { resolve_localized_values } from "./localized_form";

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
