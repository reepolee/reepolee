import { describe, expect, test } from "bun:test";

import { quote_identifier } from "./sql_dialect";

describe("quote_identifier", () => {
	test("uses MySQL backticks", () => {
		expect(quote_identifier("sensors_sl_si", "mysql")).toBe("`sensors_sl_si`");
	});

	test("uses SQLite double quotes", () => {
		expect(quote_identifier("sensors_sl_si", "sqlite")).toBe('"sensors_sl_si"');
	});

	test("rejects unsafe identifiers", () => {
		expect(() => quote_identifier("sensors; DROP TABLE users", "mysql")).toThrow("Unsafe SQL identifier");
	});
});
