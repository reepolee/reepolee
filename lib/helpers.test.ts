import "$lib/temporal";
import { describe, expect, mock, test } from "bun:test";

import { mock_db, mock_req } from "$root/test_helpers";

mock.module("$config/db", mock_db);
mock.module("$config/supported_languages", () => ({
	languages: ["en", "sl"],
	active_languages: ["en", "sl"],
	default_language: "sl",
	language_names: { en: "English", sl: "Slovenian" },
	language_locales: { en: "en-US", sl: "sl-SI" },
}));

// Now import the actual helpers (mock.module runs before static imports).
// This file predates the barrel retirement and tests functions across their
// real home modules - merge them into one namespace so the suites read as before.
const helpers = {
	...(await import("./helpers")),
	...(await import("./cookies")),
	...(await import("./format")),
	...(await import("./object")),
	...(await import("./route")),
};

describe("helpers", () => {
	describe("normalize_prefix", () => {
		test("empty string → clean empty, route empty", () => expect(helpers.normalize_prefix("")).toEqual({
			clean: "",
			route: "",
		}));

		test("single slash → clean empty, route empty", () => expect(helpers.normalize_prefix("/")).toEqual({
			clean: "",
			route: "",
		}));

		test("multiple slashes only → clean empty, route empty", () => expect(helpers.normalize_prefix("///")).toEqual({
			clean: "",
			route: "",
		}));

		test("clean input (no slashes) → clean preserved, route added", () => expect(helpers.normalize_prefix("admin")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("leading slash → cleaned", () => expect(helpers.normalize_prefix("/admin")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("trailing slash → cleaned", () => expect(helpers.normalize_prefix("admin/")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("both leading and trailing slashes → cleaned", () => expect(helpers.normalize_prefix("/admin/")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("multiple leading and trailing slashes → all stripped", () => expect(helpers.normalize_prefix("//admin///")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("multi-segment path → segments preserved", () => expect(helpers.normalize_prefix("//system/users//")).toEqual({
			clean: "system/users",
			route: "/system/users",
		}));

		test("just underscores and dashes → unchanged", () => expect(helpers.normalize_prefix("my_module")).toEqual({
			clean: "my_module",
			route: "/my_module",
		}));

		test("leading whitespace → trimmed", () => expect(helpers.normalize_prefix("  admin")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("trailing whitespace → trimmed", () => expect(helpers.normalize_prefix("admin  ")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("whitespace and slashes → trimmed and cleaned", () => expect(helpers.normalize_prefix("  /admin/  ")).toEqual({
			clean: "admin",
			route: "/admin",
		}));

		test("whitespace between slashes and text → inner spaces preserved", () => expect(helpers.normalize_prefix("my module")).toEqual({
			clean: "my module",
			route: "/my module",
		}));

		test("only whitespace → clean empty, route empty", () => expect(helpers.normalize_prefix("   ")).toEqual({
			clean: "",
			route: "",
		}));

		test("tabs and newlines → trimmed", () => expect(helpers.normalize_prefix("\tadmin\n")).toEqual({
			clean: "admin",
			route: "/admin",
		}));
	});

	describe("get_table_name_from_dir", () => {
		test("extracts last directory segment", () => expect(helpers.get_table_name_from_dir("/some/path/users")).toBe("users"));

		test("handles backslash separators (Windows compat)", () => expect(helpers.get_table_name_from_dir("C:\\code\\routes\\admin\\products")).toBe("products"));
	});

	describe("get_cookie", () => {
		test("extracts cookie by name", () => {
			const req = mock_req({ Cookie: "session=abc123; lang=sl; theme=dark" });
			expect(helpers.get_cookie(req, "lang")).toBe("sl");
			expect(helpers.get_cookie(req, "session")).toBe("abc123");
		});

		test("returns null for missing cookie", () => {
			const req = mock_req({ Cookie: "session=abc" });
			expect(helpers.get_cookie(req, "lang")).toBeNull();
		});

		test("returns null when no cookie header", () => {
			const req = mock_req({});
			expect(helpers.get_cookie(req, "anything")).toBeNull();
		});

		test("handles URL-encoded cookie values", () => {
			const req = mock_req({ Cookie: "redirect=%2Fdashboard" });
			expect(helpers.get_cookie(req, "redirect")).toBe("/dashboard");
		});

		test("decodes the cookie name", () => {
			const req = mock_req({ Cookie: "toast%2Dupdated%2D1=%7B%22msg%22%3A%22ok%22%7D" });
			expect(helpers.get_cookie(req, "toast-updated-1")).toBe("{\"msg\":\"ok\"}");
		});
	});

	describe("get_cookies_by_prefix", () => {
		test("returns cookies matching prefix", () => {
			const req = mock_req({ Cookie: "toast-a=1; toast-b=2; session=x" });
			const res = helpers.get_cookies_by_prefix(req, "toast-");
			expect(res).toEqual([{ key: "toast-a", value: "1" }, { key: "toast-b", value: "2" }]);
		});

		test("returns empty array when no prefix match", () => {
			const req = mock_req({ Cookie: "session=x; lang=sl" });
			expect(helpers.get_cookies_by_prefix(req, "toast-")).toEqual([]);
		});

		test("handles no cookie header", () => {
			const req = mock_req({});
			expect(helpers.get_cookies_by_prefix(req, "x")).toEqual([]);
		});
	});

	describe("get_lang_from_request", () => {
		test("reads X-Lang header", () => {
			const req = mock_req({ "x-lang": "sl" });
			expect(helpers.get_lang_from_request(req)).toBe("sl");
		});

		test("returns undefined when no header", () => {
			const req = mock_req({});
			expect(helpers.get_lang_from_request(req)).toBeUndefined();
		});

		test("normalises to lowercase", () => {
			const req = mock_req({ "x-lang": "EN" });
			expect(helpers.get_lang_from_request(req)).toBe("en");
		});

		test("returns default_language for unsupported lang", () => {
			const req = mock_req({ "x-lang": "de" });
			expect(helpers.get_lang_from_request(req)).toBe("sl");
		});
	});

	describe("route_namespace_from_dir", () => {
		test("extracts route namespace from absolute path", () => {
			const result = helpers.route_namespace_from_dir("/project/routes/auth/login");
			expect(result).toBe("auth/login");
		});

		test("handles paths without subdirectories", () => {
			const result = helpers.route_namespace_from_dir("/project/routes");
			expect(result).toBe("");
		});

		test("extracts from Windows-style path", () => {
			const result = helpers.route_namespace_from_dir("C:\\project\\routes\\home");
			expect(result).toBe("home");
		});
	});

	describe("formatting functions", () => {
		test("display_currency formats EUR", () => {
			const result = helpers.display_currency(1234.5, "sl-SI");
			expect(result).toContain("€");
		});

		test("display_currency hides zero", () => expect(helpers.display_currency(0, "sl-SI", true)).toBe(""));

		test("display_currency shows zero when not hidden", () => expect(helpers.display_currency(0, "sl-SI", false)).not.toBe(""));

		test("currency_no_cents rounds to integer", () => {
			const result = helpers.currency_no_cents(1234.56, "sl-SI");
			expect(result).toContain("1.235");
		});

		test("currency_no_cents hides zero by default", () => expect(helpers.currency_no_cents(0)).toBe(""));

		test("decimal formats with fraction digits", () => {
			const result = helpers.decimal(1234.5, "sl-SI");
			expect(result).toContain("1.234");
		});

		test("decimal hides zero", () => expect(helpers.decimal(0, "sl-SI", true)).toBe(""));

		test("percent formats with Intl (en-US default)", () => {
			const result = helpers.percent(25, "en-US");
			expect(result).toContain("25");
			expect(result).toContain("%");
		});

		test("percent formats with Slovenian locale", () => {
			const result = helpers.percent(25, "sl-SI");
			expect(result).toContain("25");
			expect(result).toMatch(/%|odstot/);
		});

		test("percent handles undefined", () => {
			const result = helpers.percent(undefined as any);
			expect(result).toContain("0");
		});

		test("display_percent formats with locale", () => {
			const result = helpers.display_percent(25.5, "sl-SI");
			expect(result).toContain("%");
		});

		test("display_percent handles undefined", () => {
			const result = helpers.display_percent(undefined as any, "sl-SI");
			expect(result).toContain("0");
		});
	});

	describe("updated_diff", () => {
		test("returns only changed keys", () => {
			const original = { name: "Alice", email: "a@b.com", age: 30 };
			const updated = { name: "Bob", email: "a@b.com", age: 31 };
			expect(helpers.updated_diff(original, updated)).toEqual({ name: "Bob", age: 31 });
		});

		test("returns empty object when nothing changed", () => {
			const obj = { a: 1, b: 2 };
			expect(helpers.updated_diff(obj, { ...obj })).toEqual({});
		});
	});

	// --- Additional coverage from helpers_additions.test.ts ---

	describe("get_nested", () => {
		test("gets nested value by dot-separated path", () => {
			const obj = { a: { b: { c: "value" } } };
			expect(helpers.get_nested(obj, "a.b.c")).toBe("value");
		});

		test("gets nested value by slash-separated path", () => {
			const obj = { a: { b: { c: "value" } } };
			expect(helpers.get_nested(obj, "a/b/c")).toBe("value");
		});

		test("returns empty for missing path", () => expect(helpers.get_nested({ a: 1 }, "b.c")).toEqual({}));

		test("returns empty for null/undefined obj", () => {
			expect(helpers.get_nested(null, "a")).toEqual({});
			expect(helpers.get_nested(undefined, "a")).toEqual({});
		});

		test("returns empty for empty path", () => expect(helpers.get_nested({ a: 1 }, "")).toEqual({}));
	});

	describe("deep_merge", () => {
		test("merges simple values", () => expect(helpers.deep_merge({ a: 1 }, { b: 2 })).toEqual({
			a: 1,
			b: 2,
		}));

		test("overwrites existing values", () => expect(helpers.deep_merge({ a: 1 }, { a: 2 })).toEqual({ a: 2 }));

		test("deeply merges nested objects", () => {
			const result = helpers.deep_merge({ a: { b: 1, c: 2 } }, { a: { b: 10, d: 3 } });
			expect(result).toEqual({ a: { b: 10, c: 2, d: 3 } });
		});

		test("does not merge arrays", () => expect(helpers.deep_merge({ items: [1, 2] }, { items: [3, 4] })).toEqual({ items: [3, 4] }));

		test("handles null source", () => expect(helpers.deep_merge({ a: 1 }, null as any)).toEqual({ a: 1 }));
	});

	describe("merge_fields", () => {
		test("merges field definitions with overrides", () => {
			const generated = { name: { type: "text", label: "Name", attributes: { maxlength: 255 } } };
			const overrides = { name: { label: "Full Name", attributes: { required: true } } };
			const result = helpers.merge_fields(generated, overrides);
			expect(result.name.label).toBe("Full Name");
			expect(result.name.attributes.maxlength).toBe(255);
			expect(result.name.attributes.required).toBe(true);
		});

		test("returns generated fields unchanged when no overrides", () => {
			const generated = { name: { type: "text", label: "Name" } };
			const result = helpers.merge_fields(generated, {});
			expect(result.name.type).toBe("text");
			expect(result.name.label).toBe("Name");
		});
	});

	describe("plural", () => {
		test("selects correct plural form for count=0 (English: zero)", () => {
			const result = helpers.plural("0 records|1 record|{count} records|{count} records|{count} records", 0);
			expect(result).toBe("0 records");
		});

		test("selects correct plural form for count=1 (English: one)", () => {
			const result = helpers.plural("0 records|1 record|{count} records|{count} records|{count} records", 1);
			expect(result).toBe("1 record");
		});

		test("selects correct plural form for count=2 (English: other)", () => {
			const result = helpers.plural("0 records|1 record|{count} records|{count} records|{count} records", 2);
			expect(result).toBe("2 records");
		});

		test("falls back to last form for missing index", () => {
			const result = helpers.plural("zero|one", 5);
			expect(result).toBe("one");
		});

		test("uses NumberFormat locale for count formatting", () => {
			const result = helpers.plural("0 things|1 thing|{count} things|{count} things|{count} things", 1000, "de-DE");
			expect(result).toBe("1.000 things");
		});

		test("works with Slovenian locale (plural forms: one, two, few, other)", () => {
			const form = "0 zapisov|1 zapis|{count} zapisa|{count} zapisi|{count} zapisov";
			expect(helpers.plural(form, 1, "sl-SI")).toBe("1 zapis");
			expect(helpers.plural(form, 2, "sl-SI")).toBe("2 zapisa");
			expect(helpers.plural(form, 3, "sl-SI")).toBe("3 zapisi");
			expect(helpers.plural(form, 5, "sl-SI")).toBe("5 zapisov");
		});
	});

	describe("format_bulk_delete_message", () => {
		const msg = {
			bulk_deleted: "0 records|1 record|{count} records|{count} records|{count} records",
			bulk_errors: "|{count} record failed|{count} records failed|{count} records failed|{count} records failed|{count} records failed",
		};

		test("formats success message with plural", () => {
			const result = helpers.format_bulk_delete_message(msg, 3, 0, "record", "en-US");
			expect(result).toBe("3 records");
		});

		test("formats message with errors", () => {
			const result = helpers.format_bulk_delete_message(msg, 3, 1, "record", "en-US");
			expect(result).toBe("3 records, 1 record failed");
		});

		test("builds an English pipe fallback when bulk_deleted key is missing", () => {
			const result = helpers.format_bulk_delete_message({}, 5, 0, "record", "en-US");
			expect(result).toBe("5 records deleted");
		});

		test("builds fallback error suffix when keys are missing", () => {
			const result = helpers.format_bulk_delete_message({}, 5, 2, "record", "en-US");
			expect(result).toBe("5 records deleted, 2 records failed");
		});

		test("uses custom label in the fallback", () => {
			const result = helpers.format_bulk_delete_message({}, 3, 1, "user");
			expect(result).toBe("3 users deleted, 1 user failed");
		});

		test("a non-pipe bulk_deleted string is passed through plural() unchanged", () => {
			const msg_without_pipes = { bulk_deleted: "All items deleted." };
			const result = helpers.format_bulk_delete_message(msg_without_pipes, 5, 0, "item");
			expect(result).toBe("All items deleted.");
		});
	});

	describe("localized_url", () => {
		test("preserves path when no route maps built", () => expect(helpers.localized_url("/test", "sl")).toBe("/test"));

		test("preserves query strings", () => expect(helpers.localized_url("/test?page=1", "sl")).toBe("/test?page=1"));
	});

	describe("feature_enabled", () => {
		test("returns true for 'true' env var", () => {
			process.env.TEST_FEATURE = "true";
			expect(helpers.feature_enabled("TEST_FEATURE")).toBe(true);
			delete process.env.TEST_FEATURE;
		});

		test("returns false for missing env var", () => expect(helpers.feature_enabled("NONEXISTENT_FEATURE")).toBe(false));

		test("returns false for 'false' env var", () => {
			process.env.TEST_FEATURE = "false";
			expect(helpers.feature_enabled("TEST_FEATURE")).toBe(false);
			delete process.env.TEST_FEATURE;
		});
	});

	describe("feature_routes", () => {
		test("returns routes when enabled", () => {
			const routes = [{ path: "/test" }];
			expect(helpers.feature_routes(true, routes)).toBe(routes);
		});

		test("returns empty when disabled", () => {
			const routes = [{ path: "/test" }];
			expect(helpers.feature_routes(false, routes)).toEqual([]);
		});
	});

	describe("route_namespace_from_dir edge cases", () => {
		test("throws for path without /routes/", () => expect(() => helpers.route_namespace_from_dir("/some/other/path")).toThrow("path does not contain \"/routes/\""));

		test("handles path ending with /routes", () => {
			const result = helpers.route_namespace_from_dir("/project/routes");
			expect(result).toBe("");
		});
	});

	describe("get_cookies_by_prefix - catch blocks", () => {
		test("handles decodeURIComponent failure for key", () => {
			const req = mock_req({ Cookie: "%ZZ=value" });
			const result = helpers.get_cookies_by_prefix(req, "%");
			expect(result.length).toBe(1);
			expect(result[0].key).toBe("%ZZ");
			expect(result[0].value).toBe("value");
		});

		test("handles decodeURIComponent failure for value", () => {
			const req = mock_req({ Cookie: "key=%ZZ" });
			const result = helpers.get_cookies_by_prefix(req, "key");
			expect(result.length).toBe(1);
			expect(result[0].key).toBe("key");
			expect(result[0].value).toBe("%ZZ");
		});

		test("handles decodeURIComponent failure for both key and value", () => {
			const req = mock_req({ Cookie: "%ZZ=%YY" });
			const result = helpers.get_cookies_by_prefix(req, "%");
			expect(result.length).toBe(1);
			expect(result[0].key).toBe("%ZZ");
			expect(result[0].value).toBe("%YY");
		});
	});

	describe("updated_diff - edge cases", () => {
		test("detects null vs undefined as different", () => {
			const result = helpers.updated_diff({ a: null }, { a: undefined });
			expect(result).toEqual({ a: undefined });
		});

		test("detects different types as different", () => {
			const result = helpers.updated_diff({ count: "5" }, { count: 5 });
			expect(result).toEqual({ count: 5 });
		});

		test("ignores keys only in original (not in updated)", () => {
			const result = helpers.updated_diff({ a: 1, b: 2 }, { a: 1 });
			expect(result).toEqual({});
		});

		test("does not detect same object reference as different", () => {
			const nested = { x: 1 };
			const result = helpers.updated_diff({ data: nested }, { data: nested });
			expect(result).toEqual({});
		});

		test("detects different object references as different (shallow compare)", () => {
			const result = helpers.updated_diff({ data: { x: 1 } }, { data: { x: 1 } });
			expect(result).toEqual({ data: { x: 1 } });
		});
	});

	describe("create_toast_cookie", () => {
		test("creates cookie without req (user is null)", async () => {
			const result = helpers.create_toast_cookie({ record_id: 42, feature: "users" });
			expect(result).toBeDefined();
			const value = JSON.parse(result.value);
			expect(value.record_id).toBe(42);
			expect(value.feature).toBe("users");
			expect(value.message).toBe("record_updated");
			expect(value.type).toBe("yellow");
			expect(value.duration).toBe(2500);
			expect(value.user).toBeUndefined();
		});

		test("creates cookie with custom message, type, duration", async () => {
			const result = helpers.create_toast_cookie({
				record_id: "abc",
				feature: "products",
				message: "record_created",
				type: "green",
				duration: 5000,
			});
			const value = JSON.parse(result.value);
			expect(value.record_id).toBe("abc");
			expect(value.feature).toBe("products");
			expect(value.message).toBe("record_created");
			expect(value.type).toBe("green");
			expect(value.duration).toBe(5000);
		});

		test("creates cookie with req (resolve_session is mocked to return null)", async () => {
			const req = mock_req({ Cookie: "sid=test-session" });
			const result = helpers.create_toast_cookie({ record_id: 1, feature: "test", req });
			const value = JSON.parse(result.value);
			expect(value.user).toBeUndefined();
		});
	});

	describe("get_cookie - catch blocks", () => {
		test("handles decodeURIComponent failure for key (returns null)", () => {
			const req = mock_req({ Cookie: "%ZZ=value" });
			const result = helpers.get_cookie(req, "%ZZ");
			expect(result).toBeNull();
		});

		test("handles decodeURIComponent failure for value (returns raw value)", () => {
			const req = mock_req({ Cookie: "key=%ZZ" });
			const result = helpers.get_cookie(req, "key");
			expect(result).toBe("%ZZ");
		});

		test("returns null for missing cookie header", () => {
			const req = mock_req({});
			expect(helpers.get_cookie(req, "anything")).toBeNull();
		});

		test("returns null for non-matching cookie name", () => {
			const req = mock_req({ Cookie: "other=value" });
			expect(helpers.get_cookie(req, "target")).toBeNull();
		});

		test("handles value containing equals signs", () => {
			const req = mock_req({ Cookie: "token=abc=def==" });
			const result = helpers.get_cookie(req, "token");
			expect(result).toBe("abc=def==");
		});
	});

	describe("display_currency - edge cases", () => {
		test("handles undefined value (defaults to 0)", () => {
			const result = helpers.display_currency(undefined as any);
			expect(result).toContain("0");
		});

		test("hide_zero returns empty for 0", () => expect(helpers.display_currency(0, "sl-SI", true)).toBe(""));

		test("custom symbol replaces EUR", () => {
			const result = helpers.display_currency(100, "en-US", false, "USD");
			expect(result).toContain("USD");
		});
	});

	describe("currency_no_cents - edge cases", () => {
		test("handles undefined value (defaults to 0)", () => {
			const result = helpers.currency_no_cents(undefined as any, "sl-SI", false);
			expect(result).toContain("0");
		});

		test("hide_zero returns empty for 0", () => expect(helpers.currency_no_cents(0, "sl-SI", true)).toBe(""));

		test("rounds decimal values", () => {
			const result = helpers.currency_no_cents(1234.56);
			expect(result).toBe("1.235");
		});
	});

	describe("decimal - edge cases", () => {
		test("handles undefined value (defaults to 0)", () => {
			const result = helpers.decimal(undefined as any);
			expect(result).toContain("0");
		});

		test("hide_zero returns empty for 0", () => expect(helpers.decimal(0, "sl-SI", true)).toBe(""));

		test("custom fraction digits", () => {
			const result = helpers.decimal(1234.5, "sl-SI", false, 3);
			expect(result).toBe("1.234,500");
		});
	});

	describe("percent - edge cases", () => {
		test("handles undefined value (defaults to 0)", () => {
			const result = helpers.percent(undefined as any);
			expect(result).toContain("0");
		});

		test("formats 25 as 25%", () => {
			const result = helpers.percent(25);
			expect(result).toBe("25%");
		});
	});

	describe("display_percent - edge cases", () => {
		test("handles undefined value (defaults to 0)", () => {
			const result = helpers.display_percent(undefined as any);
			expect(result).toContain("0");
		});

		test("formats with fraction digits", () => {
			const result = helpers.display_percent(25.5);
			expect(result).toBe("25.5%");
		});
	});

	describe("get_table_name_from_dir - additional", () => {
		test("extracts last segment from path", () => expect(helpers.get_table_name_from_dir("/routes/admin/users")).toBe("users"));

		test("handles Windows backslashes", () => expect(helpers.get_table_name_from_dir("C:\\projects\\routes\\items")).toBe("items"));
	});

	describe("normalize_prefix - additional", () => {
		test("strips leading slashes", () => {
			const result = helpers.normalize_prefix("//admin///");
			expect(result).toEqual({ clean: "admin", route: "/admin" });
		});

		test("handles empty string", () => {
			const result = helpers.normalize_prefix("");
			expect(result).toEqual({ clean: "", route: "" });
		});

		test("handles already clean input", () => {
			const result = helpers.normalize_prefix("admin");
			expect(result).toEqual({ clean: "admin", route: "/admin" });
		});
	});

});
