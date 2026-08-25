/**
 * Translation path resolution - shared between the main tokenizer's
 * {_ path} / {- path} / {@ path} tags (compiler.ts) and ReeTag attribute
 * values (custom_elements.ts). One implementation of the path grammar and
 * the safe missing-key-tolerant resolve expression.
 */

// Restricted to a simple property path - dotted identifiers plus optional
// string-literal bracket segments (e.g. selectors?.["0"] for keys that are
// not valid identifiers). No arbitrary JS, no computed keys, no function
// calls. This is what makes {_ }/{- } safe to resolve via a plain property
// walk instead of eval-and-catch.
export const DOTTED_PATH_RE = /^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*|(?:\?\.)?\[(?:"[^"]*"|'[^']*')\])*$/;

const SEGMENT_RE = /[A-Za-z_$][\w$]*|\[(?:"([^"]*)"|'([^']*)')\]/g;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Build the safe, missing-key-tolerant resolve expression for a translation
 * path: `(props.translations?.a?.b ?? "{b}")`. Throws on invalid paths.
 *
 * @param path      The dotted path as written in the template (trimmed by caller or not)
 * @param error_hint Prefix for the error message so each call site can name its syntax
 */
export function build_translation_resolve_expr(path: string, error_hint: string): string {
	const trimmed = path.trim();
	if (!DOTTED_PATH_RE.test(trimmed)) {
		throw new Error(
			`${error_hint}: expected a simple dotted path (e.g. "labels.text_input") or string-literal bracket keys (e.g. selectors?.["0"]), no expressions, computed keys, or function calls.`,
		);
	}

	// Tokenize into plain segments: identifiers and quoted bracket keys
	const parts: string[] = [];
	let seg_match: RegExpExecArray | null;
	SEGMENT_RE.lastIndex = 0;
	while ((seg_match = SEGMENT_RE.exec(trimmed)) !== null) {
		const bracket_key = seg_match[1] ?? seg_match[2];
		parts.push(bracket_key ?? seg_match[0]);
	}

	const last_segment = parts[parts.length - 1];
	const missing_literal = JSON.stringify(`{${last_segment}}`);

	const walk = parts.map((part) => (IDENT_RE.test(part) ? `?.${part}` : `?.[${JSON.stringify(part)}]`)).join("");
	return `(props.translations${walk} ?? ${missing_literal})`;
}
