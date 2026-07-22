import { describe, expect, mock, test } from "bun:test";

// Mock dependencies
mock.module("$config/supported_languages", () => ({
	active_languages: ["en", "es", "fr"],
	default_language: "en",
	language_locales: { en: "en-US", es: "es-ES", fr: "fr-FR" },
}));

// request_context now imports get_toast_cookies from $lib/cookies and
// route_namespace_from_dir from $lib/route directly - both are pure
// header/string parsing, so the real implementations run in these tests.
// The auth middleware mock below intercepts cookies.ts's resolve_session
// import chain before it can reach a real DB connection.
mock.module("$lib/modules", () => ({ get_available_prefixes: () => ["admin", "api", "docs"] }));

mock.module("$root/routes/system/auth/middleware", () => ({
	resolve_session: async (req: any) => {
		// Mock: return authenticated user for specific header
		if (req.headers.get("x-user-id") === "123") {
			return {
				session_id: "sess_123",
				session: { user_id: 123 },
				current_user: {
					id: 123,
					email: "user@example.com",
					username: "testuser",
					display_name: "Test User",
					modules_tags: "admin",
				},
			};
		}
		return { session_id: null, session: null, current_user: null };
	},
	require_auth: () => null,
	require_module: () => null,
}));

import { RequestContext, create_ctx } from "./request_context";

function make_req(options: { url?: string; headers?: Record<string, string>; } = {}): any {
	const headers = new Map(Object.entries(options.headers || {}));
	return {
		url: options.url || "http://localhost/",
		headers: { get: (name: string) => headers.get(name.toLowerCase()) },
	};
}

describe("RequestContext constructor", () => {
	test("initializes with default values", () => {
		const req = make_req();
		const ctx = new RequestContext(req);

		expect(ctx.lang).toBe("en");
		expect(ctx.prefix).toBeNull();
		expect(ctx.user).toBeNull();
		expect(ctx.dark_mode).toBe(false);
		expect(ctx.toasts).toEqual([]);
	});

	test("stores reference to request", () => {
		const req = make_req();
		const ctx = new RequestContext(req);

		expect(ctx.req).toBe(req);
	});
});

describe("create_ctx language detection", () => {
	test("detects language from X-Lang header", async () => {
		const req = make_req({ url: "http://localhost/", headers: { "x-lang": "es" } });

		const ctx = await create_ctx(req);

		expect(ctx.lang).toBe("es");
		expect(ctx.locale).toBe("es-ES");
	});

	test("defaults to default_language when no lang provided", async () => {
		const req = make_req();

		const ctx = await create_ctx(req);

		expect(ctx.lang).toBe("en");
		expect(ctx.locale).toBe("en-US");
	});

	test("prioritizes header over cookie", async () => {
		const req = make_req({ headers: { "x-lang": "fr", "cookie": "lang=es" } });

		const ctx = await create_ctx(req);

		expect(ctx.lang).toBe("fr");
	});

	test("uses cookie language when no header", async () => {
		const req = make_req({ headers: { "cookie": "lang=es" } });

		const ctx = await create_ctx(req);

		expect(ctx.lang).toBe("es");
	});

	test("ignores invalid language in cookie", async () => {
		const req = make_req({ headers: { "cookie": "lang=invalid_lang" } });

		const ctx = await create_ctx(req);

		expect(ctx.lang).toBe("en");
	});

	test("decodes URL-encoded language cookie", async () => {
		const req = make_req({ headers: { "cookie": `lang=${encodeURIComponent("fr")}` } });

		const ctx = await create_ctx(req);

		expect(ctx.lang).toBe("fr");
	});

	test("stores preferred language from X-Lang-Preferred header", async () => {
		const req = make_req({ headers: { "x-lang-preferred": "es" } });

		const ctx = await create_ctx(req);

		expect(ctx.preferred_lang).toBe("es");
	});
});

describe("create_ctx theme detection", () => {
	test("detects dark mode from theme cookie", async () => {
		const req = make_req({ headers: { "cookie": "theme=dark" } });

		const ctx = await create_ctx(req);

		expect(ctx.dark_mode).toBe(true);
		expect(ctx.theme_class).toBe("dark");
	});

	test("detects light mode from theme cookie", async () => {
		const req = make_req({ headers: { "cookie": "theme=light" } });

		const ctx = await create_ctx(req);

		expect(ctx.dark_mode).toBe(false);
		expect(ctx.theme_class).toBe("light");
	});

	test("defaults to empty theme_class when no cookie", async () => {
		const req = make_req();

		const ctx = await create_ctx(req);

		expect(ctx.dark_mode).toBe(false);
		expect(ctx.theme_class).toBe("");
	});
});

describe("create_ctx URL prefix detection", () => {
	test("detects admin prefix from pathname", async () => {
		const req = make_req({ url: "http://localhost/admin/users" });

		const ctx = await create_ctx(req);

		expect(ctx.prefix).toBe("admin");
	});

	test("detects api prefix from pathname", async () => {
		const req = make_req({ url: "http://localhost/api/data" });

		const ctx = await create_ctx(req);

		expect(ctx.prefix).toBe("api");
	});

	test("detects docs prefix from pathname", async () => {
		const req = make_req({ url: "http://localhost/docs/guide" });

		const ctx = await create_ctx(req);

		expect(ctx.prefix).toBe("docs");
	});

	test("returns null for no matching prefix", async () => {
		const req = make_req({ url: "http://localhost/home" });

		const ctx = await create_ctx(req);

		expect(ctx.prefix).toBeNull();
	});

	test("detects prefix even with root path", async () => {
		const req = make_req({ url: "http://localhost/admin" });

		const ctx = await create_ctx(req);

		expect(ctx.prefix).toBe("admin");
	});
});

describe("create_ctx session and user", () => {
	test("resolves user from session", async () => {
		const req = make_req({ headers: { "x-user-id": "123" } });

		const ctx = await create_ctx(req);

		expect(ctx.user).toBeDefined();
		expect(ctx.user?.id).toBe(123);
		expect(ctx.user?.email).toBe("user@example.com");
	});

	test("returns null user when not authenticated", async () => {
		const req = make_req();

		const ctx = await create_ctx(req);

		expect(ctx.user).toBeNull();
	});
});

describe("create_ctx route directory", () => {
	test("computes route_dir from meta_dir", async () => {
		const req = make_req();

		const ctx = await create_ctx(req, "/project/routes/examples/modern_css");

		// route_namespace_from_dir returns everything after "/routes/"
		expect(ctx.route_dir).toBe("examples/modern_css");
	});

	test("handles empty meta_dir", async () => {
		const req = make_req();

		const ctx = await create_ctx(req);

		expect(ctx.route_dir).toBeNull();
	});
});

describe("create_ctx request URL", () => {
	test("stores request pathname and query string", async () => {
		const req = make_req({ url: "http://localhost/path/to/page?foo=bar&baz=qux" });

		const ctx = await create_ctx(req);

		expect(ctx.request_url).toBe("/path/to/page?foo=bar&baz=qux");
	});

	test("handles root path", async () => {
		const req = make_req({ url: "http://localhost/" });

		const ctx = await create_ctx(req);

		expect(ctx.request_url).toBe("/");
	});
});
