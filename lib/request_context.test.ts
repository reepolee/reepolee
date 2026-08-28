import { describe, expect, mock, test } from "bun:test";
import { MAIN_APP_POSIX } from "$config/paths";

// Mock dependencies
mock.module("$config/supported_locales", () => ({
	locales: ["en-us", "es-es", "fr-fr"],
	active_locales: ["en-us", "es-es", "fr-fr"],
	default_locale: "en-us",
	locale_names: { "en-us": "English", "es-es": "Spanish", "fr-fr": "French" },
	locale_aliases: {},
}));

// request_context now imports get_toast_cookies from $lib/cookies and
// route_namespace_from_dir from $lib/route directly - both are pure
// header/string parsing, so the real implementations run in these tests.
// The auth middleware mock below intercepts cookies.ts's resolve_session
// import chain before it can reach a real DB connection.
mock.module("$lib/modules", () => ({ get_available_prefixes: () => ["admin", "api", "docs"] }));

mock.module("$platform/auth/middleware", () => ({
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

		expect(ctx.locale).toBe("en-us");
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
	test("detects language from X-Locale header", async () => {
		const req = make_req({ url: "http://localhost/", headers: { "x-locale": "es-es" } });

		const ctx = await create_ctx(req);

		expect(ctx.locale).toBe("es-es");
		expect(ctx.locale).toBe("es-es");
	});

	test("defaults to default_locale when no lang provided", async () => {
		const req = make_req();

		const ctx = await create_ctx(req);

		expect(ctx.locale).toBe("en-us");
		expect(ctx.locale).toBe("en-us");
	});

	test("prioritizes header over cookie", async () => {
		const req = make_req({ headers: { "x-locale": "fr-fr", "cookie": "locale=es-ES" } });

		const ctx = await create_ctx(req);

		expect(ctx.locale).toBe("fr-fr");
	});

	test("uses cookie language when no header", async () => {
		const req = make_req({ headers: { "cookie": "locale=es-ES" } });

		const ctx = await create_ctx(req);

		expect(ctx.locale).toBe("es-es");
	});

	test("ignores invalid language in cookie", async () => {
		const req = make_req({ headers: { "cookie": "locale=invalid_locale" } });

		const ctx = await create_ctx(req);

		expect(ctx.locale).toBe("en-us");
	});

	test("decodes URL-encoded language cookie", async () => {
		const req = make_req({ headers: { "cookie": `locale=${encodeURIComponent("fr-fr")}` } });

		const ctx = await create_ctx(req);

		expect(ctx.locale).toBe("fr-fr");
	});

	test("stores preferred language from X-Locale-Preferred header", async () => {
		const req = make_req({ headers: { "x-locale-preferred": "es-es" } });

		const ctx = await create_ctx(req);

		expect(ctx.preferred_locale).toBe("es-es");
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

		const ctx = await create_ctx(req, `/project/${MAIN_APP_POSIX}/examples/modern_css`);

		// route_namespace_from_dir returns everything after the main app root
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
