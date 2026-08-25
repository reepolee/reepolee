import { describe, expect, test } from "bun:test";

import { wants_json } from "$lib/wants_json";

function make_req(accept?: string, url: string = "https://example.com/products"): Request {
	const headers: Record<string, string> = {};
	if (accept !== undefined) headers.Accept = accept;
	return new Request(url, { headers });
}

describe("wants_json", () => {
	test("exact application/json", () => {
		expect(wants_json(make_req("application/json"))).toBe(true);
	});

	test("fetch() default accept list", () => {
		const req = make_req("application/json, text/plain, */*");
		expect(wants_json(req)).toBe(true);
	});

	test("accept with quality weight", () => {
		expect(wants_json(make_req("application/json;q=0.9"))).toBe(true);
	});

	test("vendor +json suffix", () => {
		expect(wants_json(make_req("application/vnd.api+json"))).toBe(true);
	});

	test("text/json", () => {
		expect(wants_json(make_req("text/json"))).toBe(true);
	});

	test("case insensitive", () => {
		expect(wants_json(make_req("Application/JSON"))).toBe(true);
	});

	test("format=json query param", () => {
		const req = make_req(undefined, "https://example.com/products?format=json");
		expect(wants_json(req)).toBe(true);
	});

	test("browser navigation is not JSON", () => {
		const accept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8";
		expect(wants_json(make_req(accept))).toBe(false);
	});

	test("bare wildcard is not JSON", () => {
		expect(wants_json(make_req("*/*"))).toBe(false);
	});

	test("missing accept header is not JSON", () => {
		expect(wants_json(make_req(undefined))).toBe(false);
	});
});
