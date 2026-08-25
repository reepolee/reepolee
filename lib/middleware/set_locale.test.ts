import { describe, expect, mock, test } from "bun:test";

// Mock dependencies
mock.module("$config/supported_locales", () => ({
	default_locale: "en-us",
	locales: ["en-us", "sl-si", "fr-fr"],
	active_locales: ["en-us", "sl-si", "fr-fr"],
	locale_names: { "en-us": "English", "sl-si": "Slovenian", "fr-fr": "French" },
	locale_aliases: {},
}));

mock.module("../route_map", () => ({
	detect_locale: (pathname: string) => {
		// Simple mock: check if pathname has localized versions
		if (pathname === "/o-nas") return "sl-si";
		if (pathname === "/about") return "fr-fr";
		return null;
	},
	resolve_localized_path: (pathname: string, locale: string) => {
		// Mock: return the localized slug for the locale (framework localizes
		// via route slugs like /o-nas, not /{lang} prefixes).
		if (pathname === "/about" && locale === "sl-si") return "/o-nas";
		if (pathname === "/users" && locale === "fr-fr") return "/utilisateurs";
		return null;
	},
}));

import { set_locale } from "./set_locale";

function make_req(options: { url?: string; method?: string; headers?: Record<string, string>; } = {}): any {
	const headers = new Map(Object.entries(options.headers || {}));
	return {
		url: options.url || "http://localhost/",
		method: options.method || "GET",
		headers: {
			get: (name: string) => headers.get(name.toLowerCase()),
			set: (name: string, value: string) => headers.set(name.toLowerCase(), value),
		},
	};
}

function make_next(status = 200): any { return async (req: any) => { return new Response("OK", { status, headers: { "content-type": "text/plain" } }); }; }

const ALL = ["en-us", "sl-si", "fr-fr"];

describe("set_locale middleware", () => {
	test("sets X-Locale header and cookie from query parameter", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/?locale=sl-si", headers: {} });
		const next = make_next();

		const res = await mw(req, next);

		const cookie = res.headers.get("set-cookie");
		expect(cookie).toContain("locale=sl-si");
	});

	test("defaults to default_locale when no param", async () => {
		const mw = set_locale(ALL);
		const req = make_req();
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-locale")).toBe("en-us");
	});

	test("ignores invalid locale in query parameter", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/?locale=invalid" });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-locale")).toBe("en-us");
	});

	test("uses locale from cookie", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ headers: { "cookie": "locale=sl-si" } });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-locale")).toBe("sl-si");
	});

	test("query parameter overrides cookie", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/?locale=fr-fr", headers: { "cookie": "locale=sl-si" } });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-locale")).toBe("fr-fr");
	});

	test("redirects on locale switch with localized path", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/about?locale=sl-si" });
		const next = make_next();

		const res = await mw(req, next);

		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toContain("/o-nas");
		expect(res.headers.get("set-cookie")).toContain("locale=sl-si");
	});

	test("sets locale cookie in response", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/?locale=sl-si" });
		const next = make_next();

		const res = await mw(req, next);

		const cookie = res.headers.get("set-cookie");
		expect(cookie).toContain("locale=sl-si");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain("Max-Age=");
	});

	test("detects locale from URL path for GET requests", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/o-nas", method: "GET" });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-locale")).toBe("sl-si");
	});

	test("ignores path locale for non-GET methods", async () => {
		const mw = set_locale(ALL);
		const req = make_req({
			url: "http://localhost/o-nas",
			method: "POST",
			headers: { "cookie": "locale=en-us" },
		});
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		// For POST, should use cookie, not path
		expect(captured_req.headers.get("x-locale")).toBe("en-us");
	});

	test("sets X-Locale-Preferred from valid cookie", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ headers: { "cookie": "locale=sl-si" } });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-locale-preferred")).toBe("sl-si");
	});

	test("handles case-insensitive locale codes and normalizes them to lowercase", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/?locale=SL-si" });
		const next = make_next();

		const res = await mw(req, next);

		const cookie = res.headers.get("set-cookie");
		expect(cookie).toContain("locale=sl-si");
	});

	test("preserves other query parameters on redirect", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/about?locale=sl-si&page=2&sort=name" });
		const next = make_next();

		const res = await mw(req, next);

		const location = res.headers.get("location");
		expect(location).toContain("page=2");
		expect(location).toContain("sort=name");
		expect(location).not.toContain("locale=");
	});

	test("handles HTTPS protocol for secure flag", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "https://localhost/?locale=sl-si" });
		const next = make_next();

		const res = await mw(req, next);

		const cookie = res.headers.get("set-cookie");
		expect(cookie).toContain("Secure");
	});

	test("handles HTTP protocol without secure flag", async () => {
		const mw = set_locale(ALL);
		const req = make_req({ url: "http://localhost/?locale=sl-si" });
		const next = make_next();

		const res = await mw(req, next);

		const cookie = res.headers.get("set-cookie");
		expect(cookie).not.toContain("Secure");
	});

	test("decodes URL-encoded cookie values", async () => {
		const mw = set_locale(ALL);
		const encoded_locale = encodeURIComponent("sl-si");
		const req = make_req({ headers: { "cookie": `locale=${encoded_locale}` } });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		await mw(req, next);

		expect(captured_req.headers.get("x-locale")).toBe("sl-si");
	});
});

