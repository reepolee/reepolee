import { describe, expect, test } from "bun:test";

import { bump_patch_version, format_release_version } from "./release";

describe("release version formatting", () => {
	test("pads month to two digits", () => expect(format_release_version(26, 7, 1)).toBe("26.07.1"));

	test("bumps patch while preserving padded month", () => expect(bump_patch_version("26.7.18")).toBe(
		"26.07.19"
	));
});
