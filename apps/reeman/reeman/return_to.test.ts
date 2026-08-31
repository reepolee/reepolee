import { describe, expect, test } from "bun:test";

import { safe_return_to } from "./return_to";

describe("safe_return_to", () => {
	test("allows route detail pages after refresh", () => {
		expect(safe_return_to("/routes/1")).toBe("/routes/1");
		expect(safe_return_to("/routes/42/")).toBe("/routes/42");
	});

	test("rejects non-numeric and external return targets", () => {
		expect(safe_return_to("/routes/new")).toBe("/");
		expect(safe_return_to("https://example.com/routes/1")).toBe("/");
	});
});
