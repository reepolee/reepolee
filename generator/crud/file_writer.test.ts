import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fw = await import("./file_writer");

describe("file_writer - ensure_dir", () => {
	test("creates directory that does not exist", () => {
		const base = mkdtempSync(join(tmpdir(), "fw-test-"));
		const sub = join(base, "a", "b", "c");
		expect(existsSync(sub)).toBe(false);
		fw.ensure_dir(sub);
		expect(existsSync(sub)).toBe(true);
		rmSync(base, { recursive: true, force: true });
	});

	test("does not throw for existing directory", () => {
		const base = mkdtempSync(join(tmpdir(), "fw-test-"));
		expect(() => fw.ensure_dir(base)).not.toThrow();
		rmSync(base, { recursive: true, force: true });
	});

	test("creates nested directories recursively", () => {
		const base = mkdtempSync(join(tmpdir(), "fw-test-"));
		const nested = join(base, "x", "y", "z", "w");
		fw.ensure_dir(nested);
		expect(existsSync(nested)).toBe(true);
		rmSync(base, { recursive: true, force: true });
	});
});

describe("file_writer - create_safe_writer", () => {
	test("returns a function", () => {
		const writer = fw.create_safe_writer(false);
		expect(typeof writer).toBe("function");
	});

	test("returns function with force=true", () => {
		const writer = fw.create_safe_writer(true);
		expect(typeof writer).toBe("function");
	});

	test("two calls with same force produce independent closures", () => {
		const writer1 = fw.create_safe_writer(false);
		const writer2 = fw.create_safe_writer(false);
		expect(writer1).not.toBe(writer2);
	});
});
