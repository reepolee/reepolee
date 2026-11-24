/**
 * Recursive walk + SHA-256 comparison between an upstream source directory
 * and the current project. Mirrors the standalone `reesync` CLI's exclusion
 * rules so Reeman Software Update sees the same file set.
 */

import { existsSync } from "node:fs";
import { readdir, lstat, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { is_ignored, load_ignore_list, matching_glob, type IgnoreList } from "./ignore_list";
import { to_forward_slashes } from "./paths";
import type { FileState, ScanEntry, SourceCommitInfo } from "./types";

const EXCLUDED_DIR_NAMES = new Set(["node_modules", "target", "vendor", "vendors", "dist", ".next", ".svelte-kit", ".cache", ".output"]);

async function walk_files(root: string): Promise<Map<string, string>> {
	const files = new Map<string, string>(); // rel_path (forward-slash) -> absolute path
	async function recurse(dir: string, rel_prefix: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const abs_path = join(dir, entry.name);
			const rel_path = rel_prefix ? `${rel_prefix}/${entry.name}` : entry.name;

			let link_stat;
			try {
				link_stat = await lstat(abs_path);
			} catch {
				continue;
			}
			if (link_stat.isSymbolicLink()) continue;

			if (link_stat.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
				await recurse(abs_path, rel_path);
			} else if (link_stat.isFile()) {
				files.set(to_forward_slashes(rel_path), abs_path);
			}
		}
	}
	await recurse(root, "");
	return files;
}

async function hash_and_size(abs_path: string): Promise<{ hash: string; size: number }> {
	const file = Bun.file(abs_path);
	const bytes = await file.bytes();
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return { hash: hasher.digest("hex"), size: bytes.byteLength };
}

/**
 * Walk `source_root` and `project_root`, hash every regular file on both
 * sides, and classify each project-relative path as new/modified/project-only.
 * Ignore state is computed from the project's `.reesyncignore` and does not
 * exclude entries from the result - it only annotates them.
 */
export async function diff_directories(source_root: string, project_root: string): Promise<ScanEntry[]> {
	const [source_files, project_files, ignore_list] = await Promise.all([
		walk_files(source_root),
		walk_files(project_root),
		load_ignore_list(project_root),
	]);

	const all_rel_paths = new Set<string>([...source_files.keys(), ...project_files.keys()]);
	const sorted_rel_paths = [...all_rel_paths].sort((a, b) => a.localeCompare(b));

	const entries: ScanEntry[] = [];
	for (const rel_path of sorted_rel_paths) {
		const source_abs = source_files.get(rel_path);
		const dest_abs = project_files.get(rel_path);

		let source_hash: string | null = null;
		let source_size: number | null = null;
		if (source_abs) {
			const hashed = await hash_and_size(source_abs);
			source_hash = hashed.hash;
			source_size = hashed.size;
		}

		let dest_hash: string | null = null;
		let dest_size: number | null = null;
		if (dest_abs) {
			const hashed = await hash_and_size(dest_abs);
			dest_hash = hashed.hash;
			dest_size = hashed.size;
		}

		let state: FileState;
		if (source_abs && !dest_abs) {
			state = "new";
		} else if (source_abs && dest_abs) {
			if (source_hash === dest_hash) continue; // identical - not shown
			state = "modified";
		} else {
			state = "project-only";
		}

		const commit_info = source_abs ? get_file_commit_info(source_root, rel_path) : null;
		entries.push(build_entry(rel_path, state, source_hash, dest_hash, source_size, dest_size, commit_info, ignore_list));
	}

	return entries;
}

function build_entry(
	rel_path: string,
	state: FileState,
	source_hash: string | null,
	dest_hash: string | null,
	source_size: number | null,
	dest_size: number | null,
	commit_info: SourceCommitInfo | null,
	ignore_list: IgnoreList,
): ScanEntry {
	const ignored = is_ignored(ignore_list, rel_path);
	const ignore_pattern = ignored ? matching_glob(ignore_list, rel_path) : null;
	return {
		rel_path,
		state,
		source_hash,
		dest_hash,
		source_size,
		dest_size,
		commit_info,
		ignored,
		ignore_pattern,
		is_exact_ignore: ignored && ignore_pattern === null,
	};
}

function get_file_commit_info(source_root: string, rel_path: string): SourceCommitInfo | null {
	if (!existsSync(join(source_root, ".git"))) return null;
	try {
		const result = execFileSync(
			"git",
			["-C", source_root, "log", "-1", "--format=%H%x09%s%x09%an%x09%ai", "--", rel_path],
			{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		if (!result) return null;
		const [hash, message, author, date] = result.split("\t");
		if (!hash || !message || !author || !date) return null;
		return { hash, message, author, date };
	} catch {
		return null;
	}
}

export async function rehash(abs_path: string): Promise<string | null> {
	try {
		const stats = await stat(abs_path);
		if (!stats.isFile()) return null;
	} catch {
		return null;
	}
	const { hash } = await hash_and_size(abs_path);
	return hash;
}
