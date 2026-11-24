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

// A response may now carry two Set-Cookie headers (csrf_token + csrf_sid), so
// tests pick the one they mean instead of reading the joined header.
function set_cookie(res: Response, name: string): string | undefined { return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)); }

function cookie_value(res: Response, name: string): string | undefined {
	const raw = set_cookie(res, name);
	if (!raw) return undefined;
	return decodeURIComponent(raw.slice(name.length + 1).split(";")[0]!);
}

/**
 * Obtain a real signed token the way a browser does - via a GET through the
 * middleware - and the cookie header to send it back with.
 *
 * Tokens are signed and bound now, so a test cannot invent one: an arbitrary
 * string in both the cookie and the field is exactly the forgery the scheme
 * exists to reject.
 */
async function issue_token(session_cookie?: string): Promise<{ token: string; anon: string; cookies: string; }> {
	const res = await csrf_mw_real([])(make_req("GET", "/form", session_cookie) as any, make_next());
	const token = cookie_value(res, "csrf_token")!;
	const anon = cookie_value(res, "csrf_sid")!;
	const parts = [session_cookie, `csrf_sid=${anon}`, `csrf_token=${token}`].filter(Boolean);
	return { token, anon, cookies: parts.join("; ") };
}

describe("csrf_mw: GET requests (safe method)", () => {
	test("GET without CSRF cookie generates new token and sets cookie", async () => {
		const mw = csrf_mw_real([]);
		const req = make_req("GET", "/path");
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
		const csrf_cookie = set_cookie(res, "csrf_token");
		expect(csrf_cookie).toBeTruthy();
		expect(csrf_cookie).toContain("SameSite=Strict");
		// Readable by the client - forms and fetch callers echo it back.
		expect(csrf_cookie).not.toContain("HttpOnly");
	});

	test("GET without CSRF cookie also issues the anonymous binding id", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const req = make_req("GET", "/path");

		const res = await mw(req as any, make_next());

		// Nothing client-side derives from this, so it is HttpOnly.
		const sid_cookie = set_cookie(res, "csrf_sid");
		expect(sid_cookie).toContain("csrf_sid=token_1");
		expect(sid_cookie).toContain("HttpOnly");
	});

	test("GET with a still-valid CSRF cookie reuses it, no new csrf_token cookie", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);

		// First GET establishes both cookies.
		const first = await mw(make_req("GET", "/path") as any, make_next());
		const token = cookie_value(first, "csrf_token")!;
		const anon = cookie_value(first, "csrf_sid")!;

		const req = make_req("GET", "/path", `csrf_token=${token}; csrf_sid=${anon}`);
		const res = await mw(req as any, make_next());

		expect(res.status).toBe(200);
		expect(res.headers.getSetCookie()).toEqual([]);
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

		const res = await mw(req as any, next);

		// The header the templates read must be the token that was just issued.
		expect(captured_req.headers.get("X-CSRF-Token")).toBe(cookie_value(res, "csrf_token"));
	});
});