// The channel machine clients use: no cookie, no localized path, JSON only.
// A JSON request must name a supported locale or it is rejected - there is no
// default-locale fallback, because that would silently ship a wrong language.
describe("set_locale Accept-Language (JSON requests)", () => {
	async function run(headers: Record<string, string>, url = "http://localhost/system/files"): Promise<{ locale: string | null; res: Response; }> {
		const mw = set_locale(ALL);
		const req = make_req({ url, headers });
		let captured_req: any;
		const next = async (r: any) => {
			captured_req = r;
			return new Response("OK");
		};

		const res = await mw(req, next);
		return { locale: captured_req?.headers.get("x-locale") ?? null, res };
	}

	test("honoured when the request wants JSON", async () => {
		const { locale } = await run({ "accept": "application/json", "accept-language": "sl-si" });
		expect(locale).toBe("sl-si");
	});

	test("ignored for ordinary page requests", async () => {
		const { locale } = await run({ "accept": "text/html", "accept-language": "sl-si" });
		expect(locale).toBe("en-us");
	});

	test("weighted list picks the highest-quality allowed locale", async () => {
		const { locale } = await run({ "accept": "application/json", "accept-language": "de-de,sl-si;q=0.9,en-us;q=0.8" });
		expect(locale).toBe("sl-si");
	});

	test("unknown locale is rejected with 400, not defaulted", async () => {
		const { locale, res } = await run({ "accept": "application/json", "accept-language": "ja-jp" });
		expect(res.status).toBe(400);
		expect(locale).toBeNull();
		const body = await res.json() as { error: string; supported_locales: string[]; };
		expect(body.error).toBe("locale_required");
		expect(body.supported_locales).toEqual(ALL);
	});

	test("missing Accept-Language is rejected with 400", async () => {
		const { locale, res } = await run({ "accept": "application/json" });
		expect(res.status).toBe(400);
		expect(locale).toBeNull();
	});

	test("a bare primary subtag is rejected rather than widened", async () => {
		const { res } = await run({ "accept": "application/json", "accept-language": "sl" });
		expect(res.status).toBe(400);
	});

	test("page requests are never rejected for a missing locale", async () => {
		const { locale, res } = await run({ "accept": "text/html" });
		expect(res.status).toBe(200);
		expect(locale).toBe("en-us");
	});

	test("cookie satisfies the requirement and outranks Accept-Language", async () => {
		const { locale } = await run({ "accept": "application/json", "accept-language": "sl-si", "cookie": "locale=fr-fr" });
		expect(locale).toBe("fr-fr");
	});

	test("query param satisfies the requirement and outranks Accept-Language", async () => {
		const { locale } = await run(
			{ "accept": "application/json", "accept-language": "sl-si" },
			"http://localhost/system/files?locale=fr-fr"
		);
		expect(locale).toBe("fr-fr");
	});

	test("format=json also enables the requirement", async () => {
		const { locale } = await run({ "accept-language": "sl-si" }, "http://localhost/system/files?format=json");
		expect(locale).toBe("sl-si");
	});

	// X-Locale is written by this middleware; downstream code trusts it as
	// already validated, so an inbound value must never survive.
	test("inbound X-Locale is rejected, not honoured", async () => {
		const { res } = await run({ "accept": "application/json", "x-locale": "sl-si" });
		expect(res.status).toBe(400);
	});
});
