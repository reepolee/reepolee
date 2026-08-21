/**
 * Apply: re-validate a snapshot's selected entries against the live
 * filesystem and copy only unchanged, still-selectable, still-contained
 * files. Continues across per-file failures so every selected path gets a
 * result.
 */

import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { rehash } from "./diff";
import { is_contained } from "./paths";
import type { ApplyResult, ScanSnapshot } from "./types";

/**
 * Copy `selected_rel_paths` from `snapshot.source_root` into
 * `snapshot.project_root`, restricted to entries present and selectable
 * (new/modified, not project-only, not ignored) in the snapshot. Re-resolves
 * containment and re-hashes both sides immediately before each copy.
 */
export async function apply_sync(snapshot: ScanSnapshot, selected_rel_paths: string[]): Promise<ApplyResult> {
	const result: ApplyResult = { copied: [], stale: [], failed: [] };
	const entry_by_path = new Map(snapshot.entries.map((entry) => [entry.rel_path, entry]));
	const selected = new Set(selected_rel_paths);

	for (const rel_path of selected) {
		const entry = entry_by_path.get(rel_path);
		if (!entry || entry.state === "project-only" || entry.ignored) {
			result.failed.push({ rel_path, ok: false, reason: "not-selectable" });
			continue;
		}

		const source_abs = join(snapshot.source_root, ...rel_path.split("/"));
		const dest_abs = join(snapshot.project_root, ...rel_path.split("/"));

		if (!is_contained(snapshot.source_root, source_abs) || !is_contained(snapshot.project_root, dest_abs)) {
			result.failed.push({ rel_path, ok: false, reason: "write-error" });
			continue;
		}

		const current_source_hash = await rehash(source_abs);
		if (current_source_hash !== entry.source_hash) {
			result.stale.push({ rel_path, ok: false, reason: "stale-source" });
			continue;
		}

		const current_dest_hash = await rehash(dest_abs);
		const expected_dest_hash = entry.dest_hash ?? null;
		if (current_dest_hash !== expected_dest_hash) {
			result.stale.push({ rel_path, ok: false, reason: "stale-dest" });
			continue;
		}

		try {
			await mkdir(dirname(dest_abs), { recursive: true });
			await copyFile(source_abs, dest_abs);
			result.copied.push(rel_path);
		} catch {
			result.failed.push({ rel_path, ok: false, reason: "write-error" });
		}
	}

	return result;
}
