import { describe, expect, test } from "bun:test";

import { call_route_handler } from "$lib/server_helpers";

const JSON_HEADERS = { Accept: "application/json" };

function json_request(url: string = "https://example.com/system/files"): Request {
	return new Request(url, { headers: JSON_HEADERS });
}

describe("call_route_handler JSON gate", () => {
	test("passes a JSON response through untouched", async () => {
		const handler = () => Response.json({ data: [], total: 0 });
		const response = await call_route_handler(handler, json_request());
		expect(response.status).toBe(200);
		const body = await response.json() as { total: number };
		expect(body.total).toBe(0);
	});

	test("converts an HTML response to a 404 JSON envelope", async () => {
		const handler = () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
		const response = await call_route_handler(handler, json_request());
		expect(response.status).toBe(404);
		const body = await response.json() as { error: string };
		expect(body.error).toBe("not found");
	});

	// Regression: the gate used to swallow 3xx into a 404, which made the
	// ?locale=xx-YY switch look like a missing route to machine clients.
	test("preserves a 302 redirect instead of turning it into a 404", async () => {
		const handler = () => new Response(null, { status: 302, headers: { Location: "/o-nas" } });
		const response = await call_route_handler(handler, json_request());
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/o-nas");
	});

	test("preserves a 301 redirect", async () => {
		const handler = () => new Response(null, { status: 301, headers: { Location: "/moved" } });
		const response = await call_route_handler(handler, json_request());
		expect(response.status).toBe(301);
	});

	test("preserves a 307 redirect", async () => {
		const handler = () => new Response(null, { status: 307, headers: { Location: "/moved" } });
		const response = await call_route_handler(handler, json_request());
		expect(response.status).toBe(307);
	});

	test("still 404s a non-JSON 200 that is not a redirect", async () => {
		const handler = () => new Response("plain", { status: 200, headers: { "Content-Type": "text/plain" } });
		const response = await call_route_handler(handler, json_request());
		expect(response.status).toBe(404);
	});

	test("HTML passes through untouched when JSON was not requested", async () => {
		const handler = () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
		const request = new Request("https://example.com/system/files");
		const response = await call_route_handler(handler, request);
		expect(response.status).toBe(200);
	});

	test("method maps dispatch on the request method", async () => {
		const handler = { GET: () => Response.json({ ok: true }) };
		const response = await call_route_handler(handler, json_request());
		expect(response.status).toBe(200);
	});
});
