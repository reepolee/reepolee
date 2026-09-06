import { expect, test } from "bun:test";

import { retry_after_ms, retry_delay_ms } from "./retry_after";

test("uses Retry-After seconds from a rate-limited response", () => {
	expect(retry_after_ms(new Headers({ "retry-after": "429" }), "")).toBe(429000);
});

test("uses a retry duration returned in a JSON error body", () => {
	expect(retry_after_ms(new Headers(), '{"error":{"message":"Please try again in 12 seconds"}}')).toBe(12000);
});

test("falls back only when the rate-limited response has no retry duration", () => {
	expect(retry_delay_ms({ status: 429, retry_after_ms: 429000 }, 800)).toBe(429000);
	expect(retry_delay_ms({ status: 500 }, 800)).toBe(800);
});