describe("csrf_mw: POST requests (state-changing, with valid token)", () => {
	test("POST with matching form-encoded CSRF token succeeds", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const { token, cookies } = await issue_token();
		const req = make_req(
			"POST",
			"/api/action",
			cookies,
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
		const { token, cookies } = await issue_token();
		const req = make_req(
			"POST",
			"/api/action",
			cookies,
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
		const { token, cookies } = await issue_token();
		const req = new Request(
			"http://localhost/api/action",
			{
				method: "POST",
				headers: {
					cookie: cookies,
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
		// A binding identity is present, so this reaches the signature check
		// rather than the earlier missing-cookie guard.
		const req = make_req("POST", "/api/action", "csrf_sid=a_browser; csrf_token=correct_token", { _csrf_token: "wrong_token" });
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
		const { token, cookies } = await issue_token();
		const req = make_req("PUT", "/api/resource", cookies, { _csrf_token: token });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("PATCH requires CSRF token", async () => {
		const mw = csrf_mw_real([]);
		const { token, cookies } = await issue_token();
		const req = make_req("PATCH", "/api/resource", cookies, { _csrf_token: token });
		const next = make_next();

		const res = await mw(req as any, next);

		expect(res.status).toBe(200);
	});

	test("DELETE requires CSRF token", async () => {
		const mw = csrf_mw_real([]);
		const { token, cookies } = await issue_token();
		const req = make_req("DELETE", "/api/resource", cookies, { _csrf_token: token });
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

// ---------------------------------------------------------------------------
// Signed tokens - the properties the pre-Bun.CSRF scheme did not have
// ---------------------------------------------------------------------------

function post_with(token: string, cookie: string): any {
	return make_req("POST", "/api/action", cookie, { _csrf_token: token }, "application/json");
}

describe("csrf_mw: signed token binding", () => {
	test("a token issued under session A is rejected for session B", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);

		// Session A obtains a token.
		const res_a = await mw(make_req("GET", "/form", "sid=session_A") as any, make_next());
		const token_a = cookie_value(res_a, "csrf_token")!;

		// It works for session A...
		const ok = await mw(post_with(token_a, `sid=session_A; csrf_token=${token_a}`) as any, make_next());
		expect(ok.status).toBe(200);

		// ...and not for session B, even though B presents it as its own cookie.
		// This is the property the uuid-in-a-cookie scheme lacked, and with no
		// legacy fallback there is nothing left that would admit it.
		const denied = await mw(post_with(token_a, `sid=session_B; csrf_token=${token_a}`) as any, make_next());
		expect(denied.status).toBe(403);
	});

	test("a forged token is rejected even when it matches the cookie", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		// Cookie-equality is exactly what the old scheme checked. Nothing accepts
		// it any more.
		const forged = "attacker-chosen-value";
		const res = await mw(post_with(forged, `sid=session_A; csrf_token=${forged}`) as any, make_next());
		expect(res.status).toBe(403);
	});

	test("an anonymous token stays valid once the user has a session", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);

		// Anonymous GET (a login form) binds the token to csrf_sid.
		const res = await mw(make_req("GET", "/login") as any, make_next());
		const token = cookie_value(res, "csrf_token")!;
		const anon = cookie_value(res, "csrf_sid")!;

		// After login the request carries a sid too. The token must survive, or
		// every form rendered before login would 403.
		const after = await mw(post_with(token, `sid=fresh_session; csrf_sid=${anon}; csrf_token=${token}`) as any, make_next());
		expect(after.status).toBe(200);
	});

	test("a token from another browser is rejected for an anonymous request", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);

		const victim = await mw(make_req("GET", "/login") as any, make_next());
		const victim_token = cookie_value(victim, "csrf_token")!;

		const attacker = await mw(make_req("GET", "/login") as any, make_next());
		const attacker_anon = cookie_value(attacker, "csrf_sid")!;

		const res = await mw(post_with(victim_token, `csrf_sid=${attacker_anon}; csrf_token=${victim_token}`) as any, make_next());
		expect(res.status).toBe(403);
	});
});

describe("csrf_mw: no legacy fallback", () => {
	test("an unsigned pre-upgrade token is rejected even when it matches the cookie", async () => {
		token_counter = 0;
		const mw = csrf_mw_real([]);
		const legacy = "pre_upgrade_uuid_token";

		// The app has no public users, so there is no dual-accept window and no
		// code path that would honour this. It costs one 403 and the next GET
		// hands the browser a fresh signed token.
		const res = await mw(post_with(legacy, `csrf_sid=some_browser; csrf_token=${legacy}`) as any, make_next());

		expect(res.status).toBe(403);
	});
});

describe("require_valid_csrf: shared by the upload endpoints", () => {
	test("the upload endpoints use the same implementation as the middleware", async () => {
		const from_middleware = await import("./csrf");
		const from_uploads = await import("$lib/upload_endpoints");

		// Not merely equivalent - the same function. A second copy is what let
		// the two paths drift before.
		expect(from_uploads.require_valid_csrf).toBe(from_middleware.require_valid_csrf);
	});

	test("accepts a signed token bound to the posting session", async () => {
		token_counter = 0;
		const { require_valid_csrf } = await import("./csrf");
		const res = await csrf_mw_real([])(make_req("GET", "/form", "sid=session_A") as any, make_next());
		const token = cookie_value(res, "csrf_token")!;

		const req = post_with(token, `sid=session_A; csrf_token=${token}`);

		expect(await require_valid_csrf(req)).toBeNull();
	});

	test("rejects a token bound to a different session", async () => {
		token_counter = 0;
		const { require_valid_csrf } = await import("./csrf");
		const res = await csrf_mw_real([])(make_req("GET", "/form", "sid=session_A") as any, make_next());
		const token = cookie_value(res, "csrf_token")!;

		const req = post_with(token, `sid=session_B; csrf_token=${token}`);

		const denied = await require_valid_csrf(req);
		expect(denied?.status).toBe(403);
	});

	test("rejects a request carrying no token at all", async () => {
		const { require_valid_csrf } = await import("./csrf");
		const req = make_req("POST", "/upload/image/save");

		const denied = await require_valid_csrf(req);
		expect(denied?.status).toBe(403);
	});
});
