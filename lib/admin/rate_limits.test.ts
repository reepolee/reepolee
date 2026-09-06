import { afterAll, expect, mock, test } from "bun:test";

const raw_status = {
	total_keys: 3,
	scopes: {
		login: {
			limit: 5,
			window_s: 60,
			unique_identities: 2,
			entries: [
				{ identity: "sid:session-secret", window: 1_700_000_000, count: 3, ttl: 120 },
				{ identity: "ip:203.0.113.42", window: 1_700_000_060, count: 2, ttl: 60 },
			],
		},
	},
};

const original_env = { ...Bun.env };

mock.module("$lib/middleware", () => ({
	get_rate_limit_status: async () => raw_status,
	reset_rate_limits: async () => ({ deleted: 0 }),
}));

const { handle_rate_limits_get, summarize_rate_limit_status } = await import("./rate_limits");

test("rate-limit summaries omit raw identities and per-window entries", () => {
	const summary = summarize_rate_limit_status(raw_status);

	expect(summary).toEqual({
		total_keys: 3,
		scopes: {
			login: {
				limit: 5,
				window_s: 60,
				unique_identities: 2,
				active_windows: 2,
				total_requests: 5,
			},
		},
	});
	expect(JSON.stringify(summary)).not.toContain("sid:");
	expect(JSON.stringify(summary)).not.toContain("203.0.113.42");
});

test("rate-limit endpoint returns only the aggregate summary", async () => {
	(Bun.env as any).INTERNAL_ADMIN_ENDPOINTS = "true";
	(Bun.env as any).RELOAD_SECRET = "a".repeat(32);
	const request = new Request("http://localhost/__rate-limits", {
		headers: { "X-Reload-Secret": "a".repeat(32) },
	});

	const response = await handle_rate_limits_get(request);
	const body = await response.text();

	expect(response.status).toBe(200);
	expect(body).not.toContain("sid:");
	expect(body).not.toContain("203.0.113.42");
});

test("rate-limit endpoint is hidden when internal endpoints are disabled", async () => {
	delete (Bun.env as any).INTERNAL_ADMIN_ENDPOINTS;
	const response = await handle_rate_limits_get(new Request("http://localhost/__rate-limits"));

	expect(response.status).toBe(404);
});

afterAll(() => {
	for (const name of ["INTERNAL_ADMIN_ENDPOINTS", "RELOAD_SECRET"]) {
		const original_value = original_env[name];
		if (original_value === undefined) delete (Bun.env as any)[name];
		else (Bun.env as any)[name] = original_value;
	}
});
