/** A line in an LCS-based text diff. */
export type Line_diff_line = { kind: "same" | "add" | "remove"; text: string; };

/**
 * Diff two short text documents line by line. LCS keeps unchanged runs in
 * place, which makes generated-code proposals readable when fields move.
 */
export function diff_lines(original: string, updated: string): Line_diff_line[] {
	const before = original.split("\n");
	const after = updated.split("\n");
	const table: Uint32Array[] = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));

	for (let before_index = before.length - 1; before_index >= 0; before_index--) {
		for (let after_index = after.length - 1; after_index >= 0; after_index--) {
			table[before_index]![after_index] = before[before_index] === after[after_index]
				? table[before_index + 1]![after_index + 1]! + 1
				: Math.max(table[before_index + 1]![after_index]!, table[before_index]![after_index + 1]!);
		}
	}

	const lines: Line_diff_line[] = [];
	let before_index = 0;
	let after_index = 0;
	while (before_index < before.length && after_index < after.length) {
		if (before[before_index] === after[after_index]) {
			lines.push({ kind: "same", text: before[before_index++]! });
			after_index++;
		} else if (table[before_index + 1]![after_index]! >= table[before_index]![after_index + 1]!) {
			lines.push({ kind: "remove", text: before[before_index++]! });
		} else {
			lines.push({ kind: "add", text: after[after_index++]! });
		}
	}
	while (before_index < before.length) lines.push({ kind: "remove", text: before[before_index++]! });
	while (after_index < after.length) lines.push({ kind: "add", text: after[after_index++]! });

	return lines;
}
