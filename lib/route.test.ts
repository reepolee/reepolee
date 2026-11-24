import { describe, expect, mock, test } from "bun:test";

// Mock config modules
mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "sl-si"],
	default_locale: "sl-si",
	locale_names: { "en-us": "English", "sl-si": "Slovenian" },
	active_locales: ["en-us", "sl-si"],
	locale_aliases: {},
}));

const { MAIN_APP_POSIX } = await import("$config/paths");
const main_app_win = MAIN_APP_POSIX.replaceAll("/", "\\");

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
		const result = route.route_namespace_from_dir(`/project/${MAIN_APP_POSIX}/auth/login`);
		expect(result).toBe("auth/login");
	});

	test("extracts from Windows-style path", () => {
		const result = route.route_namespace_from_dir(`C:\\project\\${main_app_win}\\home`);
		expect(result).toBe("home");
	});

	test("extracts namespace with multiple segments", () => {
		const result = route.route_namespace_from_dir(`/app/${MAIN_APP_POSIX}/admin/users/list`);
		expect(result).toBe("admin/users/list");
	});

	test("throws when path is not under the main app root", () => expect(() => route.route_namespace_from_dir("/some/other/path")).toThrow("route_namespace_from_dir"));
});

describe("route - get_locale_from_request", () => {
	// Helper to create a mock Request-like object for the BunRequest type
	function mock_req(headers: Record<string, string>): any { return { headers: new Map(Object.entries(headers)) }; }

	test("reads x-locale header", () => {
		const req = mock_req({ "x-locale": "sl-si" });
		expect(route.get_locale_from_request(req)).toBe("sl-si");
	});

	test("returns undefined when no header", () => {
		const req = mock_req({});
		expect(route.get_locale_from_request(req)).toBeUndefined();
	});

	test("canonicalizes casing", () => {
		const req = mock_req({ "x-locale": "EN-us" });
		expect(route.get_locale_from_request(req)).toBe("en-us");
	});

	test("returns default_locale for unsupported locale", () => {
		const req = mock_req({ "x-locale": "de-de" });
		// default is "sl-si" from the mock
		expect(route.get_locale_from_request(req)).toBe("sl-si");
	});
});
