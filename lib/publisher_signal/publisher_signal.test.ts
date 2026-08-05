import { describe, expect, test } from "bun:test";

import { publisher_signal_mw, send_publisher_signal } from "./index";

describe("send_publisher_signal", () => {
	test("does nothing when the URL is not configured", async () => {
		let calls = 0;
		const fetcher = async () => {
			calls++;
			return new Response(null, { status: 202 });
		};

		await send_publisher_signal("", fetcher);

		expect(calls).toBe(0);
	});

	test("posts to the complete configured endpoint", async () => {
		let received_url = "";
		let received_method = "";
		const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
			received_url = String(input);
			received_method = init?.method ?? "";
			return new Response(null, { status: 202 });
		};

		await send_publisher_signal(
			"http://publisher.local/api/render-signal",
			fetcher,
		);

		expect(received_url).toBe("http://publisher.local/api/render-signal");
		expect(received_method).toBe("POST");
	});

	test("swallows network failures", async () => {
		const fetcher = async () => {
			throw new Error("offline");
		};

		await expect(
			send_publisher_signal(
				"http://publisher.local/api/render-signal",
				fetcher,
			),
		).resolves.toBeUndefined();
	});
});

describe("publisher_signal_mw", () => {
	test("signals after a successful CRUD mutation", async () => {
		let calls = 0;
		const middleware = publisher_signal_mw(async () => { calls++; });
		const request = new Request("http://localhost/items", { method: "POST" });

		const response = await middleware(request as any, async () => new Response(null, { status: 303 }));

		expect(response.status).toBe(303);
		expect(calls).toBe(1);
	});

	test("does not signal reads, validation responses, or failed mutations", async () => {
		let calls = 0;
		const middleware = publisher_signal_mw(async () => { calls++; });
		const read_request = new Request("http://localhost/items");
		const validation_request = new Request("http://localhost/items/validate", { method: "POST" });
		const failed_request = new Request("http://localhost/items", { method: "DELETE" });

		await middleware(read_request as any, async () => new Response(null, { status: 200 }));
		await middleware(validation_request as any, async () => Response.json({ success: true }));
		await middleware(failed_request as any, async () => new Response(null, { status: 422 }));

		expect(calls).toBe(0);
	});
});
