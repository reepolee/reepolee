import { describe, expect, test } from "bun:test";

import { mock_req } from "$root/test_helpers";

const cookies = await import("./cookies");

describe("cookies - get_cookie", () => {
	test("extracts single cookie by name", () => {
		const req = mock_req({ Cookie: "session=abc123" });
		expect(cookies.get_cookie(req, "session")).toBe("abc123");
	});

	test("extracts cookie from multiple cookies", () => {
		const req = mock_req({ Cookie: "session=abc123; lang=sl; theme=dark" });
		expect(cookies.get_cookie(req, "lang")).toBe("sl");
		expect(cookies.get_cookie(req, "session")).toBe("abc123");
		expect(cookies.get_cookie(req, "theme")).toBe("dark");
	});

	test("returns null for missing cookie", () => {
		const req = mock_req({ Cookie: "session=abc" });
		expect(cookies.get_cookie(req, "lang")).toBeNull();
	});

	test("returns null when no cookie header", () => {
		const req = mock_req({});
		expect(cookies.get_cookie(req, "anything")).toBeNull();
	});

	test("handles URL-encoded cookie values", () => {
		const req = mock_req({ Cookie: "redirect=%2Fdashboard" });
		expect(cookies.get_cookie(req, "redirect")).toBe("/dashboard");
	});

	test("decodes the cookie name", () => {
		const req = mock_req({ Cookie: "toast%2Dupdated%2D1=%7B%22msg%22%3A%22ok%22%7D" });
		expect(cookies.get_cookie(req, "toast-updated-1")).toBe("{\"msg\":\"ok\"}");
	});

	test("handles cookies with = in the value", () => {
		const req = mock_req({ Cookie: "data=base64==encoded==" });
		expect(cookies.get_cookie(req, "data")).toBe("base64==encoded==");
	});

	test("returns null for empty cookie header", () => {
		const req = mock_req({ Cookie: "" });
		expect(cookies.get_cookie(req, "anything")).toBeNull();
	});

	test("skips malformed cookie keys gracefully", () => {
		const req = mock_req({ Cookie: "bad%FFkey=value; good=ok" });
		expect(cookies.get_cookie(req, "good")).toBe("ok");
	});

	test("is case-sensitive with cookie names", () => {
		const req = mock_req({ Cookie: "Session=abc123; session=xyz" });
		expect(cookies.get_cookie(req, "session")).toBe("xyz");
	});
});

describe("cookies - get_cookies_by_prefix", () => {
	test("returns cookies matching prefix", () => {
		const req = mock_req({ Cookie: "toast-a=1; toast-b=2; session=x" });
		const res = cookies.get_cookies_by_prefix(req, "toast-");
		expect(res).toEqual([{ key: "toast-a", value: "1" }, { key: "toast-b", value: "2" }]);
	});

	test("returns empty array when no prefix match", () => {
		const req = mock_req({ Cookie: "session=x; lang=sl" });
		expect(cookies.get_cookies_by_prefix(req, "toast-")).toEqual([]);
	});

	test("handles no cookie header", () => {
		const req = mock_req({});
		expect(cookies.get_cookies_by_prefix(req, "x")).toEqual([]);
	});

	test("handles URL-encoded values with prefix match", () => {
		const req = mock_req({ Cookie: "toast-msg=hello%20world" });
		// Prefix check is on raw key (before decode), so use decoded prefix
		const res = cookies.get_cookies_by_prefix(req, "toast-");
		expect(res).toEqual([{ key: "toast-msg", value: "hello world" }]);
	});

	test("prefix is matched exactly (not substring)", () => {
		const req = mock_req({ Cookie: "toast-a=1; toast-ab=2" });
		const res = cookies.get_cookies_by_prefix(req, "toast-a");
		expect(res).toEqual([{ key: "toast-a", value: "1" }, { key: "toast-ab", value: "2" }]);
	});

	test("handles empty cookie header", () => {
		const req = mock_req({ Cookie: "" });
		expect(cookies.get_cookies_by_prefix(req, "x")).toEqual([]);
	});

	test("skips cookies with empty keys", () => {
		const req = mock_req({ Cookie: "=val; toast-x=ok" });
		const res = cookies.get_cookies_by_prefix(req, "toast-");
		expect(res).toEqual([{ key: "toast-x", value: "ok" }]);
	});
});
