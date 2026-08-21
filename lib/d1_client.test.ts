import { describe, expect, test } from "bun:test";

import { d1_client_from_env, d1_query, d1_query_endpoint } from "./d1_client";

const config = { api_token: "token-1", account_id: "acct-1", database_id: "db-1" };

function json_response(body: unknown, ok = true): Response {
	return new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "Content-Type": "application/json" } });
}

describe("d1_query_endpoint", () => {
	test("builds the Cloudflare query URL", () => {
		expect(d1_query_endpoint(config, "/query")).toBe(
			"https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database/db-1/query",
		);
	});

	test("respects api_base_url override", () => {
		const custom = { ...config, api_base_url: "https://d1.example.test" };
		expect(d1_query_endpoint(custom, "/query")).toBe("https://d1.example.test/accounts/acct-1/d1/database/db-1/query");
	});
});

describe("d1_query", () => {
	test("sends auth header, SQL body and returns the statement rows", async () => {
		let sent_url = "";
		let sent_headers: Headers | null = null;
		let sent_body = "";
		const fetch_fn = async (url: string | URL | Request, init?: RequestInit) => {
			sent_url = String(url);
			sent_headers = new Headers(init?.headers);
			sent_body = String(init?.body);
			return json_response({
				success: true,
				errors: [],
				result: [{ success: true, results: [{ package_id: "challenge-sl-ind" }, { package_id: "explore-sl-s" }] }],
			});
		};

		const rows = await d1_query(config, "SELECT * FROM teams", [], { fetch_fn });

		expect(sent_url).toBe("https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database/db-1/query");
		expect(sent_headers?.get("Authorization")).toBe("Bearer token-1");
		expect(sent_body).toContain('"sql":"SELECT * FROM teams"');
		expect(rows).toEqual([{ package_id: "challenge-sl-ind" }, { package_id: "explore-sl-s" }]);
	});

	test("passes params positionally", async () => {
		let sent_body = "";
		const fetch_fn = async (_url: string | URL | Request, init?: RequestInit) => {
			sent_body = String(init?.body);
			return json_response({ success: true, errors: [], result: [{ success: true, results: [] }] });
		};
		await d1_query(config, "SELECT * FROM teams WHERE package_id = ?", ["challenge-sl-ind"], { fetch_fn });
		expect(sent_body).toContain('"params":["challenge-sl-ind"]');
	});

	test("throws on API-level failure", async () => {
		const fetch_fn = async () =>
			json_response({ success: false, errors: [{ message: "DB not found" }], result: [] });
		await expect(d1_query(config, "SELECT 1", [], { fetch_fn })).rejects.toThrow("D1 query rejected: DB not found");
	});

	test("throws on HTTP error", async () => {
		const fetch_fn = async () => new Response("boom", { status: 401 });
		await expect(d1_query(config, "SELECT 1", [], { fetch_fn })).rejects.toThrow("D1 query failed with HTTP 401");
	});
});

describe("d1_client_from_env", () => {
	test("returns null when any credential is missing", () => {
		expect(d1_client_from_env({})).toBeNull();
		expect(d1_client_from_env({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a" })).toBeNull();
	});

	test("reads the three credentials from the environment", () => {
		expect(d1_client_from_env({ CF_API_TOKEN: "t", CF_ACCOUNT_ID: "a", CF_D1_DATABASE_ID: "d" })).toEqual({
			api_token: "t",
			account_id: "a",
			database_id: "d",
		});
	});
});
