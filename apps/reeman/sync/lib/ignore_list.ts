/**
 * `.reesyncignore` support for Reeman sync.
 *
 * Mirrors the standalone `reesync` CLI's ignore_list.rs semantics: a
 * clone-owned skip list at `<project>/.reesyncignore`, one glob pattern per
 * non-blank, non-`#` line, matched against project-root-relative forward-slash
 * paths. Matched files stay visible (dimmed, pre-unchecked) - never hidden.
 */

import { rename, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const IGNORE_FILE_NAME = ".reesyncignore";

export type IgnoreList = {
	path: string;
	lines: string[];
};

function pattern_lines(lines: string[]): string[] {
	return lines
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Load `<project_dir>/.reesyncignore`. A missing file yields an empty list (no error). */
export async function load_ignore_list(project_dir: string): Promise<IgnoreList> {
	const path = join(project_dir, IGNORE_FILE_NAME);
	let lines: string[] = [];
	try {
		const text = await readFile(path, "utf8");
		lines = text.split("\n");
	} catch {
		lines = [];
	}
	return { path, lines };
}

export function is_ignored(list: IgnoreList, rel_path: string): boolean {
	for (const pattern of pattern_lines(list.lines)) {
		if (glob_matches(pattern, rel_path)) return true;
	}
	return false;
}

export function has_exact(list: IgnoreList, rel_path: string): boolean {
	return list.lines.some((line) => line.trim() === rel_path);
}

/** First non-exact glob line matching `rel_path`, or null (including when it's an exact line). */
export function matching_glob(list: IgnoreList, rel_path: string): string | null {
	if (has_exact(list, rel_path)) return null;
	for (const pattern of pattern_lines(list.lines)) {
		if (glob_matches(pattern, rel_path)) return pattern;
	}
	return null;
}

function glob_matches(pattern: string, rel_path: string): boolean {
	try {
		return new Bun.Glob(pattern).match(rel_path);
	} catch {
		return false;
	}
}

/**
 * `Bun.Glob` does not validate patterns at construction time (malformed input
 * simply never matches), so invalid-pattern detection is a manual balance
 * check for unterminated `[...]` character classes and `{...}` brace groups -
 * the malformed shapes users actually hit by typo.
 */
export function is_invalid_pattern(pattern: string): boolean {
	let bracket_depth = 0;
	let brace_depth = 0;
	for (const char of pattern) {
		if (char === "[") bracket_depth++;
		else if (char === "]") bracket_depth = Math.max(0, bracket_depth - 1);
		else if (char === "{") brace_depth++;
		else if (char === "}") brace_depth = Math.max(0, brace_depth - 1);
	}
	return bracket_depth !== 0 || brace_depth !== 0;
}

export function invalid_patterns(list: IgnoreList): string[] {
	return pattern_lines(list.lines).filter(is_invalid_pattern);
}

async function persist(list: IgnoreList): Promise<void> {
	const has_content = list.lines.some((line) => line.trim().length > 0);
	if (!has_content) {
		try {
			await rm(list.path);
		} catch {
			// already absent
		}
		return;
	}
	const body = `${list.lines.join("\n")}\n`;
	const tmp_path = `${list.path}.tmp`;
	await writeFile(tmp_path, body, "utf8");
	await rename(tmp_path, list.path);
}

/** Add an exact-path line for `rel_path` and persist. No-op if already exact. Returns the updated list. */
export async function add_exact(list: IgnoreList, rel_path: string): Promise<IgnoreList> {
	if (has_exact(list, rel_path)) return list;
	const updated: IgnoreList = { ...list, lines: [...list.lines, rel_path] };
	await persist(updated);
	return updated;
}

/** Remove the exact-path line for `rel_path` and persist. No-op if absent. Returns the updated list. */
export async function remove_exact(list: IgnoreList, rel_path: string): Promise<IgnoreList> {
	if (!has_exact(list, rel_path)) return list;
	const updated: IgnoreList = { ...list, lines: list.lines.filter((line) => line.trim() !== rel_path) };
	await persist(updated);
	return updated;
}
