/** Read a balanced (...) group starting at source[start] === "(". Returns [inner, endIndex]. */
export function read_paren_group(source: string, start: number): [string, number] {
	let depth = 0;
	let in_string = false;
	let in_comment = false;
	for (let index = start; index < source.length; index++) {
		const char = source[index]!;
		const next = source[index + 1] ?? "";
		if (in_comment) {
			if (char === "\n") in_comment = false;
			continue;
		}
		if (in_string) {
			if (char === "'") {
				if (next === "'") index++;
				else in_string = false;
			}
			continue;
		}
		if (char === "-" && next === "-") {
			in_comment = true;
			index++;
			continue;
		}
		if (char === "'") in_string = true;
		else if (char === "(") depth++;
		else if (char === ")") {
			depth--;
			if (depth === 0) return [source.slice(start + 1, index), index];
		}
	}
	throw new Error(`Unbalanced parens in: ${source.slice(start, start + 60)}...`);
}

/** Parse a quoted SQL string token starting at source[start] === "'". */
export function read_quoted_token(source: string, start: number): [string, number] {
	for (let index = start + 1; index < source.length; index++) {
		if (source[index] !== "'") continue;
		if (source[index + 1] === "'") {
			index++;
			continue;
		}
		return [source.slice(start, index + 1), index];
	}
	throw new Error(`Unterminated string in: ${source.slice(start, start + 60)}...`);
}
