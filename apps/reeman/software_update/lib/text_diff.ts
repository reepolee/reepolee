/**
 * Feature-local, dependency-free line diff for the Reesync review page.
 * Same LCS approach as apps/reeman/studio/lib/ddl_diff.ts, adapted into
 * bounded context hunks and capped before the quadratic allocation so a
 * large/binary file can't hang the review request.
 */

export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_DIFF_LINES = 4000;
const CONTEXT_LINES = 3;

export type DiffLineKind = "same" | "add" | "remove";
export type DiffLine = { kind: DiffLineKind; text: string; before_line: number | null; after_line: number | null };
export type DiffHunk = { lines: DiffLine[] };

export type TextDiffResult =
	| { kind: "diff"; hunks: DiffHunk[] }
	| { kind: "preview"; lines: string[] }
	| { kind: "binary" }
	| { kind: "too-large" };

export type PreviewResult = { kind: "preview"; lines: string[] } | { kind: "binary" } | { kind: "too-large" };
export type DiffResult = { kind: "diff"; hunks: DiffHunk[] } | { kind: "binary" } | { kind: "too-large" };

/** Heuristic binary sniff: a NUL byte within the first 8KB. */
export function looks_binary(bytes: Uint8Array): boolean {
	const scan_len = Math.min(bytes.byteLength, 8192);
	for (let i = 0; i < scan_len; i++) {
		if (bytes[i] === 0) return true;
	}
	return false;
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Bounded preview of a new (source-only) text file. */
export function build_preview(source_bytes: Uint8Array): PreviewResult {
	if (looks_binary(source_bytes)) return { kind: "binary" };
	if (source_bytes.byteLength > MAX_DIFF_BYTES) return { kind: "too-large" };
	const lines = decode(source_bytes).split("\n");
	if (lines.length > MAX_DIFF_LINES) return { kind: "too-large" };
	return { kind: "preview", lines };
}

/** Bounded diff between the project copy and the upstream copy of a modified file. */
export function build_diff(dest_bytes: Uint8Array, source_bytes: Uint8Array): DiffResult {
	if (looks_binary(dest_bytes) || looks_binary(source_bytes)) return { kind: "binary" };
	if (dest_bytes.byteLength > MAX_DIFF_BYTES || source_bytes.byteLength > MAX_DIFF_BYTES) return { kind: "too-large" };

	const before = decode(dest_bytes).split("\n");
	const after = decode(source_bytes).split("\n");
	if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) return { kind: "too-large" };

	const flat = diff_lines(before, after);
	return { kind: "diff", hunks: to_hunks(flat) };
}

function diff_lines(before: string[], after: string[]): DiffLine[] {
	const lcs = longest_common_subsequence(before, after);
	const lines: DiffLine[] = [];
	let bi = 0;
	let ai = 0;
	for (const match of lcs) {
		while (bi < match.before_index) lines.push({ kind: "remove", text: before[bi]!, before_line: bi + 1, after_line: null }), bi++;
		while (ai < match.after_index) lines.push({ kind: "add", text: after[ai]!, before_line: null, after_line: ai + 1 }), ai++;
		lines.push({ kind: "same", text: before[bi]!, before_line: bi + 1, after_line: ai + 1 });
		bi++;
		ai++;
	}
	while (bi < before.length) lines.push({ kind: "remove", text: before[bi]!, before_line: bi + 1, after_line: null }), bi++;
	while (ai < after.length) lines.push({ kind: "add", text: after[ai]!, before_line: null, after_line: ai + 1 }), ai++;
	return lines;
}

interface LcsMatch {
	before_index: number;
	after_index: number;
}

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

/** Collapse long unchanged runs into bounded context around each change. */
function to_hunks(lines: DiffLine[]): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let current: DiffLine[] = [];
	let trailing_same = 0;

	function flush(): void {
		if (current.length === 0) return;
		// trim trailing context beyond CONTEXT_LINES
		const trim_count = Math.max(0, trailing_same - CONTEXT_LINES);
		hunks.push({ lines: trim_count > 0 ? current.slice(0, current.length - trim_count) : current });
		current = [];
		trailing_same = 0;
	}

	let pending_context: DiffLine[] = [];
	for (const line of lines) {
		if (line.kind === "same") {
			if (current.length === 0) {
				pending_context.push(line);
				if (pending_context.length > CONTEXT_LINES) pending_context.shift();
			} else {
				current.push(line);
				trailing_same++;
			}
		} else {
			if (current.length === 0 && pending_context.length > 0) {
				current.push(...pending_context);
				pending_context = [];
			}
			current.push(line);
			trailing_same = 0;
		}
	}
	flush();
	return hunks;
}
