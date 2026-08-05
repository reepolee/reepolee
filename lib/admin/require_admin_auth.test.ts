import { afterAll, describe, expect, test } from "bun:test";

// Mock Bun.env for require_admin_auth
const original_env = { ...Bun.env };

const admin = await import("./require_admin_auth");

describe("require_admin_auth", () => {
	test("returns 404 when internal endpoints are disabled", async () => {
		delete (Bun.env as any).INTERNAL_ADMIN_ENDPOINTS;
		delete (Bun.env as any).RELOAD_SECRET;
		const req = new Request(
			"http://localhost/__test",
		);
		const result = admin.require_admin_auth(req, "test");
		expect(result.ok).toBe(false);
		if (!result.ok) { expect(result.response.status).toBe(404); }
	});

	test("returns ok:true when endpoints are enabled and the header matches a strong secret", () => {
		(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
		(Bun.env as any).RELOAD_SECRET = "a".repeat(32);
		const req = new Request(
			"http://localhost/__test",
			{ headers: { "X-Reload-Secret": "a".repeat(32) } },
		);
		const result = admin.require_admin_auth(req, "test");
		expect(result.ok).toBe(true);
		if (result.ok) { expect(result.caller).toBe("localhost"); }
	});

	test("returns 401 when header does not match secret", async () => {
		(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
		(Bun.env as any).RELOAD_SECRET = "a".repeat(32);
		const req = new Request(
			"http://localhost/__test",
			{ headers: { "X-Reload-Secret": "wrong-secret" } },
		);
		const result = admin.require_admin_auth(req, "test");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.response.status).toBe(401);
			const body = await result.response.text();
			expect(body).toBe("Unauthorized");
		}
	});

	test("returns 401 when no header provided and secret is set", () => {
		(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
		(Bun.env as any).RELOAD_SECRET = "a".repeat(32);
		const req = new Request(
			"http://localhost/__test",
		);
		const result = admin.require_admin_auth(req, "test");
		expect(result.ok).toBe(false);
	});

	test("returns 401 when endpoints are enabled without a strong secret", () => {
		(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
		(Bun.env as any).RELOAD_SECRET = "too-short";
		const req = new Request("http://localhost/__test");
		const result = admin.require_admin_auth(req, "test");

		expect(result.ok).toBe(false);
		if (!result.ok) { expect(result.response.status).toBe(401); }
	});

	test("extracts caller from X-Forwarded-For when available", () => {
		(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
		(Bun.env as any).RELOAD_SECRET = "a".repeat(32);
		const req = new Request(
			"http://localhost/__test",
			{ headers: { "X-Forwarded-For": "203.0.113.42", "X-Reload-Secret": "a".repeat(32) } },
		);
		const result = admin.require_admin_auth(req, "test");
		expect(result.ok).toBe(true);
		if (result.ok) { expect(result.caller).toBe("203.0.113.42"); }
	});

	test("extracts caller from X-Real-IP as fallback", () => {
		(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
		(Bun.env as any).RELOAD_SECRET = "a".repeat(32);
		const req = new Request(
			"http://localhost/__test",
			{ headers: { "X-Real-IP": "10.0.0.5", "X-Reload-Secret": "a".repeat(32) } },
		);
		const result = admin.require_admin_auth(req, "test");
		expect(result.ok).toBe(true);
		if (result.ok) { expect(result.caller).toBe("10.0.0.5"); }
	});

	test("logs action name in error message", () => {
		(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
		(Bun.env as any).RELOAD_SECRET = "a".repeat(32);
		const req = new Request(
			"http://localhost/__test",
			{ headers: { "X-Reload-Secret": "wrong" } },
		);
		// This test just verifies the function doesn't throw
		const result = admin.require_admin_auth(req, "my-action");
		expect(result.ok).toBe(false);
	});
});

// Restore original env.
afterAll(() => {
	for (const name of ["INTERNAL_ADMIN_ENDPOINTS", "RELOAD_SECRET"]) {
		const original_value = original_env[name];
		if (original_value === undefined) delete (Bun.env as any)[name];
		else (Bun.env as any)[name] = original_value;
	}
});
