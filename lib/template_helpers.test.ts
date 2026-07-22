import { describe, expect, mock, test } from "bun:test";

import { mock_db } from "$root/test_helpers";

mock.module("$config/db", mock_db);

const th = await import("./template_helpers");

describe("template_helpers", () => {
	describe("url", () => {
		test("adds leading slash if missing", () => {
			expect(th.url("test")).toBe("/test");
			expect(th.url("admin/users")).toBe("/admin/users");
		});

		test("preserves leading slash if present", () => {
			expect(th.url("/test")).toBe("/test");
			expect(th.url("/admin/users")).toBe("/admin/users");
		});
	});

	describe("localized_path", () => test("returns canonical path when no route maps built", () => expect(th.localized_path("/test")).toBe("/test")));

	describe("nav_label", () => {
		test("returns last segment wrapped in {...} when nav is empty", () => expect(th.nav_label("home.title")).toBe("{title}"));

		test("returns last segment wrapped in {...} when nav is null", () => expect(th.nav_label("home.title", null as any)).toBe("{title}"));

		test("looks up nested key in nav object", () => {
			const nav = { home: { title: "Home" } };
			expect(th.nav_label("home.title", nav)).toBe("Home");
		});

		test("returns fallback for missing path", () => {
			const nav = { home: { title: "Home" } };
			expect(th.nav_label("about.title", nav)).toBe("{title}");
		});

		test("returns fallback for non-object intermediate", () => {
			const nav = { home: "not_an_object" };
			expect(th.nav_label("home.title", nav)).toBe("{title}");
		});
	});

	describe("is_current", () => {
		test("returns 'nav-item' when no request_url", () => expect(th.is_current("/test")).toBe("nav-item"));

		test("returns 'nav-item' on non-matching path", () => expect(th.is_current("/other", "/test")).toBe("nav-item"));

		test("marks current page with bold class", () => expect(th.is_current("/test", "/test")).toBe("font-bold nav-item current"));

		test("marks parent path as current for sub-pages", () => expect(th.is_current("/admin", "/admin/users")).toBe("font-bold nav-item current"));

		test("marks parent path as current with query params", () => expect(th.is_current("/search", "/search?q=hello")).toBe("font-bold nav-item current"));

		test("normalizes trailing slashes", () => {
			expect(th.is_current("/test/", "/test")).toBe("font-bold nav-item current");
			expect(th.is_current("/test", "/test/")).toBe("font-bold nav-item current");
		});
	});

	describe("pill", () => test("renders a pill div with class", () => {
		const result = th.pill("Active", "pill-yes");
		expect(result).toBe("<div class=\"pill-yes\">Active</div>");
	}));

	describe("yes_no", () => {
		test("renders yes for 1", () => {
			const result = th.yes_no(1);
			expect(result).toContain("pill-yes");
		});

		test("renders transparent for 0 with yes_only type", () => {
			const result = th.yes_no(0);
			expect(result).toContain("bg-transparent");
		});

		test("renders pill-no for 0 with both type", () => {
			const result = th.yes_no(0, "both");
			expect(result).toContain("pill-no");
		});

		test("uses selectors when provided", () => {
			const selectors = { "0": "No", "1": "Yes" };
			expect(th.yes_no(1, "yes_only", selectors)).toContain("Yes");
			expect(th.yes_no(0, "both", selectors)).toContain("No");
		});
	});

	describe("tags", () => {
		test("returns empty for empty string", () => expect(th.tags("")).toBe(""));

		test("splits comma-separated values into pills", () => {
			const result = th.tags("admin,editor");
			expect(result).toContain("admin");
			expect(result).toContain("editor");
		});

		test("trims whitespace around tags", () => {
			const result = th.tags("  admin , editor ");
			expect(result).toContain("admin");
			expect(result).toContain("editor");
		});

		test("uses tag_translations when available", () => {
			const translations = { admin: "Administrator", editor: "Editor" };
			const result = th.tags("admin,editor", "pill-default", translations);
			expect(result).toContain("Administrator");
			expect(result).toContain("Editor");
			expect(result).not.toContain("admin");
		});

		test("applies color class to pills", () => {
			const result = th.tags("admin", "pill-info");
			expect(result).toContain("pill-info");
		});

		test("filters empty tags from input like 'a,,b'", () => {
			const result = th.tags("a,,b");
			expect(result).toContain("a");
			expect(result).toContain("b");
		});
	});

	describe("key_values", () => {
		test("renders boolean true as bare attribute", () => expect(th.key_values({ disabled: true })).toBe("disabled"));

		test("skips boolean false and null", () => expect(th.key_values({
			disabled: false,
			hidden: null,
		})).toBe(""));

		test("renders string values as key=\"value\"", () => expect(th.key_values({
			class: "foo",
			id: "bar",
		})).toBe("class=\"foo\" id=\"bar\""));

		test("skips undefined values", () => expect(th.key_values({
			name: "test",
			extra: undefined,
		})).toBe("name=\"test\""));
	});

	describe("human_bytes", () => {
		test("formats bytes", () => expect(th.human_bytes(500)).toBe("500 B"));

		test("formats kilobytes", () => {
			// The function rounds to 1 decimal for values < 10 in that unit
			const result = th.human_bytes(2048);
			expect(result).toMatch(/^2(\.0)? KB$/);
		});

		test("formats megabytes", () => {
			const result = th.human_bytes(5 * 1024 * 1024);
			expect(result).toMatch(/^5(\.0)? MB$/);
		});

		test("formats gigabytes", () => {
			const result = th.human_bytes(3 * 1024 * 1024 * 1024);
			expect(result).toMatch(/^3(\.0)? GB$/);
		});

		test("shows decimal for non-round KB values < 10", () => {
			const result = th.human_bytes(1536);
			expect(result).toMatch(/1\.5 KB/);
		});

		test("rounds to integer for values >= 10", () => {
			const result = th.human_bytes(11264); // 11 KB
			expect(result).toBe("11 KB");
		});

		test("handles 0 bytes", () => expect(th.human_bytes(0)).toBe("0 B"));
	});

	describe("urlencode / urldecode", () => {
		test("urlencode encodes special characters", () => {
			// Bun's encodeURIComponent uses %20 not +
			expect(th.urlencode("hello world")).toBe("hello%20world");
			expect(th.urlencode("a/b?c=d")).toBe("a%2Fb%3Fc%3Dd");
		});

		test("urlencode handles null/undefined as empty", () => {
			expect(th.urlencode(null as any)).toBe("");
			expect(th.urlencode(undefined as any)).toBe("");
		});

		test("urldecode decodes encoded strings", () => {
			expect(th.urldecode("hello%20world")).toBe("hello world");
			expect(th.urldecode("a%2Fb%3Fc%3Dd")).toBe("a/b?c=d");
		});

		test("urldecode handles null/undefined as empty", () => {
			expect(th.urldecode(null as any)).toBe("");
			expect(th.urldecode(undefined as any)).toBe("");
		});

		test("round-trips encode/decode", () => {
			const original = "test & value? yes=no!";
			expect(th.urldecode(th.urlencode(original))).toBe(original);
		});
	});

	describe("format_datetime - js_date_to_locale_string", () => {
		// These depend on Temporal polyfill and timezone config
		test("returns empty for falsy input", () => {
			expect(th.format_datetime("", "date")).toBe("");
			expect(th.format_datetime(null as any, "date")).toBe("");
			expect(th.format_datetime(undefined as any, "date")).toBe("");
		});

		test("handles plain date string (YYYY-MM-DD)", () => {
			const result = th.format_datetime("2026-01-02", "date");
			expect(result).toBeTruthy();
			expect(result.length).toBeGreaterThan(0);
			// With en-US locale the format is MM/DD/YY
			expect(th.format_datetime("2026-01-02", "date", "locale", "en-US")).toBe("01/02/26");
		});
	});

	describe("format_datetime - js_date_to_iso_string", () => {
		test("returns empty for falsy input", () => {
			expect(th.format_datetime("", "date", "iso")).toBe("");
			expect(th.format_datetime(null as any, "date", "iso")).toBe("");
		});

		test("passes through YYYY-MM-DD strings", () => expect(th.format_datetime("2026-05-15", "date", "iso")).toBe("2026-05-15"));
	});

	describe("create_default_helpers", () => test("returns an object with all expected helper keys", () => {
		const helpers = th.create_default_helpers({ lang: "en", locale: "en-US" });
		expect(helpers).toHaveProperty("url");
		expect(helpers).toHaveProperty("localized_path");
		expect(helpers).toHaveProperty("nav_label");
		expect(helpers).toHaveProperty("is_current");
		expect(helpers).toHaveProperty("js_date_to_locale_string");
		expect(helpers).toHaveProperty("js_time_to_locale_string");
		expect(helpers).toHaveProperty("js_datetime_to_locale_string");
		expect(helpers).toHaveProperty("js_timestamp_to_locale_string");
		expect(helpers).toHaveProperty("js_date_to_iso_string");
		expect(helpers).toHaveProperty("js_datetime_to_iso_string");
		expect(helpers).toHaveProperty("js_timestamp_to_iso_string");
		expect(helpers).toHaveProperty("display_currency");
		expect(helpers).toHaveProperty("display_percent");
		expect(helpers).toHaveProperty("urlencode");
		expect(helpers).toHaveProperty("urldecode");
		expect(helpers).toHaveProperty("pill");
		expect(helpers).toHaveProperty("tags");
		expect(helpers).toHaveProperty("yes_no");
		expect(helpers).toHaveProperty("human_bytes");
		expect(helpers).toHaveProperty("key_values");
	}));

	describe("create_template_helpers", () => test("merges custom helpers over defaults", () => {
		const helpers = th.create_template_helpers({ lang: "en" }, { custom_fn: () => "custom" });
		expect(helpers.custom_fn()).toBe("custom");
		expect(helpers.url).toBe(th.url);
	}));

	describe("format_datetime - js_time_to_locale_string", () => {
		test("returns empty for falsy input", () => {
			expect(th.format_datetime("", "time")).toBe("");
			expect(th.format_datetime(null as any, "time")).toBe("");
			expect(th.format_datetime(undefined as any, "time")).toBe("");
		});

		test("formats Date input", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = th.format_datetime(date, "time");
			expect(result).toBeTruthy();
			expect(result.length).toBeGreaterThan(0);
		});

		test("formats with explicit locale", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = th.format_datetime(date, "time", "locale", "en-US");
			expect(result).toBe("10:30 AM");
		});
	});

	describe("format_datetime - js_datetime_to_locale_string", () => {
		test("returns empty for falsy input", () => {
			expect(th.format_datetime("", "datetime")).toBe("");
			expect(th.format_datetime(null, "datetime")).toBe("");
			expect(th.format_datetime(undefined, "datetime")).toBe("");
		});

		test("formats Date input", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = th.format_datetime(date, "datetime");
			expect(result).toBeTruthy();
			expect(result.length).toBeGreaterThan(0);
		});

		test("formats ISO string input", () => {
			const result = th.format_datetime("2026-05-15T10:30:00Z", "datetime", "locale", "en-US");
			expect(result).toBe("05/15/26, 10:30 AM");
		});

		test("formats with explicit locale", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = th.format_datetime(date, "datetime", "locale", "sl-SI");
			expect(result).toBeTruthy();
		});
	});

	describe("format_datetime - js_timestamp_to_locale_string", () => {
		test("returns empty for falsy input", () => {
			expect(th.format_datetime("", "timestamp")).toBe("");
			expect(th.format_datetime(null, "timestamp")).toBe("");
			expect(th.format_datetime(undefined, "timestamp")).toBe("");
		});

		test("formats Date input", () => {
			const date = new Date("2026-05-15T10:30:45Z");
			const result = th.format_datetime(date, "timestamp");
			expect(result).toBeTruthy();
			expect(result.length).toBeGreaterThan(0);
		});

		test("formats ISO string input", () => {
			const result = th.format_datetime("2026-05-15T10:30:45Z", "timestamp", "locale", "en-US");
			expect(result).toBe("05/15/26, 10:30:45 AM");
		});

		test("formats with explicit locale", () => {
			const date = new Date("2026-05-15T10:30:45Z");
			const result = th.format_datetime(date, "timestamp", "locale", "de-DE");
			expect(result).toBeTruthy();
		});
	});

	describe("js_date_to_iso_string - additional", () => test("converts Date to ISO string", () => {
		const date = new Date("2026-05-15T10:30:00Z");
		const result = th.format_datetime(date, "date", "iso");
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	}));

	describe("format_datetime - js_datetime_to_iso_string", () => {
		test("returns empty for falsy input", () => {
			expect(th.format_datetime("", "datetime", "iso")).toBe("");
			expect(th.format_datetime(null as any, "datetime", "iso")).toBe("");
		});

		test("converts ISO string to datetime-local format", () => {
			const result = th.format_datetime("2026-05-15T10:30:00Z", "datetime", "iso");
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});

		test("converts Date to datetime-local format", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = th.format_datetime(date, "datetime", "iso");
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});
	});

	describe("format_datetime - js_timestamp_to_iso_string", () => {
		test("returns empty for falsy input", () => {
			expect(th.format_datetime("", "timestamp", "iso")).toBe("");
			expect(th.format_datetime(null as any, "timestamp", "iso")).toBe("");
		});

		test("converts ISO string with seconds", () => {
			const result = th.format_datetime("2026-05-15T10:30:45Z", "timestamp", "iso");
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});

		test("converts Date to timestamp format", () => {
			const date = new Date("2026-05-15T10:30:45Z");
			const result = th.format_datetime(date, "timestamp", "iso");
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		});
	});

	describe("js_date_to_locale_string - additional", () => {
		test("formats with explicit locale parameter", () => {
			const result = th.format_datetime("2026-01-02", "date", "locale", "de-DE");
			expect(result).toBeTruthy();
		});

		test("formats Date with locale parameter", () => {
			const date = new Date("2026-05-15T10:30:00Z");
			const result = th.format_datetime(date, "date", "locale", "sl-SI");
			expect(result).toBeTruthy();
		});
	});

	describe("localized_path - with explicit lang", () => test("returns canonical path with explicit lang parameter", () => expect(th.localized_path("/test", "sl")).toBe("/test")));

	describe("key_values - additional", () => test("renders mixed boolean, string, and undefined values", () => {
		const result = th.key_values({
			disabled: true,
			class: "btn",
			hidden: false,
			id: "main",
			data_test: "value",
			extra: undefined,
			nullable: null,
		});
		expect(result).toContain("disabled");
		expect(result).toContain("class=\"btn\"");
		expect(result).toContain("id=\"main\"");
		expect(result).toContain("data_test=\"value\"");
		expect(result).not.toContain("hidden");
		expect(result).not.toContain("extra");
		expect(result).not.toContain("nullable");
	}));

	describe("yes_no - additional edge cases", () => test("renders empty pill + closing span for 0 with yes_only (default)", () => {
		const result = th.yes_no(0);
		expect(result).toBe("<div class=\"bg-transparent\"></div></span>");
	}));

	describe("tags - additional edge cases", () => {
		test("returns empty for string with only commas", () => {
			expect(th.tags(",")).toBe("");
			expect(th.tags(",,,")).toBe("");
		});

		test("returns empty for whitespace-only input", () => expect(th.tags("  ")).toBe(""));
	});

	describe("create_default_helpers - with locale customization", () => test("uses locale for date formatting helpers", () => {
		const helpers = th.create_default_helpers({ lang: "en", locale: "en-US" });
		const date = new Date("2026-05-15T10:30:00Z");
		const result = helpers.js_date_to_locale_string(date);
		expect(result).toBe("05/15/26");
	}));

	describe("catch blocks - invalid date inputs", () => {
		test("js_date_to_locale_string catches Temporal.PlainDate.from failure", () => {
			const result = th.format_datetime("2026-02-30", "date");
			expect(result).toBe("");
		});

		test("js_date_to_locale_string catches invalid Date input (to_instant fails)", () => {
			const result = th.format_datetime("not-a-date", "date");
			expect(result).toBe("");
		});

		test("js_date_to_iso_string catches invalid Date input", () => {
			const result = th.format_datetime("not-a-date", "date", "iso");
			expect(result).toBe("");
		});

		test("js_datetime_to_iso_string catches invalid Date input", () => {
			const result = th.format_datetime("not-a-date", "datetime", "iso");
			expect(result).toBe("");
		});

		test("js_timestamp_to_iso_string catches invalid Date input", () => {
			const result = th.format_datetime("not-a-date", "timestamp", "iso");
			expect(result).toBe("");
		});

		test("js_datetime_to_locale_string returns empty for non-date input", () => {
			const result = th.format_datetime("invalid", "datetime");
			expect(result).toBe("");
		});

		test("js_timestamp_to_locale_string returns empty for non-date input", () => {
			const result = th.format_datetime("not-a-date", "timestamp");
			expect(result).toBe("");
		});

		test("js_time_to_locale_string catches invalid Date (toISOString fails)", () => {
			const result = th.format_datetime("invalid-date" as any, "time");
			expect(result).toBe("");
		});
	});

	describe("create_default_helpers - edge cases", () => {
		test("creates helpers without nav/selectors", () => {
			const helpers = th.create_default_helpers({ lang: "en" });
			expect(helpers.url).toBeDefined();
			expect(helpers.nav_label).toBeDefined();
		});

		test("uses default language when lang not provided", () => {
			const helpers = th.create_default_helpers({});
			const result = helpers.localized_path("/test");
			expect(result).toBe("/test");
		});
	});
});

describe("DEFAULT_HELPER_NAMES drift guard", () => {
	test("matches the keys create_default_helpers() actually produces", async () => {
		const { DEFAULT_HELPER_NAMES } = await import("./template/helper_names");
		const actual = Object.keys(th.create_default_helpers({})).sort();
		const expected: string[] = [...DEFAULT_HELPER_NAMES].sort();
		expect(expected).toEqual(actual);
	});
});
