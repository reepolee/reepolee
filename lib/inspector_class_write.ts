/**
 * Dev-only class-attribute patcher for the inspector. The browser inspector
 * targets a stamped block tag (data-ree="<file>:<line>") and edits its `class`
 * in place; this module reads and rewrites the literal class attribute in the
 * raw .ree source at that line.
 *
 * Scope guard: only a fully-literal class value is editable. A dynamic class -
 * one that contains a template tag ({= }, {{ }}, {_ }, ...) - is refused, since
 * the rendered string cannot be mapped back to the expression that produced it.
 * When the tag has no class attribute, one is inserted right after the tag name.
 *
 * Pure string transforms; the WS dispatch (inspector_ws.ts) does the file I/O
 * and the project-root path guard.
 */

// Opening tag matcher: <name ...attrs...> (attribute-aware so quoted ">" inside
// an attribute value never terminates the tag early). Hyphen-free names only,
// matching the stamper's OPEN_TAG_RE - ReeTags are never stamped.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

// A class value is "dynamic" (not editable) when it contains a template tag.
function is_dynamic(value: string): boolean { return value.includes("{"); }

function line_of_offset(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (src[i] === "\n") line++;
	}
	return line;
}

type TagHit = { tag_start: number; tag_end: number; name: string; attrs: string; name_end: number; };

/** Find the first opening <tag_name> whose "<" sits on `line` (1-based). */
function find_tag_at_line(src: string, line: number, tag_name: string): TagHit | null {
	OPEN_TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OPEN_TAG_RE.exec(src)) !== null) {
		const name = (match[1] ?? "").toLowerCase();
		if (name !== tag_name.toLowerCase()) continue;
		const tag_start = match.index;
		if (line_of_offset(src, tag_start) !== line) continue;
		return {
			tag_start,
			tag_end: tag_start + match[0].length,
			name,
			attrs: match[2] ?? "",
			name_end: tag_start + 1 + (match[1] ?? "").length,
		};
	}
	return null;
}

// Match a class attribute inside a tag's attribute text, capturing the quote and
// the value. Handles both quote styles.
const CLASS_ATTR_RE = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/;

export type ClassReadResult = { ok: true; value: string; has_attr: boolean; } | { ok: false; reason: string; };

/** Read the literal class value on the tag at `line`, or report why not. */
export function read_class_from_source(src: string, line: number, tag_name: string): ClassReadResult {
	const hit = find_tag_at_line(src, line, tag_name);
	if (!hit) return { ok: false, reason: `no <${tag_name}> tag at line ${line}` };

	const class_match = CLASS_ATTR_RE.exec(hit.attrs);
	if (!class_match) return { ok: true, value: "", has_attr: false };

	const value = class_match[2] ?? class_match[3] ?? "";
	if (is_dynamic(value)) return {
		ok: false,
		reason: "class is dynamic (contains a template tag), not editable",
	};
	return { ok: true, value, has_attr: true };
}

export type ClassPatchResult = { ok: true; source: string; } | { ok: false; reason: string; };

// Match a class attribute plus any whitespace immediately before it, so that
// removing the attribute also removes its separating space (no "<a  href>").
const CLASS_ATTR_WITH_LEAD_RE = /\s*\bclass\s*=\s*("([^"]*)"|'([^']*)')/;

/**
 * Replace, add, or remove the literal class attribute on the tag at `line`.
 * An empty `new_value` removes an existing class (a no-op when the tag has
 * none). Refuses a dynamic existing class (contains a template tag).
 */
export function patch_class_in_source(src: string, line: number, tag_name: string, new_value: string): ClassPatchResult {
	const trimmed_new = new_value.trim();
	const removing = trimmed_new === "";

	const hit = find_tag_at_line(src, line, tag_name);
	if (!hit) return { ok: false, reason: `no <${tag_name}> tag at line ${line}` };

	const attr_offset_in_tag = hit.name_end - hit.tag_start;

	if (removing) {
		// Remove the class attribute (and its leading space) when present; a tag
		// with no class is left unchanged (nothing to remove).
		const lead_match = CLASS_ATTR_WITH_LEAD_RE.exec(hit.attrs);
		if (!lead_match) return { ok: true, source: src };
		const existing = lead_match[2] ?? lead_match[3] ?? "";
		if (is_dynamic(existing)) return {
			ok: false,
			reason: "class is dynamic (contains a template tag), not editable",
		};
		const remove_start = hit.tag_start + attr_offset_in_tag + lead_match.index;
		const remove_len = lead_match[0].length;
		return {
			ok: true,
			source: src.slice(0, remove_start) + src.slice(remove_start + remove_len),
		};
	}

	const class_match = CLASS_ATTR_RE.exec(hit.attrs);

	if (class_match) {
		const existing = class_match[2] ?? class_match[3] ?? "";
		if (is_dynamic(existing)) return {
			ok: false,
			reason: "class is dynamic (contains a template tag), not editable",
		};
		// Preserve the original quote character.
		const quoted = class_match[1] ?? "";
		const quote = quoted.charAt(0);
		const replacement = `class=${quote}${new_value}${quote}`;
		const class_start = hit.tag_start + attr_offset_in_tag + class_match.index;
		const class_len = class_match[0].length;
		const before = src.slice(0, class_start);
		const after = src.slice(class_start + class_len);
		return { ok: true, source: before + replacement + after };
	}

	// No class attribute: insert one right after the tag name.
	const insertion = ` class="${new_value}"`;
	const before = src.slice(0, hit.name_end);
	const after = src.slice(hit.name_end);
	return { ok: true, source: before + insertion + after };
}
