/**
 * Studio - line-level diff between the original CREATE TABLE DDL and the
 * live-edited preview, so the operator sees exactly what a save will change
 * instead of re-reading the full regenerated statement on every keystroke.
 *
 * Plain LCS line diff (no deps, Bun-native rule) - CREATE TABLE bodies are
 * short enough that O(n*m) is fine.
 */

export type DdlDiffLineKind = "same" | "add" | "remove";

export interface DdlDiffLine {
	kind: DdlDiffLineKind;
	text: string;
}

/** Diff two DDL texts line by line, returning same/add/remove runs in display order. */
export function diff_ddl_lines(original: string, updated: string): DdlDiffLine[] {
	const before = original.split("\n");
	const after = updated.split("\n");
	const lcs = longest_common_subsequence(before, after);

	const lines: DdlDiffLine[] = [];
	let before_index = 0;
	let after_index = 0;

	for (const match of lcs) {
		while (before_index < match.before_index) lines.push({ kind: "remove", text: before[before_index++]! });
		while (after_index < match.after_index) lines.push({ kind: "add", text: after[after_index++]! });
		lines.push({ kind: "same", text: before[before_index]! });
		before_index++;
		after_index++;
	}
	while (before_index < before.length) lines.push({ kind: "remove", text: before[before_index++]! });
	while (after_index < after.length) lines.push({ kind: "add", text: after[after_index++]! });

	return lines;
}

interface LcsMatch {
	before_index: number;
	after_index: number;
}

/** Standard dynamic-programming LCS, backtracked into a list of matching line positions. */
function longest_common_subsequence(before: string[], after: string[]): LcsMatch[] {
	const rows = before.length;
	const cols = after.length;
	const table: Uint32Array[] = new Array(rows + 1);
	for (let i = 0; i <= rows; i++) table[i] = new Uint32Array(cols + 1);

	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			table[i]![j] = before[i] === after[j]
				? table[i + 1]![j + 1]! + 1
				: Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
		}
	}

	const matches: LcsMatch[] = [];
	let i = 0;
	let j = 0;
	while (i < rows && j < cols) {
		if (before[i] === after[j]) {
			matches.push({ before_index: i, after_index: j });
			i++;
			j++;
		} else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
			i++;
		} else {
			j++;
		}
	}
	return matches;
}
