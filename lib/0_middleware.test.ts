import { describe, expect, mock, test } from "bun:test";
import type { BunRequest } from "bun";

// Mock session_store to test middleware with mocked sessions
mock.module("$root/routes/system/auth/session_store", () => ({
	get_session: async (session_id: string) => {
		if (session_id === "valid_session") {
			return {
				user_id: 1,
				email: "user@example.com",
				name: "John Doe",
				nickname: "john",
				username: "johndoe",
				avatar_filename: "avatar.jpg",
				display_name: "john",
				modules_tags: "user,admin",
				created_at: Date.now(),
			};
		}
		if (session_id === "invalid_session") { return null; }
		return null;
	},
}));

// resolve_session re-reads the live user by id so authorization reflects the DB
// (a deleted user invalidates the session, module changes apply immediately).
// Mock $config/db so get_user_by_id returns a live row without a real DB, and
// keep it scoped: restore after this file so the tagged-template db doesn't
// leak into other test files (bun#12823).
mock.module("$config/db", () => ({
	db: (strings: TemplateStringsArray, ...values) => {
		const sql = strings.join("?");
		// get_user_by_id issues "... WHERE id = ? LIMIT 1"
		if (sql.includes("WHERE id =")) {
			return Promise.resolve(values[0] === 1 ? [{ id: 1, modules_tags: "user,admin" }] : []);
		}
		return Promise.resolve([]);
	},
	DATE_TZ: "UTC",
	TIME_TZ: "UTC",
	DATETIME_TZ: "UTC",
	TIMESTAMP_TZ: "UTC",
}));

const { resolve_session, require_auth, require_module } = await import("$root/routes/system/auth/middleware");

function make_req(session_id?: string): any {
	const cookies = session_id ? `sid=${encodeURIComponent(session_id)}` : "";
	return {
		url: "http://localhost/dashboard",
		headers: new Map([["cookie", cookies]]) as any,
		headers: {
			get: (name: string) => {
				if (name.toLowerCase() === "cookie") return cookies;
				return null;
			},
		},
	};
}

describe("auth/middleware.resolve_session", () => {
	test("returns null context when no session ID", async () => {
		const req = make_req();
		const ctx = await resolve_session(req);

		expect(ctx.session_id).toBeNull();
		expect(ctx.session).toBeNull();
		expect(ctx.current_user).toBeNull();
	});

	test("returns null context when session ID is invalid", async () => {
		const req = make_req("invalid_session");
		const ctx = await resolve_session(req);

		expect(ctx.session_id).toBe("invalid_session");
		expect(ctx.session).toBeNull();
		expect(ctx.current_user).toBeNull();
	});

	test("returns user context when session is valid", async () => {
		const req = make_req("valid_session");
		const ctx = await resolve_session(req);

		expect(ctx.session_id).toBe("valid_session");
		expect(ctx.session).toBeDefined();
		expect(ctx.session?.user_id).toBe(1);
		expect(ctx.session?.email).toBe("user@example.com");
		expect(ctx.current_user).toBeDefined();
		expect(ctx.current_user?.id).toBe(1);
		expect(ctx.current_user?.email).toBe("user@example.com");
	});

	test("sets display_name from nickname when available", async () => {
		const req = make_req("valid_session");
		const ctx = await resolve_session(req);

		expect(ctx.current_user?.display_name).toBe("john");
	});

	test("sets display_name from name when nickname is not available", async () => {
		const req = make_req("valid_session");
		const ctx = await resolve_session(req);

		expect(ctx.current_user?.display_name).toBe("john");
	});
});

describe("auth/middleware.require_auth", () => {
	test("returns null when user is authenticated", () => {
		const req = make_req();
		const auth_ctx = {
			session_id: "valid",
			session: { user_id: 1 },
			current_user: { id: 1, username: "user" },
		};

		const result = require_auth(auth_ctx as any, req);

		expect(result).toBeNull();
	});

	test("returns redirect when user is not authenticated", () => {
		const req = make_req();
		const auth_ctx = { session_id: null, session: null, current_user: null };

		const result = require_auth(auth_ctx as any, req);

		expect(result).toBeDefined();
		expect(result?.status).toBe(303);
		expect((result as Response).headers.get("location")).toContain("/login");
	});

	test("includes redirect parameter in login URL", () => {
		const req = make_req();
		req.url = "http://localhost/dashboard";
		const auth_ctx = { session_id: null, session: null, current_user: null };

		const result = require_auth(auth_ctx as any, req);

		const location = (result as Response).headers.get("location");
		expect(location).toContain("redirect=");
	});

	test("returns redirect without request", () => {
		const auth_ctx = { session_id: null, session: null, current_user: null };

		const result = require_auth(auth_ctx as any);

		expect(result).toBeDefined();
		expect(result?.status).toBe(303);
		expect((result as Response).headers.get("location")).toContain("/login");
	});
});

describe("auth/middleware.require_module", () => {
	test("returns null when user has required module", () => {
		const auth_ctx = {
			session_id: "valid",
			session: { user_id: 1 },
			current_user: { id: 1, username: "user", modules_tags: "user,admin,editor" },
		};

		const result = require_module(auth_ctx as any, "admin");

		expect(result).toBeNull();
	});

	test("returns 403 when user lacks required module", () => {
		const auth_ctx = {
			session_id: "valid",
			session: { user_id: 1 },
			current_user: { id: 1, username: "user", modules_tags: "user" },
		};

		const result = require_module(auth_ctx as any, "admin");

		expect(result?.status).toBe(403);
	});

	test("returns 403 when no user", () => {
		const auth_ctx = { session_id: null, session: null, current_user: null };

		const result = require_module(auth_ctx as any, "admin");

		expect(result?.status).toBe(403);
	});

	test("handles comma-separated module tags correctly", () => {
		const auth_ctx = {
			session_id: "valid",
			session: { user_id: 1 },
			current_user: { id: 1, username: "user", modules_tags: "reports,analytics,admin" },
		};

		const result = require_module(auth_ctx as any, "analytics");

		expect(result).toBeNull();
	});
});
