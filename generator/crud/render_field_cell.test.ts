import { describe, expect, test } from "bun:test";

import { default_field_helper, render_field_cell } from "./render_field_cell";

function typed_field(name: string, type: string, attributes?: Record<string, unknown>) {
	return { name, type, attributes };
}

function text_field(name: string) {
	return { name, type: "text" as const };
}

describe("render_field_cell", () => {
	test("renders the default value expression when no helper is set", () => {
		const cell = render_field_cell(text_field("observed_at"), "record");
		expect(cell).toContain("{= record.observed_at }");
		expect(cell).not.toContain("helper");
	});

	test("wraps the value in the selected helper call when one is set", () => {
		const cell = render_field_cell(text_field("observed_at"), "record", "default", "\t\t\t\t", "columns", "js_datetime_to_locale_string");
		expect(cell).toContain("{~ js_datetime_to_locale_string(record.observed_at) }");
	});

	test("keeps child context classes and record variable for the child grid", () => {
		const cell = render_field_cell(text_field("name"), "child", "child", "\t\t\t\t", "child_columns", "md");
		expect(cell).toContain("class=\"child-field");
		expect(cell).toContain("{~ md(child.name) }");
	});

	test("wraps a currency column in display_currency regardless of column_type casing", () => {
		const upper = render_field_cell({ name: "price", type: "number" as const, attributes: { column_type: "DECIMAL(18,2)" } }, "record");
		expect(upper).toContain("{~ display_currency(record.price) }");
		const mixed = render_field_cell({ name: "price", type: "number" as const, attributes: { column_type: "Decimal(18,2)" } }, "record");
		expect(mixed).toContain("{~ display_currency(record.price) }");
	});
});

describe("default_field_helper", () => {
	test("maps a boolean-prefixed column to yes_no (the generator's default)", () => {
		expect(default_field_helper(typed_field("is_javascript", "yes_no"))).toBe("yes_no");
		expect(default_field_helper(typed_field("has_license", "number"))).toBe("yes_no");
		expect(default_field_helper(typed_field("can_read", "text"))).toBe("yes_no");
	});

	test("maps currency columns to display_currency by their SQL column type", () => {
		expect(default_field_helper(typed_field("price", "number", { column_type: "decimal(18,2)" }))).toBe("display_currency");
		// Dialects pass through the raw SQL type string (SQLite preserves declared
		// casing), so the match must be case-insensitive like column_class().
		expect(default_field_helper(typed_field("price", "number", { column_type: "DECIMAL(18,2)" }))).toBe("display_currency");
		expect(default_field_helper(typed_field("price", "number", { column_type: "Decimal(18,2)" }))).toBe("display_currency");
	});

	test("maps amount and percentage domains to display helpers", () => {
		expect(default_field_helper(typed_field("total_amount", "number", { domain_type: "amount" }))).toBe("display_currency");
		expect(default_field_helper(typed_field("tax_percentage", "number", { domain_type: "percentage" }))).toBe("display_percent");
	});

	test("maps typed fields to their matching helper", () => {
		expect(default_field_helper(typed_field("name", "tags"))).toBe("tags");
		expect(default_field_helper(typed_field("birthday", "datetime"))).toBe("js_datetime_to_locale_string");
		expect(default_field_helper(typed_field("birthday", "timestamp"))).toBe("js_datetime_to_locale_string");
		expect(default_field_helper(typed_field("joined", "date"))).toBe("js_date_to_locale_string");
		expect(default_field_helper(typed_field("photo", "image"))).toBe("image_thumbnail");
		expect(default_field_helper(typed_field("cv", "file"))).toBe("file_link");
		expect(default_field_helper(typed_field("bio", "markdown"))).toBe("md");
	});

	test("returns an empty helper for plain columns", () => {
		expect(default_field_helper(text_field("name"))).toBe("");
		expect(default_field_helper(typed_field("price", "number"))).toBe("");
	});
});
