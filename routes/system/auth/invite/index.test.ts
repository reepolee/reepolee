import { describe, expect, mock, test } from "bun:test";
import type { BunRequest } from "bun";

mock.module("$lib/request_context", () => ({
	create_ctx: async () => ({ translations: { errors: {} } }),
}));

mock.module("$config/db", () => ({
	db: async () => [],
	DATE_TZ: "UTC",
	TIME_TZ: "UTC",
	DATETIME_TZ: "UTC",
	TIMESTAMP_TZ: "UTC",
}));

mock.module("$root/routes/system/auth/middleware", () => ({
	resolve_session: async () => ({ session_id: null, session: null, current_user: null }),
	require_auth: () => Response.redirect("/login", 303),
	require_module: () => new Response("Forbidden", { status: 403 }),
}));

const { get_auth_invite, get_auth_invite_confirm, post_auth_invite, post_auth_invite_validate } = await import("./index");

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
