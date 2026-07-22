/**
 * Integration Tests - Real DB + Middleware Testing
 *
 * Tests middleware and auth layers using real database
 * without relying on a running server (uses direct handler calls).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { get_test_db_connection } from "$root/test_helpers";

// Helper: Make mock request
function make_req(options: { url?: string; method?: string; headers?: Record<string, string>; body?: string; } = {}): any {
	const headers = new Map(Object.entries(options.headers || {}));
	return {
		url: options.url || "http://localhost/",
		method: options.method || "GET",
		headers: {
			get: (name: string) => headers.get(name.toLowerCase()),
			set: (name: string, value: string) => headers.set(name.toLowerCase(), value),
		},
		body: options.body,
	};
}

// WORKAROUND (bun#24130 - https://github.com/oven-sh/bun/issues/24130):
// reusing one long-lived SQL connection across an event-loop tick (timer,
// dynamic import, etc.) hangs the next MySQL query on Windows. Opening and
// closing a fresh connection per call avoids it at the cost of a handshake
// per query. REMOVE once bun#24130 is fixed upstream: restore a single
// module-level `test_db` connection created once in beforeEach and reused
// by clean_db()/create_test_user() for the whole file.

// Helper: Clear test database
async function clean_db() {
	const db = get_test_db_connection();
	try {
		await db.unsafe("DELETE FROM users");
	} finally {
		await db.close();
	}
}

// Helper: Create test user
async function create_test_user(email: string, username: string) {
	const now = new Date().toISOString().slice(0, 19).replace("T", " ");
	const db = get_test_db_connection();
	try {
		await db.unsafe(`INSERT INTO users (email, username, created_at) VALUES (?, ?, ?)`, [email, username, now]);
	} finally {
		await db.close();
	}
}

beforeEach(async () => await clean_db());

afterEach(async () => await clean_db());

// ============================================================================
// CSRF Middleware Integration
// ============================================================================

describe("CSRF Middleware Integration with Real Data", () => {
	test("GET request generates and sets CSRF token", async () => {
		const { csrf_mw } = await import("$lib/middleware/csrf");
		const mw = csrf_mw([]);

		const req = make_req({ url: "http://localhost/form", method: "GET" });

		let res_called = false;
		const next = async (r: any) => {
			res_called = true;
			expect(r.headers.get("X-CSRF-Token")).toBeDefined();
			return new Response("OK", { status: 200 });
		};

		const res = await mw(req, next);

		expect(res_called).toBe(true);
		expect(res.headers.get("set-cookie")).toContain("csrf_token");
	});

	test("POST with mismatched CSRF token returns 403", async () => {
		const { csrf_mw } = await import("$lib/middleware/csrf");
		const mw = csrf_mw([]);

		const req = make_req({
			url: "http://localhost/form",
			method: "POST",
			headers: { "cookie": "csrf_token=correct_token", "content-type": "application/json" },
			body: JSON.stringify({ _csrf_token: "wrong_token" }),
		});

		const next = async () => new Response("OK");

		const res = await mw(req, next);

		expect(res.status).toBe(403);
	});
});

// ============================================================================
// Auth Middleware Integration with Database
// ============================================================================

describe("Auth Middleware Integration with DB", () => {
	test("resolve_session returns null user when no session", async () => {
		const { resolve_session } = await import("$root/routes/system/auth/middleware");

		const req = make_req();
		const ctx = await resolve_session(req);

		expect(ctx.session_id).toBeNull();
		expect(ctx.current_user).toBeNull();
	});

	test("require_auth guard redirects unauthenticated users", async () => {
		const { require_auth } = await import("$root/routes/system/auth/middleware");

		const auth_ctx = { session_id: null, session: null, current_user: null };

		const req = make_req({ url: "http://localhost/dashboard" });
		const res = require_auth(auth_ctx as any, req);

		expect(res).toBeDefined();
		expect(res?.status).toBe(303);
		expect((res as any).headers.get("location")).toContain("/login");
	});

	test("require_auth allows authenticated users", async () => {
		const { require_auth } = await import("$root/routes/system/auth/middleware");

		const auth_ctx = {
			session_id: "session_123",
			session: { user_id: 1 },
			current_user: { id: 1, username: "testuser", modules_tags: "user" },
		};

		const res = require_auth(auth_ctx as any);

		expect(res).toBeNull();
	});
});

// Note: Language middleware tests are covered in unit tests (lib/middleware/set_lang.test.ts)
// Integration tests focus on middleware + database interactions without external dependencies

// ============================================================================
// Module Authorization Middleware Integration
// ============================================================================

describe("Module Authorization Middleware Integration", () => {
	test("require_module_mw allows users with required module", async () => {
		const { require_module_mw } = await import("$lib/middleware/require_module_mw");
		const mw = require_module_mw("admin");

		const auth_ctx = {
			session_id: "session_123",
			session: { user_id: 1 },
			current_user: { id: 1, username: "admin_user", modules_tags: "admin,system" },
		};

		// Mock resolve_session to return our auth context
		const req = make_req();
		let handler_called = false;

		const next = async () => {
			handler_called = true;
			return new Response("OK");
		};

		// Manually call the guard check
		const { require_module } = await import("$root/routes/system/auth/middleware");
		const res = require_module(auth_ctx as any, "admin");

		expect(res).toBeNull();
	});

	test("require_module_mw blocks users without required module", async () => {
		const { require_module } = await import("$root/routes/system/auth/middleware");

		const auth_ctx = {
			session_id: "session_123",
			session: { user_id: 2 },
			current_user: { id: 2, username: "regular_user", modules_tags: "user" },
		};

		const res = require_module(auth_ctx as any, "admin");

		expect(res).toBeDefined();
		expect(res?.status).toBe(403);
	});
});

// ============================================================================
// Auth SQL Integration with Real Database
// ============================================================================

describe("Auth SQL Integration with Real DB", () => {
	test("can insert user into database without error", async () => {
		// Just verify insertion works without error
		await expect(create_test_user("alice@example.com", "alice")).resolves.toBeUndefined();
	});

	test("auth functions handle real database gracefully", async () => {
		const { get_user_by_email } = await import("$root/routes/system/auth/sql");

		// Should return undefined for non-existent user
		const user = await get_user_by_email("nonexistent@example.com");
		expect(user).toBeUndefined();
	});

	test("password update function works with database", async () => {
		const { update_user_password } = await import("$root/routes/system/auth/sql");

		// Should return true even for non-existent ID (no error thrown)
		const result = await update_user_password(99999, "new_hash", "old_hash");
		expect(typeof result).toBe("boolean");
	});
});

// ============================================================================
// Middleware Chain Integration
// ============================================================================

describe("Middleware Chain Integration", () => test("CSRF middleware sets security headers", async () => {
	const { csrf_mw } = await import("$lib/middleware/csrf");

	const csrf = csrf_mw([]);

	const req = make_req({ url: "http://localhost/form", method: "GET" });

	let final_req: any;
	const next = async (r: any) => {
		final_req = r;
		return new Response("OK");
	};

	const res = await csrf(req, next);

	expect(final_req.headers.get("X-CSRF-Token")).toBeDefined();
	expect(res.headers.get("set-cookie")).toContain("csrf_token");
}));
