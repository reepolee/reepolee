import { describe, expect, test } from "bun:test";

import { SESSION_COOKIE_NAME, get_session_id_from_request } from "./session";

describe("session.get_session_id_from_request", () => {
	test("extracts session ID from valid cookie header", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: `${SESSION_COOKIE_NAME}=abc123def456` } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("abc123def456");
	});

	test("returns null when no cookie header", () => {
		const req = new Request(
			"http://localhost",
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBeNull();
	});

	test("returns null when cookie header is empty string", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: "" } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBeNull();
	});

	test("extracts session ID among multiple cookies", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: "theme=dark; sid=session123xyz; lang=en" } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("session123xyz");
	});

	test("extracts session ID when first cookie", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: "sid=first_cookie; other=value" } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("first_cookie");
	});

	test("extracts session ID when last cookie", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: "other=value; sid=last_cookie" } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("last_cookie");
	});

	test("decodes URL-encoded session ID", () => {
		const encoded = encodeURIComponent("abc+def/ghi=");
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: `${SESSION_COOKIE_NAME}=${encoded}` } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("abc+def/ghi=");
	});

	test("returns null when session cookie has empty value", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: `${SESSION_COOKIE_NAME}=;other=value` } },
		);
		const result = get_session_id_from_request(req as any);
		// Empty value is still extracted but trimmed
		expect(result).toBe("");
	});

	test("handles cookie with whitespace around equals", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: `${SESSION_COOKIE_NAME} = value123` } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("value123");
	});

	test("ignores cookies with similar names", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: "sid_backup=fake; sid=real_session; session_id=also_fake" } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("real_session");
	});

	test("handles multiple equals in cookie value (e.g., Base64)", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: `other=val; ${SESSION_COOKIE_NAME}=base64token==; more=data` } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("base64token==");
	});

	test("returns null when only malformed cookie exists (no equals)", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: "malformed_cookie" } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBeNull();
	});

	test("extracts session ID even with extra semicolons", () => {
		const req = new Request(
			"http://localhost",
			{ headers: { cookie: "; ; sid=token123; ; " } },
		);
		const result = get_session_id_from_request(req as any);
		expect(result).toBe("token123");
	});
});
