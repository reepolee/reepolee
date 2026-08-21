import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { delete_snapshot, find_entry, generate_scan_id, load_snapshot, save_snapshot } from "./snapshot";
import type { ScanEntry, ScanSnapshot } from "./types";

const sample_entry: ScanEntry = {
	rel_path: "a.txt",
	state: "new",
	source_hash: "abc",
	dest_hash: null,
	source_size: 3,
	dest_size: null,
	ignored: false,
	ignore_pattern: null,
	is_exact_ignore: false,
};

async function make_dir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), "reesync-snapshot-"));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("snapshot", () => {
	test("round-trips a saved snapshot", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			const snapshot: ScanSnapshot = {
				scan_id: generate_scan_id(),
				source_root: "/src",
				project_root: "/proj",
				created_at: new Date().toISOString(),
				entries: [sample_entry],
			};
			await save_snapshot(snapshot, dir);
			const loaded = await load_snapshot(snapshot.scan_id, dir);
			expect(loaded).toEqual(snapshot);
			expect(find_entry(loaded!, "a.txt")).toEqual(sample_entry);
			expect(find_entry(loaded!, "missing.txt")).toBe(null);
		} finally {
			await cleanup();
		}
	});

	test("expired snapshots are not returned", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			const snapshot: ScanSnapshot = {
				scan_id: generate_scan_id(),
				source_root: "/src",
				project_root: "/proj",
				created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
				entries: [],
			};
			await save_snapshot(snapshot, dir);
			expect(await load_snapshot(snapshot.scan_id, dir)).toBe(null);
		} finally {
			await cleanup();
		}
	});

	test("rejects a scan id with path-traversal characters", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			expect(await load_snapshot("../../etc/passwd", dir)).toBe(null);
		} finally {
			await cleanup();
		}
	});

	test("unknown scan id yields null", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			expect(await load_snapshot(generate_scan_id(), dir)).toBe(null);
		} finally {
			await cleanup();
		}
	});

	test("delete removes the snapshot file", async () => {
		const { dir, cleanup } = await make_dir();
		try {
			const snapshot: ScanSnapshot = {
				scan_id: generate_scan_id(),
				source_root: "/src",
				project_root: "/proj",
				created_at: new Date().toISOString(),
				entries: [],
			};
			await save_snapshot(snapshot, dir);
			await delete_snapshot(snapshot.scan_id, dir);
			expect(await load_snapshot(snapshot.scan_id, dir)).toBe(null);
		} finally {
			await cleanup();
		}
	});
});
