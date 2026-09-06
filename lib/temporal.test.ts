import { describe, expect, test } from "bun:test";

// Ensure TEMPORAL.timezone is set
process.env.TIME_ZONE ??= "UTC";

// Import the module (loads Temporal polyfill)
const temporal = await import("./temporal");

describe("temporal", () => {
	describe("now_epoch_ms", () => {
		test("returns a positive number", () => {
			const result = temporal.now_epoch_ms();
			expect(result).toBeGreaterThan(1700000000000);
		});

		test("returns close to Date.now()", () => {
			const before = Date.now();
			const result = temporal.now_epoch_ms();
			const after = Date.now();
			expect(result).toBeGreaterThanOrEqual(before);
			expect(result).toBeLessThanOrEqual(after);
		});
	});

	describe("now_today", () => {
		test("returns string in YYYY-MM-DD format", () => {
			const result = temporal.now_today();
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		test("matches today's date", () => {
			const expected = new Date().toISOString().slice(0, 10);
			expect(temporal.now_today()).toBe(expected);
		});
	});

	describe("now_iso_str", () => test("returns a full ISO string", () => {
		const result = temporal.now_iso_str();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	}));

	describe("now_year", () => test("returns current year", () => {
		const result = temporal.now_year();
		expect(result).toBe(new Date().getFullYear());
		expect(result).toBeGreaterThan(2020);
	}));

	describe("now_time_str", () => {
		test("returns time in HH:MM:SS format by default", () => {
			const result = temporal.now_time_str();
			expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
		});

		test("includes milliseconds when asked", () => {
			const result = temporal.now_time_str(true);
			expect(result).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
		});
	});

	describe("date_to_instant", () => test("converts Date to Temporal.Instant", () => {
		const date = new Date("2026-05-15T10:30:00Z");
		const instant = temporal.date_to_instant(date);
		expect(instant).toBeDefined();
		expect(instant.epochMilliseconds).toBe(date.getTime());
	}));

	describe("instant_to_sql", () => {
		test("returns SQL-friendly format", () => {
			const instant = temporal.Temporal.Instant.from("2026-05-15T10:30:00Z");
			const result = temporal.instant_to_sql(instant);
			expect(result).toBe("2026-05-15 10:30:00");
		});

		test("works without argument (uses now)", () => {
			const result = temporal.instant_to_sql();
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
		});
	});

	describe("sql_to_datetime_local", () => {
		test("converts SQL datetime to locale format", () => {
			const result = temporal.sql_to_datetime_local("2026-05-15 10:30:00", "UTC");
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});

		test("returns empty for null/undefined", () => {
			expect(temporal.sql_to_datetime_local(null)).toBe("");
			expect(temporal.sql_to_datetime_local(undefined)).toBe("");
		});

		test("handles Date objects", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = temporal.sql_to_datetime_local(date, "UTC");
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});

		test("converts with timezone offset", () => {
			// Use an ISO string with explicit offset to avoid system timezone dependency
			const result = temporal.sql_to_datetime_local("2026-05-15T10:30:00+02:00", "UTC");
			expect(result).toBe("2026-05-15T08:30");
		});
	});

	describe("to_instant", () => {
		test("returns null for null/empty", () => {
			expect(temporal.to_instant(null)).toBeNull();
			expect(temporal.to_instant("")).toBeNull();
			expect(temporal.to_instant(undefined)).toBeNull();
		});

		test("returns Temporal.Instant as-is", () => {
			const instant = temporal.Temporal.Instant.from("2026-05-15T10:30:00Z");
			expect(temporal.to_instant(instant)).toBe(instant);
		});

		test("converts Date objects", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = temporal.to_instant(date);
			expect(result).toBeDefined();
			expect(result?.epochMilliseconds).toBe(date.getTime());
		});

		test("converts ISO string", () => {
			const result = temporal.to_instant("2026-05-15T10:30:00Z");
			expect(result).toBeDefined();
			expect(result?.epochMilliseconds).toBe(new Date("2026-05-15T10:30:00Z").getTime());
		});

		test("converts SQL datetime string", () => {
			const result = temporal.to_instant("2026-05-15 10:30:00");
			expect(result).toBeDefined();
		});

		test("converts datetime-local string", () => {
			const result = temporal.to_instant("2026-05-15T10:30");
			expect(result).toBeDefined();
		});

		test("throws for unsupported types", () => expect(() => temporal.to_instant(12345)).toThrow("Unsupported date type"));
	});

	describe("string_to_instant", () => {
		test("returns null for empty string", () => {
			expect(temporal.string_to_instant("")).toBeNull();
			expect(temporal.string_to_instant("  ")).toBeNull();
		});

		test("parses ISO instant with timezone", () => {
			const result = temporal.string_to_instant("2026-05-15T10:30:00Z");
			expect(result).toBeDefined();
			expect(result?.epochMilliseconds).toBe(new Date("2026-05-15T10:30:00Z").getTime());
		});

		test("parses ISO instant with offset", () => {
			const result = temporal.string_to_instant("2026-05-15T12:30:00+02:00");
			expect(result).toBeDefined();
			expect(result?.epochMilliseconds).toBe(new Date("2026-05-15T10:30:00Z").getTime());
		});

		test("parses SQL datetime (space separator)", () => {
			const result = temporal.string_to_instant("2026-05-15 10:30:00");
			expect(result).toBeDefined();
		});

		test("parses SQL datetime without seconds", () => {
			const result = temporal.string_to_instant("2026-05-15 10:30");
			expect(result).toBeDefined();
		});

		test("parses datetime-local format", () => {
			const result = temporal.string_to_instant("2026-05-15T10:30");
			expect(result).toBeDefined();
		});

		test("parses datetime-local with seconds", () => {
			const result = temporal.string_to_instant("2026-05-15T10:30:00");
			expect(result).toBeDefined();
		});

		test("returns null for invalid string", () => expect(temporal.string_to_instant("not-a-date")).toBeNull());

		test("trims whitespace", () => {
			const result = temporal.string_to_instant("  2026-05-15T10:30:00Z  ");
			expect(result).toBeDefined();
		});

		test("returns null for invalid ISO instant (catch block)", () => {
			// Valid ISO format pattern but Temporal.Instant.from() will throw
			// e.g., February 30 doesn't exist
			const result = temporal.string_to_instant("2026-02-30T10:30:00Z");
			expect(result).toBeNull();
		});

		test("returns null for invalid datetime-local (catch block)", () => {
			// Valid datetime-local pattern but Temporal.PlainDateTime.from() throws
			const result = temporal.string_to_instant("2026-02-30T10:30");
			expect(result).toBeNull();
		});

		test("returns null for date-only string without time component", () => {
			// YYYY-MM-DD alone doesn't match any pattern in string_to_instant
			const result = temporal.string_to_instant("2026-05-15");
			expect(result).toBeNull();
		});
	});
});

