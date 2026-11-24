import { describe, expect, test } from "bun:test";

import { capture_output, clean_output } from "./capture";

describe("capture_output", () => {
	test("captures console output and restores the original console", async () => {
		const orig_log = console.log;
		const orig_error = console.error;

		const cap = capture_output(async () => {
			console.log("hello");
			console.error("\x1b[33mbad\x1b[0m");
			return 42;
		});
		const result = await cap.fn();

		expect(result).toBe(42);
		expect(cap.stdout).toContain("hello");
		expect(clean_output(cap.stderr)).toContain("bad");
		expect(console.log).toBe(orig_log);
		expect(console.error).toBe(orig_error);
	});

	test("restores the original console even when the wrapped fn throws", async () => {
		const orig = console.log;

		const cap = capture_output(async () => {
			console.log("before throw");
			throw new Error("boom");
		});
		await expect(cap.fn()).rejects.toThrow("boom");

		expect(console.log).toBe(orig);
	});

	test("clean_output strips ANSI colour codes and trims the outer edges", () => {
		expect(clean_output(["\u001b[31mred\u001b[0m", "  text  "])).toBe("red\n  text");
	});
});
