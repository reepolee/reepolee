import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { is_contained, validate_source_dir } from "./paths";

describe("is_contained", () => {
	test("root contains itself and nested children", () => {
		expect(is_contained("/a/b", "/a/b")).toBe(true);
		expect(is_contained("/a/b", "/a/b/c")).toBe(true);
	});

	test("sibling and parent paths are not contained", () => {
		expect(is_contained("/a/b", "/a/bc")).toBe(false);
		expect(is_contained("/a/b", "/a")).toBe(false);
	});
});

describe("validate_source_dir", () => {
	test("rejects empty input", async () => {
		const result = await validate_source_dir("  ", "/tmp");
		expect(result.ok).toBe(false);
	});

	test("rejects a source that does not exist", async () => {
		const result = await validate_source_dir("/nonexistent/path/xyz", "/tmp");
		expect(result).toEqual({ ok: false, error: "not-found" });
	});

	test("rejects a file (not a directory)", async () => {
		const base = await mkdtemp(join(tmpdir(), "reesync-paths-"));
		try {
			const file_path = join(base, "file.txt");
			await Bun.write(file_path, "x");
			const result = await validate_source_dir(file_path, base);
			expect(result).toEqual({ ok: false, error: "not-directory" });
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("rejects source equal to project root", async () => {
		const base = await mkdtemp(join(tmpdir(), "reesync-paths-"));
		try {
			const result = await validate_source_dir(base, base);
			expect(result).toEqual({ ok: false, error: "equals-project" });
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("rejects a source nested inside the project", async () => {
		const base = await mkdtemp(join(tmpdir(), "reesync-paths-"));
		try {
			const nested = join(base, "nested");
			await Bun.write(join(nested, ".keep"), "x");
			const result = await validate_source_dir(nested, base);
			expect(result).toEqual({ ok: false, error: "nested-in-project" });
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("rejects a project nested inside the source", async () => {
		const base = await mkdtemp(join(tmpdir(), "reesync-paths-"));
		try {
			const project = join(base, "project");
			await Bun.write(join(project, ".keep"), "x");
			const result = await validate_source_dir(base, project);
			expect(result).toEqual({ ok: false, error: "contains-project" });
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	test("accepts a valid unrelated directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "reesync-paths-"));
		try {
			const source = join(base, "source");
			const project = join(base, "project");
			await Bun.write(join(source, ".keep"), "x");
			await Bun.write(join(project, ".keep"), "x");
			const result = await validate_source_dir(source, project);
			expect(result.ok).toBe(true);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});
