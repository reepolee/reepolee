import { describe, expect, mock, test } from "bun:test";
import type { BunRequest } from "bun";

let auth_ctx: { current_user: { id: number; modules_tags: string } | null } = { current_user: null };
let configured = true;
let queued_count = 1;
let queued_user_id: number | null = null;

mock.module("$config/web_push", () => ({
	get_web_push_config: () => configured ? { public_key: "public", private_key: "private", subject: "mailto:test@example.com" } : null,
}));

mock.module("$lib/web_push", () => ({
	queue_web_push_notification: async (user_id: number) => {
		queued_user_id = user_id;
		return queued_count;
	},
	remove_web_push_subscription: async () => {},
	save_web_push_subscription: async () => {},
}));

mock.module("$platform/auth/middleware", () => ({
	resolve_session: async () => auth_ctx,
	require_auth: (ctx: typeof auth_ctx) => ctx.current_user ? null : Response.redirect("/login", 303),
	require_module: (ctx: typeof auth_ctx, module_code: string) => ctx.current_user?.modules_tags.split(/[\s,]+/).includes(module_code) ? null : new Response("Forbidden", { status: 403 }),
	has_module: (modules_tags: string | null | undefined, module_code: string) => (modules_tags || "").split(/[\s,]+/).filter(Boolean).includes(module_code),
}));

const { post_web_push_test } = await import("./index");

function make_request(): BunRequest {
	return new Request("http://localhost/web-push/test", { method: "POST" }) as BunRequest;
}

describe("POST /web-push/test", () => {
	test("redirects anonymous users to login", async () => {
		auth_ctx = { current_user: null };
		const response = await post_web_push_test(make_request());

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe("/login");
	});

	test("rejects users without the admin module", async () => {
		auth_ctx = { current_user: { id: 7, modules_tags: "user" } };
		const response = await post_web_push_test(make_request());

		expect(response.status).toBe(403);
	});

	test("returns not found when Web Push is not configured", async () => {
		auth_ctx = { current_user: { id: 7, modules_tags: "admin" } };
		configured = false;
		const response = await post_web_push_test(make_request());

		expect(response.status).toBe(404);
		configured = true;
	});

	test("queues a test notification for the admin's subscriptions", async () => {
		auth_ctx = { current_user: { id: 42, modules_tags: "admin,user" } };
		queued_count = 2;
		queued_user_id = null;
		const response = await post_web_push_test(make_request());

		expect(response.status).toBe(200);
		const body = await response.json() as { ok: boolean; queued: number };
		expect(body.ok).toBe(true);
		expect(body.queued).toBe(2);
		expect(queued_user_id === 42).toBe(true);
	});
});
