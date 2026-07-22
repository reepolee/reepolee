import { describe, expect, test } from "bun:test";

import { build_clear_cookie, build_session_cookie, SESSION_COOKIE_NAME, get_session_id_from_request, should_secure_session_cookie } from "./cookies";

describe("auth/cookies.build_session_cookie", () => {
	test("builds cookie with correct name and value", () => {
		const session_id = "session_abc123";
		const cookie = build_session_cookie(session_id);

		expect(cookie.name).toBe(SESSION_COOKIE_NAME);
		expect(cookie.value).toBe(session_id);
	});

	test("sets HttpOnly flag", () => {
		const cookie = build_session_cookie("test_id");

		expect(cookie.httpOnly).toBe(true);
	});

	test("sets Secure outside development", () => {
		const cookie = build_session_cookie("test_id");

		expect(cookie.secure).toBe(true);
	});

	test("sets SameSite=Lax", () => {
		const cookie = build_session_cookie("test_id");

		expect(cookie.sameSite).toBe("lax");
	});

	test("sets Path=/", () => {
		const cookie = build_session_cookie("test_id");

		expect(cookie.path).toBe("/");
	});

	test("sets MaxAge to 7 days in seconds", () => {
		const cookie = build_session_cookie("test_id");
		const seven_days_seconds = 60 * 60 * 24 * 7;

		expect(cookie.maxAge).toBe(seven_days_seconds);
	});
});

describe("auth/cookies.build_clear_cookie", () => {
	test("builds cookie with empty value", () => {
		const cookie = build_clear_cookie();

		expect(cookie.name).toBe(SESSION_COOKIE_NAME);
		expect(cookie.value).toBe("");
	});

	test("sets MaxAge to 0 (immediate expiry)", () => {
		const cookie = build_clear_cookie();

		expect(cookie.maxAge).toBe(0);
	});

	test("sets HttpOnly flag", () => {
		const cookie = build_clear_cookie();

		expect(cookie.httpOnly).toBe(true);
	});

	test("sets Secure outside development", () => {
		const cookie = build_clear_cookie();

		expect(cookie.secure).toBe(true);
	});

	test("sets SameSite=Lax", () => {
		const cookie = build_clear_cookie();

		expect(cookie.sameSite).toBe("lax");
	});

	test("sets Path=/", () => {
		const cookie = build_clear_cookie();

		expect(cookie.path).toBe("/");
	});
});

describe("auth/cookies exports", () => {
	test("allows non-Secure session cookies only in development", () => {
		expect(should_secure_session_cookie(true)).toBe(false);
		expect(should_secure_session_cookie(false)).toBe(true);
	});

	test("exports get_session_id_from_request", () => expect(typeof get_session_id_from_request).toBe("function"));

	test("exports SESSION_COOKIE_NAME", () => {
		expect(typeof SESSION_COOKIE_NAME).toBe("string");
		expect(SESSION_COOKIE_NAME).toBe("sid");
	});
});
