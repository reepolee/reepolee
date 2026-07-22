import { describe, expect, mock, test } from "bun:test";

import type { BunRequest } from "bun";
import { csrf_mw } from "./csrf";

// Mock uuid_v7 for deterministic tests
let token_counter = 0;
function mock_uuid_v7(): string { return `token_${++token_counter}`; }

mock.module("$lib/uuid", () => ({ uuid_v7: mock_uuid_v7 }));

const { csrf_mw: csrf_mw_real } = await import("./csrf");

// Helper to create mock requests
function make_req(
	method: string,
	path: string,
	cookie?: string,
	body?: any,
	content_type = "application/json",
): any {
	const headers = new Headers();
	if (cookie) headers.set("cookie", cookie);
	if (content_type) headers.set("content-type", content_type);

	let req = new Request(
		`http://localhost${path}`,
		{ method, headers },
	);

	if (body && (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
		if (content_type.includes("application/json")) {
			req = new Request(
				`http://localhost${path}`,
				{ method, headers, body: JSON.stringify(body) },
			);
		} else if (content_type.includes("application/x-www-form-urlencoded")) {
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(body)) {
				params.set(k, String(v));
			}
			req = new Request(
				`http://localhost${path}`,
				{ method, headers, body: params.toString() },
			);
		}
	}

	return req;
}

// Mock next handler
function make_next(status = 200, body_text = "OK") { return async (req: BunRequest) => { return new Response(body_text, { status, headers: { "content-type": "text/plain" } }); }; }

describe("csrf_mw: GET requests (safe method)", () => {
	test("GET without CSRF cookie generates new token and sets cookie", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("GET", "/path");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
		const cookie_header = res.headers.get("set-cookie");
		expect(cookie_header).toContain("csrf_token=token_1");
		expect(cookie_header).toContain("SameSite=Strict");
		expect(cookie_header).not.toContain("HttpOnly");
	});

	test("GET with existing CSRF cookie reuses token, no new cookie set", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const req = make_req("GET", "/path", "csrf_token=existing_token");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
		const cookie_header = res.headers.get("set-cookie");
		expect(cookie_header).toBeNull();
	});

	test("GET sets X-CSRF-Token header for templates", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const req = make_req("GET", "/path");
		let captured_req: any;
		const next = async (r: BunRequest) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req as any, next);

		expect(captured_req.headers.get("X-CSRF-Token")).toBe("token_1");
	});
});

describe("csrf_mw: POST requests (state-changing, with valid token)", () => {
	test("POST with matching form-encoded CSRF token succeeds", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const token = "test_token_123";
		const req = make_req(
			"POST",
			"/api/action",
			`csrf_token=${token}`,
			{ _csrf_token: token },
			"application/x-www-form-urlencoded"
		);
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("POST with matching JSON CSRF token succeeds", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const token = "json_token_456";
		const req = make_req(
			"POST",
			"/api/action",
			`csrf_token=${token}`,
			{ _csrf_token: token },
			"application/json"
		);
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("POST with X-CSRF-Token header succeeds", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const token = "header_token_789";
		const req = new Request(
			"http://localhost/api/action",
			{
				method: "POST",
				headers: {
					cookie: `csrf_token=${token}`,
					"X-CSRF-Token": token,
					"content-type": "application/json",
				},
			},
		);
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});
});

describe("csrf_mw: POST requests (state-changing, invalid token)", () => {
	test("POST without CSRF cookie returns 403", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/api/action", undefined, { _csrf_token: "token" });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(403);
		const text = await res.text();
		expect(text).toContain("Missing CSRF token cookie");
	});

	test("POST with mismatched CSRF token returns 403", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/api/action", "csrf_token=correct_token", { _csrf_token: "wrong_token" });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(403);
		const text = await res.text();
		expect(text).toContain("Invalid CSRF token");
	});

	test("POST with missing CSRF token in body returns 403", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/api/action", "csrf_token=token123", { other_field: "value" });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(403);
	});
});

describe("csrf_mw: Validation endpoint bypass", () => {
	test("/login/validate POST skips CSRF validation", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/login/validate", "csrf_token=token", { data: "no csrf" });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("/register/validate POST skips CSRF validation", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/register/validate");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("any /path/validate POST skips CSRF validation", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/custom/form/validate");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});
});

describe("csrf_mw: Static file and special path bypass", () => {
	test("/__static/* paths skip CSRF validation", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/__static/file.js");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("/__assets/* paths skip CSRF validation", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("POST", "/__assets/style.css");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});
});

describe("csrf_mw: additional_skip_paths parameter", () => {
	test("additional_skip_paths are respected", async () => {
		const mw = csrf_mw_real(["/api/webhook", "/internal/hook"]);
		const req1 = make_req("POST", "/api/webhook");
		const req2 = make_req("POST", "/internal/hook");
		const next = make_next();

		const res1 = await mw(req1 as any, next);
		const res2 = await mw(req2 as any, next);

		expect(res1.status).toBe(200);
		expect(res2.status).toBe(200);
	});

	test("paths not in skip list are validated", async () => {
		const mw = csrf_mw_real(["/api/webhook"]);
		const req = make_req("POST", "/api/other");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(403);
	});
});

describe("csrf_mw: HTTP methods", () => {
	test("PUT requires CSRF token", async () => {
		const mw = csrf_mw_real([]);
		const token = "put_token";
		const req = make_req("PUT", "/api/resource", `csrf_token=${token}`, { _csrf_token: token });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("PATCH requires CSRF token", async () => {
		const mw = csrf_mw_real([]);
		const token = "patch_token";
		const req = make_req("PATCH", "/api/resource", `csrf_token=${token}`, { _csrf_token: token });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("DELETE requires CSRF token", async () => {
		const mw = csrf_mw_real([]);
		const token = "del_token";
		const req = make_req("DELETE", "/api/resource", `csrf_token=${token}`, { _csrf_token: token });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("HEAD safe method does not require token", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("HEAD", "/path");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("OPTIONS safe method does not require token", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("OPTIONS", "/path");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});
});

describe("csrf_mw: HTTPS secure flag", () => {
	test("HTTPS URL sets Secure flag on cookie", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const req = new Request(
			"https://localhost/path",
			{ method: "GET" },
		);
		const next = make_next();

		const res = await mw(req as any, next);

		const cookie = res.headers.get("set-cookie");
		expect(cookie).toContain("Secure");
	});

	test("HTTP URL does not set Secure flag", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const req = new Request(
			"http://localhost/path",
			{ method: "GET" },
		);
		const next = make_next();

		const res = await mw(req as any, next);

		const cookie = res.headers.get("set-cookie");
		expect(cookie).not.toContain("Secure");
	});
});
