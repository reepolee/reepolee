import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { diff_directories } from "./diff";
import { apply_sync } from "./sync";
import type { ScanSnapshot } from "./types";

async function make_project(): Promise<{ source: string; project: string; cleanup: () => Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "reesync-apply-"));
	const source = join(base, "source");
	const project = join(base, "project");
	await mkdir(source, { recursive: true });
	await mkdir(project, { recursive: true });
	return { source, project, cleanup: () => rm(base, { recursive: true, force: true }) };
}

async function scan(source: string, project: string): Promise<ScanSnapshot> {
	const entries = await diff_directories(source, project);
	return { scan_id: "s1", source_root: source, project_root: project, created_at: new Date().toISOString(), entries };
}

describe("apply_sync", () => {
	test("copies new and modified files, creating parent dirs", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await mkdir(join(source, "nested"), { recursive: true });
			await writeFile(join(source, "nested", "new.txt"), "hello");
			await writeFile(join(source, "changed.txt"), "upstream");
			await writeFile(join(project, "changed.txt"), "local");

			const snapshot = await scan(source, project);
			const result = await apply_sync(snapshot, ["nested/new.txt", "changed.txt"]);

			expect(result.copied.sort()).toEqual(["changed.txt", "nested/new.txt"]);
			expect(await readFile(join(project, "nested", "new.txt"), "utf8")).toBe("hello");
			expect(await readFile(join(project, "changed.txt"), "utf8")).toBe("upstream");
		} finally {
			await cleanup();
		}
	});

	test("rejects a file changed upstream after scan as stale-source", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await writeFile(join(source, "a.txt"), "v1");
			const snapshot = await scan(source, project);
			await writeFile(join(source, "a.txt"), "v2 - changed after scan");

			const result = await apply_sync(snapshot, ["a.txt"]);
			expect(result.copied).toEqual([]);
			expect(result.stale[0]?.reason).toBe("stale-source");
		} finally {
			await cleanup();
		}
	});

	test("rejects a file changed locally after scan as stale-dest", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await writeFile(join(source, "a.txt"), "upstream");
			await writeFile(join(project, "a.txt"), "local v1");
			const snapshot = await scan(source, project);
			await writeFile(join(project, "a.txt"), "local v2 - changed after scan");

			const result = await apply_sync(snapshot, ["a.txt"]);
			expect(result.copied).toEqual([]);
			expect(result.stale[0]?.reason).toBe("stale-dest");
		} finally {
			await cleanup();
		}
	});

	test("rejects project-only and ignored entries as not-selectable", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await writeFile(join(project, ".reesyncignore"), "skip.txt\n");
			await writeFile(join(source, "skip.txt"), "x");
			await writeFile(join(project, "only-local.txt"), "x");

			const snapshot = await scan(source, project);
			const result = await apply_sync(snapshot, ["skip.txt", "only-local.txt"]);

			expect(result.copied).toEqual([]);
			expect(result.failed.map((f) => f.rel_path).sort()).toEqual(["only-local.txt", "skip.txt"]);
		} finally {
			await cleanup();
		}
	});

	test("continues past one failing file to copy later selected files", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			await writeFile(join(source, "ok.txt"), "fine");
			await writeFile(join(source, "stale.txt"), "v1");
			const snapshot = await scan(source, project);
			await writeFile(join(source, "stale.txt"), "v2");

			const result = await apply_sync(snapshot, ["stale.txt", "ok.txt"]);
			expect(result.copied).toEqual(["ok.txt"]);
			expect(result.stale.map((s) => s.rel_path)).toEqual(["stale.txt"]);
		} finally {
			await cleanup();
		}
	});

	test("selecting an unreviewed path not present in the snapshot is rejected", async () => {
		const { source, project, cleanup } = await make_project();
		try {
			const snapshot = await scan(source, project);
			const result = await apply_sync(snapshot, ["never-scanned.txt"]);
			expect(result.copied).toEqual([]);
			expect(result.failed[0]?.reason).toBe("not-selectable");
		} finally {
			await cleanup();
		}
	});
});
