import { describe, expect, mock, test } from "bun:test";
import type { BunRequest } from "bun";

mock.module("$lib/request_context", () => ({
	create_ctx: async () => ({ translations: { errors: {} } }),
}));

mock.module("$config/db", () => ({
	db: async () => [],
	DB_CONNECTION_STRING: "sqlite:test.db",
	DATE_TZ: "UTC",
	TIME_TZ: "UTC",
	DATETIME_TZ: "UTC",
	TIMESTAMP_TZ: "UTC",
}));

mock.module("$platform/auth/middleware", () => ({
	resolve_session: async () => ({ session_id: null, session: null, current_user: null }),
	require_auth: () => Response.redirect("/login", 303),
	require_module: () => new Response("Forbidden", { status: 403 }),
	has_module: (modules_tags: string | null | undefined, module_code: string) => (modules_tags || "").split(/[\s,]+/).filter(Boolean).includes(module_code),
}));

const { build_invite_email, get_auth_invite, get_auth_invite_confirm, is_valid_username, post_auth_invite, post_auth_invite_validate } = await import("./index");

function make_request(path: string, method = "GET"): BunRequest {
	return new Request(`http://localhost${path}`, { method }) as BunRequest;
}

describe("auth/invite authorization", () => {
	test("redirects an anonymous GET /invite request to login", async () => {
		const response = await get_auth_invite(make_request("/invite"));

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("/login");
	});

	test("redirects an anonymous POST /invite request to login", async () => {
		const response = await post_auth_invite(make_request("/invite", "POST"));

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("/login");
	});

	test("redirects an anonymous POST /invite/validate request to login", async () => {
		const response = await post_auth_invite_validate(make_request("/invite/validate", "POST"));

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("/login");
	});

	test("redirects an anonymous invitation confirmation request to login", async () => {
		const response = await get_auth_invite_confirm(make_request("/invite/confirm/test-token"));

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("/login");
	});
});

describe("is_valid_username", () => {
	test("accepts lowercase letters, numbers, underscores, and hyphens", () => {
		expect(is_valid_username("jane_doe-42")).toBe(true);
	});

	test("rejects HTML-special characters", () => {
		expect(is_valid_username("<img src=x onerror=alert(1)>")).toBe(false);
	});

	test("rejects uppercase letters (usernames are lowercased first)", () => {
		expect(is_valid_username("JaneDoe")).toBe(false);
	});

	test("rejects empty and whitespace-only values", () => {
		expect(is_valid_username("")).toBe(false);
		expect(is_valid_username("jane doe")).toBe(false);
	});
});

describe("build_invite_email", () => {
	test("interpolates username and URL into the plain-text body", () => {
		const { body } = build_invite_email("Hi {username},\nGo to {url}", "jane", "https://example.com/confirm/abc");
		expect(body).toBe("Hi jane,\nGo to https://example.com/confirm/abc");
	});

	test("HTML-escapes the username in the HTML variant", () => {
		const { html } = build_invite_email("Hi {username}", "<img src=x onerror=alert(1)>", "https://example.com/confirm/abc");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img");
	});

	test("converts newlines to <br> in the HTML variant", () => {
		const { html } = build_invite_email("Hi {username},\n\nComplete here:\n{url}", "jane", "https://example.com");
		expect(html).toBe("<p>Hi jane,<br><br>Complete here:<br>https://example.com</p>");
	});
});
