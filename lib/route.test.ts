import { describe, expect, mock, test } from "bun:test";

// Mock config modules
mock.module("$config/supported_languages", () => ({
	languages: ["en", "sl"],
	default_language: "sl",
	language_names: { en: "English", sl: "Slovenian" },
	active_languages: ["en", "sl"],
}));

const route = await import("./route");

describe("route - normalized_prefix", () => {
	test("empty string → clean empty, route empty", () => expect(route.normalize_prefix("")).toEqual({
		clean: "",
		route: "",
	}));

	test("single slash → clean empty, route empty", () => expect(route.normalize_prefix("/")).toEqual({
		clean: "",
		route: "",
	}));

	test("clean input → clean preserved, route added", () => expect(route.normalize_prefix("admin")).toEqual({
		clean: "admin",
		route: "/admin",
	}));

	test("leading and trailing slashes → stripped", () => expect(route.normalize_prefix("/admin/")).toEqual({
		clean: "admin",
		route: "/admin",
	}));

	test("multiple slashes → all stripped", () => expect(route.normalize_prefix("//admin///")).toEqual({
		clean: "admin",
		route: "/admin",
	}));
});

describe("route - route_namespace_from_dir", () => {
	test("extracts route namespace from absolute path", () => {
		const result = route.route_namespace_from_dir("/project/routes/auth/login");
		expect(result).toBe("auth/login");
	});

	test("extracts from Windows-style path", () => {
		const result = route.route_namespace_from_dir("C:\\project\\routes\\home");
		expect(result).toBe("home");
	});

	test("extracts namespace with multiple segments", () => {
		const result = route.route_namespace_from_dir("/app/routes/admin/users/list");
		expect(result).toBe("admin/users/list");
	});

	test("throws when path does not contain /routes/", () => expect(() => route.route_namespace_from_dir("/some/other/path")).toThrow("route_namespace_from_dir"));
});

describe("route - get_lang_from_request", () => {
	// Helper to create a mock Request-like object for the BunRequest type
	function mock_req(headers: Record<string, string>): any { return { headers: new Map(Object.entries(headers)) }; }

	test("reads x-lang header", () => {
		const req = mock_req({ "x-lang": "sl" });
		expect(route.get_lang_from_request(req)).toBe("sl");
	});

	test("returns undefined when no header", () => {
		const req = mock_req({});
		expect(route.get_lang_from_request(req)).toBeUndefined();
	});

	test("normalises to lowercase", () => {
		const req = mock_req({ "x-lang": "EN" });
		expect(route.get_lang_from_request(req)).toBe("en");
	});

	test("returns default_language for unsupported lang", () => {
		const req = mock_req({ "x-lang": "de" });
		// default is "sl" from the mock
		expect(route.get_lang_from_request(req)).toBe("sl");
	});
});