describe("local_js_datetime_to_iso_string", () => {
	test("returns default format (YYYY-MM-DD HH:MM:SS) when called with no arguments", () => {
		const result = temporal.local_js_datetime_to_iso_string();
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	test("formats an explicit date correctly", () => {
		const date = new Date(2026, 0, 15, 14, 30, 45);
		expect(temporal.local_js_datetime_to_iso_string(date)).toBe("2026-01-15 14:30:45");
	});

	test("pads single-digit month and day with leading zeros", () => {
		const date = new Date(2026, 0, 5, 9, 5, 3);
		expect(temporal.local_js_datetime_to_iso_string(date)).toBe("2026-01-05 09:05:03");
	});

	test("handles leap year date (Feb 29)", () => {
		const date = new Date(2024, 1, 29, 12, 0, 0);
		expect(temporal.local_js_datetime_to_iso_string(date)).toBe("2024-02-29 12:00:00");
	});

	test("handles December (month 11)", () => {
		const date = new Date(2026, 11, 25, 0, 0, 0);
		expect(temporal.local_js_datetime_to_iso_string(date)).toBe("2026-12-25 00:00:00");
	});

	test("handles month/day/time boundaries", () => {
		const date = new Date(2026, 5, 30, 23, 59, 59);
		expect(temporal.local_js_datetime_to_iso_string(date)).toBe("2026-06-30 23:59:59");
	});
});
