import { describe, expect, test } from "bun:test";

// No mocking needed - format.ts imports only from stdlib
const fmt = await import("./format");

describe("format - display_currency", () => {
	test("formats with EUR symbol", () => {
		const result = fmt.display_currency(1234.5, "sl-SI");
		expect(result).toContain("€");
	});

	test("hides zero when hide_zero is true", () => expect(fmt.display_currency(0, "sl-SI", true)).toBe(""));

	test("shows zero when hide_zero is false", () => expect(fmt.display_currency(0, "sl-SI", false)).not.toBe(""));

	test("defaults undefined val to 0", () => {
		const result = fmt.display_currency(undefined as any);
		expect(result).toContain("0");
	});

	test("uses custom symbol", () => {
		const result = fmt.display_currency(100, "en-US", false, "$");
		expect(result).toContain("$");
	});

	test("formats large numbers with grouping", () => {
		const result = fmt.display_currency(1_000_000, "en-US");
		expect(result).toContain("1,000,000");
	});
});

describe("format - currency_no_cents", () => {
	test("rounds to integer", () => {
		const result = fmt.currency_no_cents(1234.56, "en-US");
		expect(result).toContain("1,235");
	});

	test("hides zero by default", () => expect(fmt.currency_no_cents(0)).toBe(""));

	test("formats with locale grouping", () => {
		const result = fmt.currency_no_cents(1500, "en-US");
		expect(result).toContain("1,500");
	});
});

describe("format - decimal", () => {
	test("formats with default 2 fraction digits", () => {
		const result = fmt.decimal(1234.5, "sl-SI");
		expect(result).toContain("1.234");
	});

	test("hides zero", () => expect(fmt.decimal(0, "sl-SI", true)).toBe(""));

	test("uses custom fraction digits", () => {
		const result = fmt.decimal(1.5, "en-US", false, 4);
		expect(result).toContain("1.5000");
	});
});

describe("format - percent", () => {
	test("formats 25 as 25% (en-US)", () => {
		const result = fmt.percent(25, "en-US");
		expect(result).toContain("25");
		expect(result).toContain("%");
	});

	test("handles undefined as 0%", () => {
		const result = fmt.percent(undefined as any);
		expect(result).toContain("0");
	});
	test("formats decimal percentages", () => {
		const result = fmt.percent(12.5, "en-US");
		// Intl.NumberFormat with percent style rounds to integer by default
		expect(result).toContain("13");
		expect(result).toContain("%");
	});
});

describe("format - display_percent", () => {
	test("formats with locale", () => {
		const result = fmt.display_percent(25.5, "sl-SI");
		expect(result).toContain("%");
	});

	test("handles undefined as 0%", () => {
		const result = fmt.display_percent(undefined as any, "sl-SI");
		expect(result).toContain("0");
	});

	test("shows 0 fraction digits for round numbers", () => {
		const result = fmt.display_percent(50, "en-US");
		expect(result).toBe("50%");
	});

	test("shows up to 2 fraction digits for precise values", () => {
		const result = fmt.display_percent(25.5, "en-US");
		expect(result).toContain("25.5");
	});
});

describe("format - plural", () => {
	test("selects 'one' form for English count 1", () => {
		const key = "0 records|1 record|2 records|3 records|{count} records";
		expect(fmt.plural(key, 1, "en-US")).toBe("1 record");
	});

	test("selects 'other' form for English count > 1", () => {
		const key = "0 records|1 record|2 records|3 records|{count} records";
		const result = fmt.plural(key, 5, "en-US");
		expect(result).toBe("5 records");
	});

	test("selects 'zero' form for English count 0", () => {
		const key = "0 records|1 record|2 records|3 records|{count} records";
		expect(fmt.plural(key, 0, "en-US")).toBe("0 records");
	});

	test("replaces {count} placeholder", () => {
		const key = "|one|two|few|{count} items";
		const result = fmt.plural(key, 42, "en-US");
		expect(result).toBe("42 items");
	});

	test("uses Slovenian plural rules (one→1)", () => {
		const key = "0 zapisov|1 zapis|2 zapisa|3 zapisi|{count} zapisov";
		expect(fmt.plural(key, 1, "sl-SI")).toBe("1 zapis");
	});

	test("uses Slovenian plural rules (two→2)", () => {
		const key = "0 zapisov|1 zapis|{count} zapisa|{count} zapisi|{count} zapisov";
		const result = fmt.plural(key, 2, "sl-SI");
		expect(result).toContain("zapisa");
	});

	test("uses Slovenian plural rules (few→3)", () => {
		const key = "0 zapisov|1 zapis|{count} zapisa|{count} zapisi|{count} zapisov";
		const result = fmt.plural(key, 3, "sl-SI");
		expect(result).toContain("zapisi");
	});

	test("uses Slovenian plural rules (other→5)", () => {
		const key = "0 zapisov|1 zapis|{count} zapisa|{count} zapisi|{count} zapisov";
		const result = fmt.plural(key, 5, "sl-SI");
		expect(result).toContain("zapisov");
	});

	test("falls back to last form when form index is missing", () => {
		const key = "only form";
		expect(fmt.plural(key, 5, "en-US")).toBe("only form");
	});
});

describe("format - format_bulk_delete_message", () => {
	const msg = { bulk_deleted: "0 deleted|1 deleted|{count} deleted|{count} deleted|{count} deleted" };

	test("formats singular (1 item)", () => expect(fmt.format_bulk_delete_message(msg, 1, 0)).toBe("1 deleted"));

	test("formats plural (multiple items)", () => expect(fmt.format_bulk_delete_message(msg, 5, 0)).toBe("5 deleted"));

	test("adds error suffix when errors present", () => {
		const result = fmt.format_bulk_delete_message(msg, 3, 1);
		expect(result).toContain("3 deleted");
		expect(result).toContain("failed");
	});

	test("builds an English pipe fallback when bulk_deleted key is missing", () => expect(fmt.format_bulk_delete_message({}, 5, 0)).toBe("5 records deleted"));

	test("builds fallback error suffix when keys are missing", () => expect(fmt.format_bulk_delete_message({}, 3, 1)).toBe("3 records deleted, 1 record failed"));

	test("uses custom label in the fallback", () => expect(fmt.format_bulk_delete_message({}, 2, 0, "item")).toBe("2 items deleted"));
});
