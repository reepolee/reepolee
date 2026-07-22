import { describe, expect, mock, test } from "bun:test";

import type { RequestContext } from "$lib/request_context";
import { mock_db } from "$root/test_helpers";

mock.module("$config/db", mock_db);

const { resolve_session_variables, SESSION_VARIABLE_PATHS } = await import("./global_scopes");

// ---------------------------------------------------------------------------
// Mock RequestContext factory
// ---------------------------------------------------------------------------

function mock_ctx(userOverrides?: Partial<{
	id: number;
	email: string;
	name: string;
	nickname: string;
	username: string;
	modules_tags: string;
}>): RequestContext {
	return {
		req: {} as any,
		lang: "en",
		user: {
			id: 1,
			email: "ales@example.com",
			name: "Aleš Novak",
			nickname: "ales",
			username: "ales_n",
			modules_tags: "admin,editor,user",
			...userOverrides,
		},
	} as RequestContext;
}

function mock_ctx_no_user(): RequestContext {
	return { req: {} as any, lang: "en", user: null } as RequestContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolve_session_variables", () => {
	// --- No :: tokens ---

	test("passthrough: clause without ::", () => {
		const result = resolve_session_variables("author_id = 1");
		expect(result).toBe("author_id = 1");
	});

	test("passthrough: clause with :: but not ::session", () => {
		const result = resolve_session_variables("value IN (::other.global)");
		expect(result).toBe("value IN (::other.global)");
	});

	test("passthrough: clause with :: between unrelated colons (like ::hover CSS)", () => {
		const result = resolve_session_variables("class LIKE '%::hover%'");
		expect(result).toBe("class LIKE '%::hover%'");
	});

	// --- Fail-loud ---

	test("fail-loud: returns 1=0 when ctx is undefined", () => {
		const result = resolve_session_variables("author_id = ::session.user.id");
		expect(result).toBe("1=0");
	});

	test("fail-loud: returns 1=0 when ctx.user is null", () => {
		const ctx = mock_ctx_no_user();
		const result = resolve_session_variables("author_id = ::session.user.id", ctx);
		expect(result).toBe("1=0");
	});

	// --- Number variable ---

	test("resolves ::session.user.id to bare number", () => {
		const ctx = mock_ctx();
		const result = resolve_session_variables("author_id = ::session.user.id", ctx);
		expect(result).toBe("author_id = 1");
	});

	test("resolves ::session.user.id to bare number in compound expression", () => {
		const ctx = mock_ctx();
		// Variables are delimited by space - put space before closing paren
		const result = resolve_session_variables("(author_id = ::session.user.id OR reviewer_id = ::session.user.id )", ctx);
		expect(result).toBe("(author_id = 1 OR reviewer_id = 1 )");
	});

	// --- String variables ---

	test("resolves ::session.user.email to quoted string", () => {
		const ctx = mock_ctx();
		const result = resolve_session_variables("email = ::session.user.email", ctx);
		expect(result).toBe("email = 'ales@example.com'");
	});

	test("resolves ::session.user.name to quoted string (Unicode)", () => {
		const ctx = mock_ctx();
		const result = resolve_session_variables("name = ::session.user.name", ctx);
		expect(result).toBe("name = 'Aleš Novak'");
	});

	test("resolves ::session.user.username to quoted string", () => {
		const ctx = mock_ctx();
		const result = resolve_session_variables("username = ::session.user.username", ctx);
		expect(result).toBe("username = 'ales_n'");
	});

	// --- modules_tags ---

	test("resolves ::session.user.modules_tags to comma-separated quoted string", () => {
		const ctx = mock_ctx();
		// Variables are delimited by space - put space before closing paren
		const result = resolve_session_variables("FIND_IN_SET('admin', ::session.user.modules_tags )", ctx);
		expect(result).toBe("FIND_IN_SET('admin', 'admin,editor,user' )");
	});

	// --- SQL injection / escaping ---

	test("escapes single quotes in session values (SQL injection prevention)", () => {
		const ctx = mock_ctx({ name: "O'Brien" });
		const result = resolve_session_variables("name = ::session.user.name", ctx);
		expect(result).toBe("name = 'O''Brien'");
	});

	test("escapes multiple single quotes in session values", () => {
		const ctx = mock_ctx({ name: "' OR '1'='1" });
		const result = resolve_session_variables("name = ::session.user.name", ctx);
		expect(result).toBe("name = ''' OR ''1''=''1'");
	});

	// --- Unknown / missing variables ---

	test("unknown ::session.variable resolves to NULL with warning", () => {
		const ctx = mock_ctx();
		const result = resolve_session_variables("x = ::session.user.unknown", ctx);
		expect(result).toBe("x = NULL");
	});

	test("null field value resolves to NULL", () => {
		const ctx = mock_ctx({ nickname: null as any });
		const result = resolve_session_variables("nick = ::session.user.nickname", ctx);
		expect(result).toBe("nick = NULL");
	});

	test("null modules_tags resolves to NULL", () => {
		const ctx = mock_ctx({ modules_tags: null as any });
		const result = resolve_session_variables("tags = ::session.user.modules_tags", ctx);
		expect(result).toBe("tags = NULL");
	});

	// --- Mixed with regular SQL ---

	test("resolves ::session tokens alongside literals and operators", () => {
		const ctx = mock_ctx();
		const result = resolve_session_variables("status = 'active' AND created_by = ::session.user.id", ctx);
		expect(result).toBe("status = 'active' AND created_by = 1");
	});

	test("resolves ::session.token in a complex WHERE clause", () => {
		const ctx = mock_ctx();
		// Variables are delimited by space - put space before closing paren
		const result = resolve_session_variables("(department_id = 5 OR department_id = ::session.user.id ) AND is_active = 1", ctx);
		expect(result).toBe("(department_id = 5 OR department_id = 1 ) AND is_active = 1");
	});

	// --- SESSION_VARIABLE_PATHS export ---

	test("SESSION_VARIABLE_PATHS contains all expected variable paths", () => expect(SESSION_VARIABLE_PATHS).toEqual([
		"session.user.id",
		"session.user.email",
		"session.user.name",
		"session.user.nickname",
		"session.user.username",
		"session.user.modules_tags",
	]));

	describe("resolve_session_variables - edge cases", () => {
		test("handles ::session at end of string", () => {
			const ctx = mock_ctx();
			const result = resolve_session_variables("department_id = ::session.user.id", ctx);
			expect(result).toBe("department_id = 1");
		});

		test("handles multiple ::session variables in one clause", () => {
			const ctx = mock_ctx();
			const result = resolve_session_variables("created_by = ::session.user.id AND reviewer = ::session.user.id", ctx);
			expect(result).toBe("created_by = 1 AND reviewer = 1");
		});
	});
});
