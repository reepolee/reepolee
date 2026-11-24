import { describe, expect, test } from "bun:test";

import { parse_image_transforms } from "./proxy";

const url = (qs: string) => new URL(`http://localhost/avatars/uuid.webp${qs}`);

describe("parse_image_transforms - allowlist hardening", () => {
	test("accepts an allowlisted size", () => {
		const parsed = parse_image_transforms(url("?width=128"));
		expect(parsed).toEqual({ width: 128, height: 0, longest: 0, format: null });
	});

	test("accepts the documented example sizes", () => {
		expect(parse_image_transforms(url("?height=96"))?.height).toBe(96);
		expect(parse_image_transforms(url("?longest=400"))?.longest).toBe(400);
		expect(parse_image_transforms(url("?width=4096"))?.width).toBe(4096);
	});

	test("rejects a size outside the allowlist (cache-key minting vector)", () => {
		expect(parse_image_transforms(url("?width=1234"))).toBeNull();
		expect(parse_image_transforms(url("?height=777"))).toBeNull();
		expect(parse_image_transforms(url("?longest=399"))).toBeNull();
	});

	test("rejects out-of-range or non-numeric values", () => {
		expect(parse_image_transforms(url("?width=0"))).toBeNull();
		expect(parse_image_transforms(url("?width=4097"))).toBeNull();
		expect(parse_image_transforms(url("?width=abc"))).toBeNull();
		expect(parse_image_transforms(url("?width=-128"))).toBeNull();
		expect(parse_image_transforms(url("?longest=1e6"))).toBeNull();
	});

	test("returns null when only an unknown param is present", () => {
		expect(parse_image_transforms(url("?foo=bar"))).toBeNull();
	});

	test("still accepts format-only transforms", () => {
		const parsed = parse_image_transforms(url("?format=webp"));
		expect(parsed).toEqual({ width: 0, height: 0, longest: 0, format: "webp" });
	});

	test("combines an allowlisted size with a format", () => {
		const parsed = parse_image_transforms(url("?width=128&format=webp"));
		expect(parsed).toEqual({ width: 128, height: 0, longest: 0, format: "webp" });
	});
});
