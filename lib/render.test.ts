import { describe, expect, mock, test } from "bun:test";

import { mock_db } from "$root/test_helpers";

mock.module("$config/db", mock_db);

const { get_collapsed_nav_modules, move_styles_and_scripts_to_head } = await import("./render");

describe("get_collapsed_nav_modules", () => {
	test("returns validated module names from a cookie", () => {
		const cookie_value = JSON.stringify(["system", "reports"]);
		expect(get_collapsed_nav_modules(cookie_value)).toEqual(["system", "reports"]);
	});

	test("rejects malformed or invalid cookie data", () => {
		expect(get_collapsed_nav_modules("not-json")).toEqual([]);
		expect(get_collapsed_nav_modules(JSON.stringify({ system: true }))).toEqual([]);
		expect(get_collapsed_nav_modules(JSON.stringify(["system", 1, ""]))).toEqual(["system"]);
	});
});

describe("move_styles_and_scripts_to_head", () => {
	test("moves inline style from body to head", () => {
		const html = `<!doctype html><html><head><title>Test</title></head><body><style>.foo{color:red}</style></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toMatch(/<head>[\s\S]*<style>\.foo\{color:red\}<\/style>[\s\S]*<\/head>/);
		expect(result).not.toMatch(/<body>[\s\S]*<style>/);
	});

	test("moves stylesheet link from body to head", () => {
		const html = `<html><head><title>Test</title></head><body><link rel="stylesheet" href="app.css"></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toMatch(/<head>[\s\S]*<link rel="stylesheet" href="app.css">[\s\S]*<\/head>/);
	});

	test("moves script with src from body to head", () => {
		const html = `<html><head></head><body><script src="app.js"></script></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toMatch(/<head>[\s\S]*<script src="app.js"><\/script>[\s\S]*<\/head>/);
	});

	test("moves multiple block-level elements, keeps body content", () => {
		const html = `<html><head></head><body><link rel="stylesheet" href="a.css"><style>.x{}</style><script src="a.js"></script><p>inline text</p></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toContain("<link rel=\"stylesheet\" href=\"a.css\">");
		expect(result).toContain("<style>.x{}</style>");
		expect(result).toContain("<script src=\"a.js\"></script>");
		expect(result).toContain("<p>inline text</p>");
		expect(result).toMatch(/<head>[\s\S]*<link rel="stylesheet" href="a.css">/);
	});

	test("does not duplicate elements already in head", () => {
		const html = `<html><head><style>.head{}</style></head><body><p>content</p></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		const matches = result.match(/\.head\{\}/g);
		expect(matches?.length).toBe(1);
	});

	test("returns original html when no blocks to move", () => {
		const html = `<html><head><title>T</title></head><body><h1>Hi</h1></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toBe(html);
	});

	test("creates head tag if missing", () => {
		const html = `<html><body><style>.a{}</style></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toMatch(/<head>[\s\S]*<style>\.a\{\}<\/style>[\s\S]*<\/head>/);
	});

	test("handles empty string", () => expect(move_styles_and_scripts_to_head("")).toBe(""));

	test("does not move inline scripts (no src attribute)", () => {
		const html = `<html><head></head><body><script>alert(1)</script><p>text</p></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toMatch(/<body>[\s\S]*<script>alert\(1\)<\/script>[\s\S]*<\/body>/);
	});

	test("moves both single-quoted and double-quoted stylesheet rel", () => {
		const html = `<html><head></head><body><link rel='stylesheet' href='x.css'></body></html>`;
		const result = move_styles_and_scripts_to_head(html);
		expect(result).toMatch(/<head>[\s\S]*<link rel='stylesheet' href='x.css'>[\s\S]*<\/head>/);
	});

	describe("initialize_render / get_render", () => {
		test("initialize_render sets up render function", async () => {
			const engine = { render: async (name: string) => `<html>${name}</html>` };
			const { initialize_render, get_render } = await import("./render");
			initialize_render(engine, { is_dev: false });
			const render_fn = get_render();
			expect(render_fn).toBeDefined();
			const result = await render_fn("test");
			expect(result).toBe("<html>test</html>");
		});

		test("initialize_render with dev mode works", async () => {
			const engine = { render: async (name: string, _data: any) => `<html>${name}</html>` };
			const { initialize_render, get_render } = await import("./render");
			initialize_render(engine, { is_dev: true, lang: "en" });
			const render_fn = get_render();
			const result = await render_fn("test", { custom: "data" });
			expect(result).toBe("<html>test</html>");
		});
	});

	describe("move_styles_and_scripts_to_head (additional)", () => {
		test("handles case-insensitive style tags", () => {
			const html = "<html><head></head><body><STYLE>.foo{}</STYLE></body></html>";
			const result = move_styles_and_scripts_to_head(html);
			expect(result).toContain(".foo{}");
			expect(result.indexOf("<STYLE>")).toBeGreaterThan(result.indexOf("<head>"));
		});

		test("creates head when only html tag exists", () => {
			const html = "<html><body><style>.a{}</style></body></html>";
			const result = move_styles_and_scripts_to_head(html);
			expect(result).toContain(".a{}");
			expect(result.indexOf("<style>")).toBeGreaterThan(result.indexOf("<head>"));
		});

		test("creates head tag when neither html nor head exists", () => {
			const html = "<body><style>.a{}</style></body>";
			const result = move_styles_and_scripts_to_head(html);
			expect(result).toContain("<head>");
			expect(result.indexOf("<style>")).toBeGreaterThan(result.indexOf("<head>"));
		});

		test("handles stylesheet links moving to head", () => {
			const html = "<html><head></head><body><link rel=\"stylesheet\" href=\"style.css\"></body></html>";
			const result = move_styles_and_scripts_to_head(html);
			expect(result).toContain("stylesheet");
			expect(result.indexOf("href=")).toBeGreaterThan(result.indexOf("<head>"));
		});

		test("handles script tags with src moving to head", () => {
			const html = "<html><head></head><body><script src=\"app.js\"></script></body></html>";
			const result = move_styles_and_scripts_to_head(html);
			expect(result).toContain("app.js");
			expect(result.indexOf("app.js")).toBeGreaterThan(result.indexOf("<head>"));
		});

		test("returns html unchanged when no style/script blocks to move", () => {
			const html = "<html><head></head><body>no blocks</body></html>";
			const result = move_styles_and_scripts_to_head(html);
			expect(result).toBe(html);
		});
	});

	describe("render - function", () => {
		test("renders template with data and returns Response with custom headers and status", async () => {
			const engine = { render: async (name: string, data: any) => `<html><body>${data.custom}</body></html>` };
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false, lang: "en" });

			const minimal_ctx = { lang: "en", prefix: null, toasts: [], preferred_lang: null, translations: {} } as any;
			const result = await render("test", {
				data: { custom: "hello" },
				status: 200,
				headers: { "X-Custom": "value" },
				ctx: minimal_ctx,
			});

			expect(result).toBeInstanceOf(Response);
			expect(result.status).toBe(200);
			expect(result.headers.get("Content-Type")).toBe("text/html");
			expect(result.headers.get("X-Custom")).toBe("value");
		});

		test("render with RequestContext populates user, csrf, locale in template data", async () => {
			let captured_data: any = null;
			const engine = {
				render: async (name: string, data: any) => {
					captured_data = data;
					return `<html>${name}</html>`;
				},
			};
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false, lang: "en" });

			const ctx = {
				request_url: "/test",
				req: { headers: new Map([["X-CSRF-Token", "csrf-token-val"]]) },
				lang: "en",
				user: { id: 1, name: "Test User" },
				toasts: [],
				preferred_lang: null,
				locale: "en-US",
			} as any;

			const result = await render("template", { ctx });
			expect(result.status).toBe(200);
			expect(captured_data.user).toEqual({ id: 1, name: "Test User" });
			expect(captured_data.csrf_token).toBe("csrf-token-val");
			expect(captured_data.request_url).toBe("/test");
			expect(captured_data.locale).toBe("en-US");
		});

		test("render provides collapsed modules from the navigation cookie", async () => {
			let captured_data: any = null;
			const engine = {
				render: async (_name: string, data: any) => {
					captured_data = data;
					return "<html>rendered</html>";
				},
			};
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false, lang: "en" });

			const ctx = {
				req: { headers: new Map([["Cookie", "nav_collapsed_modules=%5B%22system%22%5D"]]) },
				lang: "en",
				user: null,
				toasts: [],
				preferred_lang: null,
				translations: {},
			} as any;

			await render("template", { ctx });
			expect(captured_data.collapsed_nav_modules).toEqual(["system"]);
		});

		test("render with route_dir resolves bare template name", async () => {
			let captured_template: string | null = null;
			const engine = {
				render: async (name: string, _data: any) => {
					captured_template = name;
					return "<html>rendered</html>";
				},
			};
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false, lang: "en" });

			const ctx = {
				route_dir: "/project/routes/admin/users",
				req: { headers: new Map() },
				lang: "en",
				user: null,
				toasts: [],
				preferred_lang: null,
				locale: "en-US",
			} as any;

			const result = await render("edit", { ctx });
			expect(result.status).toBe(200);
			expect(captured_template).toBe("/project/routes/admin/users/edit");
		});

		test("render with route_dir resolves relative ./ path", async () => {
			let captured_template: string | null = null;
			const engine = {
				render: async (name: string, _data: any) => {
					captured_template = name;
					return "<html>rendered</html>";
				},
			};
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false, lang: "en" });

			const ctx = {
				route_dir: "/project/routes/admin/users",
				req: { headers: new Map() },
				lang: "en",
				user: null,
				toasts: [],
				preferred_lang: null,
				locale: "en-US",
			} as any;

			const result = await render("./partials/header", { ctx });
			expect(result.status).toBe(200);
			expect(captured_template).toBe("/project/routes/admin/users/partials/header");
		});

		test("render strips .ree extension if provided", async () => {
			let captured_template: string | null = null;
			const engine = {
				render: async (name: string, _data: any) => {
					captured_template = name;
					return "<html>rendered</html>";
				},
			};
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false, lang: "en" });

			const ctx = {
				route_dir: "/project/routes/admin/users",
				req: { headers: new Map() },
				lang: "en",
				user: null,
				toasts: [],
				preferred_lang: null,
				locale: "en-US",
			} as any;

			const result = await render("./form.ree", { ctx });
			expect(result.status).toBe(200);
			expect(captured_template).toBe("/project/routes/admin/users/form");
		});

		test("render clears toast cookies in response headers", async () => {
			const engine = { render: async (name: string) => `<html>${name}</html>` };
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false, lang: "en" });

			const ctx = {
				req: { headers: new Map() },
				lang: "en",
				user: null,
				toasts: [{ key: "toast-updated-1" }, { key: "toast-updated-2" }],
				preferred_lang: null,
				locale: "en-US",
			} as any;

			const result = await render("page", { ctx });
			expect(result.status).toBe(200);
			const set_cookies = result.headers.getSetCookie?.() ?? [];
			expect(set_cookies.length).toBe(2);
			expect(set_cookies[0]).toContain("toast-updated-1=");
			expect(set_cookies[1]).toContain("toast-updated-2=");
		});

		test("render with a minimal ctx still supplies base data", async () => {
			let captured_data: any = null;
			const engine = {
				render: async (name: string, data: any) => {
					captured_data = data;
					return `<html>${name}</html>`;
				},
			};
			const { initialize_render, render } = await import("./render");
			initialize_render(engine, { is_dev: false });

			const result = await render("bare", { ctx: { lang: "en", prefix: null, toasts: [], preferred_lang: null, translations: {} } as any });
			expect(result.status).toBe(200);
			expect(captured_data.lang).toBeDefined();
		});
	});
});
