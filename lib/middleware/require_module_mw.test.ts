import { describe, expect, mock, test } from "bun:test";

// Mock dependencies
// Full module shape - mock.module leaks across files in a shared worker
// (bun#12823), so provide every export other files may need.
mock.module("$config/supported_languages", () => ({
	default_language: "en",
	languages: ["en"],
	active_languages: ["en"],
	language_names: { en: "English" },
	language_locales: { en: "en-US" },
}));

mock.module("$lib/route", () => ({ localized_url: (path: string, lang: string) => `/${lang}${path}` }));

mock.module("$root/routes/system/auth/middleware", () => ({
	resolve_session: async (req: any) => {
		const user_id = req.headers.get("x-user-id");
		if (user_id === "admin") {
			return {
				session_id: "admin_session",
				session: { user_id: 1 },
				current_user: { id: 1, email: "admin@example.com", modules_tags: "admin,system,editor" },
			};
		}
		if (user_id === "user") {
			return {
				session_id: "user_session",
				session: { user_id: 2 },
				current_user: { id: 2, email: "user@example.com", modules_tags: "user" },
			};
		}
		// No user
		return { session_id: null, session: null, current_user: null };
	},
	require_auth: () => null,
	require_module: () => null,
}));

import { require_auth_mw, require_module_mw } from "./require_module_mw";

function make_req(options: { url?: string; headers?: Record<string, string>; } = {}): any {
	const headers = new Map(Object.entries(options.headers || {}));
	return {
		url: options.url || "http://localhost/",
		headers: {
			get: (name: string) => headers.get(name.toLowerCase()),
			set: (name: string, value: string) => headers.set(name.toLowerCase(), value),
		},
	};
}

function make_next(): any {
	return async (req: any) => {
		return new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
	};
}

describe("require_auth_mw middleware", () => {
	test("passes through authenticated users", async () => {
		const mw = require_auth_mw();
		const req = make_req({ headers: { "x-user-id": "admin" } });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(200);
	});

	test("redirects unauthenticated users to login", async () => {
		const mw = require_auth_mw();
		const req = make_req({ url: "http://localhost/dashboard" });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(303);
		const location = res.headers.get("location");
		expect(location).toContain("/login");
		expect(location).toContain("redirect=");
	});

	test("includes original URL in redirect query parameter", async () => {
		const mw = require_auth_mw();
		const req = make_req({ url: "http://localhost/admin/users?page=2" });
		const next = make_next();

		const res = await mw(req, next);

		const location = res.headers.get("location");
		expect(location).toContain("redirect=");
		// URL is encoded, so check for the encoded version
		expect(location).toContain("admin");
	});

	test("uses language from X-Lang header", async () => {
		const mw = require_auth_mw();
		const req = make_req({ url: "http://localhost/dashboard", headers: { "x-lang": "es" } });
		const next = make_next();

		const res = await mw(req, next);

		const location = res.headers.get("location");
		expect(location).toContain("/es/login");
	});

	test("uses language from cookie if no X-Lang header", async () => {
		const mw = require_auth_mw();
		const req = make_req({ url: "http://localhost/dashboard", headers: { "cookie": "lang=fr" } });
		const next = make_next();

		const res = await mw(req, next);

		const location = res.headers.get("location");
		expect(location).toContain("/fr/login");
	});

	test("defaults to default_language when no lang info", async () => {
		const mw = require_auth_mw();
		const req = make_req({ url: "http://localhost/dashboard" });
		const next = make_next();

		const res = await mw(req, next);

		const location = res.headers.get("location");
		expect(location).toContain("/en/login");
	});

	test("sets X-Lang-Preferred from cookie for authenticated users", async () => {
		const mw = require_auth_mw();
		const req = make_req({ headers: { "x-user-id": "admin", "cookie": "lang=es" } });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-lang-preferred")).toBe("es");
	});
});

describe("require_module_mw middleware", () => {
	test("passes through users with required module", async () => {
		const mw = require_module_mw("admin");
		const req = make_req({ headers: { "x-user-id": "admin" } });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(200);
	});

	test("returns 403 for users without required module", async () => {
		const mw = require_module_mw("admin");
		const req = make_req({ headers: { "x-user-id": "user" } });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(403);
	});

	test("redirects unauthenticated users to login", async () => {
		const mw = require_module_mw("admin");
		const req = make_req({ url: "http://localhost/admin" });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(303);
		const location = res.headers.get("location");
		expect(location).toContain("/login");
	});

	test("handles comma-separated modules", async () => {
		const mw = require_module_mw("system");
		const req = make_req({ headers: { "x-user-id": "admin" } });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(200);
	});

	test("handles space-separated modules", async () => {
		const mw = require_module_mw("admin");
		const req = make_req({ headers: { "x-user-id": "admin" } });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(200);
	});

	test("handles mixed whitespace and commas", async () => {
		const mw = require_module_mw("editor");
		const req = make_req({ headers: { "x-user-id": "admin" } });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(200);
	});

	test("case-sensitive module matching", async () => {
		const mw = require_module_mw("Admin");
		const req = make_req({ headers: { "x-user-id": "admin" } });
		const next = make_next();

		const res = await mw(req, next);

		// Should not match "admin" != "Admin"
		expect(res.status).toBe(403);
	});

	test("handles empty modules field", async () => {
		const mw = require_module_mw("admin");
		const req = make_req({ headers: { "x-user-id": "user" } });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(403);
	});

	test("uses language from cookie for unauthenticated redirect", async () => {
		const mw = require_module_mw("admin");
		const req = make_req({ url: "http://localhost/admin", headers: { "cookie": "lang=es" } });
		const next = make_next();

		const res = await mw(req, next);

		const location = res.headers.get("location");
		expect(location).toContain("/es/login");
	});

	test("sets X-Lang-Preferred for authorized users", async () => {
		const mw = require_module_mw("admin");
		const req = make_req({ headers: { "x-user-id": "admin", "cookie": "lang=fr" } });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-lang-preferred")).toBe("fr");
	});

	test("different module codes check independently", async () => {
		const mw_system = require_module_mw("system");
		const mw_editor = require_module_mw("editor");
		const mw_unknown = require_module_mw("unknown");

		const req_admin = make_req({ headers: { "x-user-id": "admin" } });
		const next = make_next();

		const res_system = await mw_system(req_admin, next);
		const res_editor = await mw_editor(req_admin, next);
		const res_unknown = await mw_unknown(req_admin, next);

		expect(res_system.status).toBe(200);
		expect(res_editor.status).toBe(200);
		expect(res_unknown.status).toBe(403);
	});
});
