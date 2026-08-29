import { afterEach, describe, expect, test } from "bun:test";

import { build_routes } from "$lib/route_builder";

const original_url = Bun.env.REEWEB_PUBLISHER_URL;
const original_enabled = Bun.env.REEWEB_PUBLISHER_ENABLED;
const original_fetch = globalThis.fetch;

afterEach(() => {
	if (original_url === undefined) {
		delete Bun.env.REEWEB_PUBLISHER_URL;
	} else {
		Bun.env.REEWEB_PUBLISHER_URL = original_url;
	}
	if (original_enabled === undefined) {
		delete Bun.env.REEWEB_PUBLISHER_ENABLED;
	} else {
		Bun.env.REEWEB_PUBLISHER_ENABLED = original_enabled;
	}
	globalThis.fetch = original_fetch;
});

describe("CRUD publisher signal integration", () => {
	test("wraps CRUD mutations with the Publisher signal", async () => {
		let signal_calls = 0;
		Bun.env.REEWEB_PUBLISHER_URL = "http://publisher.local/api/render-signal";
		Bun.env.REEWEB_PUBLISHER_ENABLED = "true";
		globalThis.fetch = (async () => {
			signal_calls++;
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
		const crud = {
			"/items": {
				POST: async () => new Response(null, { status: 303 }),
			},
		};
		const routes = build_routes([{ url: "/items", crud }]);
		const methods = routes["/items"] as Record<string, (req: Request) => Promise<Response>>;
		const post = methods.POST;
		if (!post) throw new Error("POST route was not generated");

		const response = await post(
			new Request("http://localhost/items", { method: "POST" }),
		);

		expect(response.status).toBe(303);
		expect(signal_calls).toBe(1);
	});

	test("does not signal when REEWEB_PUBLISHER_ENABLED is not true", async () => {
		let signal_calls = 0;
		Bun.env.REEWEB_PUBLISHER_URL = "http://publisher.local/api/render-signal";
		Bun.env.REEWEB_PUBLISHER_ENABLED = "false";
		globalThis.fetch = (async () => {
			signal_calls++;
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
		const crud = {
			"/items": {
				POST: async () => new Response(null, { status: 303 }),
			},
		};
		const routes = build_routes([{ url: "/items", crud }]);
		const methods = routes["/items"] as Record<string, (req: Request) => Promise<Response>>;
		const post = methods.POST;
		if (!post) throw new Error("POST route was not generated");

		const response = await post(
			new Request("http://localhost/items", { method: "POST" }),
		);

		expect(response.status).toBe(303);
		expect(signal_calls).toBe(0);
	});

	test("does not add Publisher signaling to ordinary routes", async () => {
		let signal_calls = 0;
		Bun.env.REEWEB_PUBLISHER_URL = "http://publisher.local/api/render-signal";
		Bun.env.REEWEB_PUBLISHER_ENABLED = "true";
		globalThis.fetch = (async () => {
			signal_calls++;
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
		const handler = async () => new Response(null, { status: 200 });
		const routes = build_routes([{ url: "/action", methods: { POST: handler } }]);
		const methods = routes["/action"] as Record<string, (req: Request) => Promise<Response>>;
		const post = methods.POST;
		if (!post) throw new Error("POST route was not generated");

		await post(new Request("http://localhost/action", { method: "POST" }));

		expect(signal_calls).toBe(0);
	});
});
