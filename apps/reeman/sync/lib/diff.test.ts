import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diff_directories } from "./diff";

async function make_project(): Promise<{ source: string; project: string; cleanup: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "reesync-diff-"));
	const source = join(base, "source");
	const project = join(base, "project");
	await mkdir(source, { recursive: true });
	await mkdir(project, { recursive: true });
	return { source, project, cleanup: () => rm(base, { recursive: true, force: true }) };
}

describe("diff_directories", () => {
	test("classifies new, modified, identical, and project-only files", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await writeFile(join(source, "new.txt"), "hello");
			await writeFile(join(source, "changed.txt"), "upstream version");
			await writeFile(join(project, "changed.txt"), "local version");
			await writeFile(join(source, "same.txt"), "identical");
			await writeFile(join(project, "same.txt"), "identical");
			await writeFile(join(project, "only-local.txt"), "local only");

			const entries = await diff_directories(source, project);
			const by_path = new Map(entries.map((e) => [e.rel_path, e]));

			expect(by_path.get("new.txt")?.state).toBe("new");
			expect(by_path.get("changed.txt")?.state).toBe("modified");
			expect(by_path.get("only-local.txt")?.state).toBe("project-only");
			expect(by_path.has("same.txt")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("skips hidden entries, excluded dirs, and symlinks", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await mkdir(join(source, ".git"), { recursive: true });
			await writeFile(join(source, ".git", "config"), "x");
			await writeFile(join(source, ".hidden"), "x");
			await mkdir(join(source, "node_modules"), { recursive: true });
			await writeFile(join(source, "node_modules", "pkg.js"), "x");
			await writeFile(join(source, "real.txt"), "x");
			await symlink(join(source, "real.txt"), join(source, "link.txt")).catch(() => {});

			const entries = await diff_directories(source, project);
			const rel_paths = entries.map((e) => e.rel_path);

			expect(rel_paths).toContain("real.txt");
			expect(rel_paths).not.toContain(".git/config");
			expect(rel_paths).not.toContain(".hidden");
			expect(rel_paths).not.toContain("node_modules/pkg.js");
			expect(rel_paths).not.toContain("link.txt");
		} finally {
			await cleanup();
		}
	});

	test("normalizes nested paths to forward slashes", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await mkdir(join(source, "a", "b"), { recursive: true });
			await writeFile(join(source, "a", "b", "c.txt"), "x");

			const entries = await diff_directories(source, project);
			expect(entries.map((e) => e.rel_path)).toContain("a/b/c.txt");
		} finally {
			await cleanup();
		}
	});

	test("annotates ignored entries from .reesyncignore without excluding them", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await writeFile(join(project, ".reesyncignore"), "ignored.txt\nsrc/**\n");
			await writeFile(join(source, "ignored.txt"), "x");
			await mkdir(join(source, "src"), { recursive: true });
			await writeFile(join(source, "src", "file.ts"), "x");

			const entries = await diff_directories(source, project);
			const by_path = new Map(entries.map((e) => [e.rel_path, e]));

			expect(by_path.get("ignored.txt")?.ignored).toBe(true);
			expect(by_path.get("ignored.txt")?.is_exact_ignore).toBe(true);
			expect(by_path.get("src/file.ts")?.ignored).toBe(true);
			expect(by_path.get("src/file.ts")?.ignore_pattern).toBe("src/**");
		} finally {
			await cleanup();
		}
	});
});
