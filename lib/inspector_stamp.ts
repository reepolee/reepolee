/**
 * Dev-only source stamping for the inspector. Two pure functions operating on
 * raw .ree source text, BEFORE the template engine's own preprocessing:
 *
 *   stamp_ree_source(src, file) - inject data-ree="<file>:<line>" on block-level
 *                                  HTML tags. Skips tags inside {{ }} raw-JS or
 *                                  raw-text element bodies.
 *
 *   stamp_ree_i18n(src, file)   - wrap {_ path}/{- path}/{@ path} translation
 *                                  lookups in a <span data-ree-i18n="...">
 *                                  marker so the client can target the exact
 *                                  rendered string for in-place/dialog editing.
 *
 * Both use the "<project-root-relative-path>:<line>" convention so the browser
 * client (lib/inspector_client.js) resolves them with one DOM walk-up, and so
 * /__ree_open validates them against the project root.
 *
 * Project code, dev-only: never invoked when TemplateEngine.cache is true
 * (production), so built output carries no stamps.
 */

// Tags that get stamped: block-level structure plus interactive/form elements
// (a, button, label, img, input, select, textarea) so their class is directly
// editable and they open in the editor. Pure text-inline tags (span, strong,
// em, code, br, ...) are deliberately excluded - high noise, rarely a style
// target - so a click on one resolves up to its nearest stamped ancestor.
const BLOCK_TAGS = new Set(
	[
		"section",
		"div",
		"article",
		"header",
		"footer",
		"nav",
		"main",
		"aside",
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"p",
		"ul",
		"ol",
		"li",
		"table",
		"thead",
		"tbody",
		"tr",
		"td",
		"th",
		"blockquote",
		"pre",
		"figure",
		"figcaption",
		"form",
		"fieldset",
		"a",
		"button",
		"label",
		"img",
		"input",
		"select",
		"textarea",
	],
);

// Elements whose BODY is raw text: a <tag> written inside them is literal, not
// a real element to stamp. The opening tag of these elements is still stamped
// (it sits outside its own body range).
const RAW_TEXT_TAGS = ["pre", "script", "code", "textarea", "style"];

// Opening tag matcher: <name ...attrs...> or <name .../>. Hyphen-free names
// only, so this never collides with the ReeTag custom-element rewrite.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function line_of_offset(src: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset; i++) {
		if (src[i] === "\n") line++;
	}
	return line;
}

/**
 * Ranges of the source that must not be stamped: {{ ... }} raw-JS blocks and
 * the bodies (not opening tags) of raw-text elements.
 */
function ree_skip_ranges(src: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];

	const js_re = /\{\{[\s\S]*?\}\}/g;
	let js_match: RegExpExecArray | null;
	while ((js_match = js_re.exec(src)) !== null) {
		const start = js_match.index;
		const end = start + js_match[0].length;
		ranges.push([start, end]);
	}

	for (const tag of RAW_TEXT_TAGS) {
		const body_re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
		let body_match: RegExpExecArray | null;
		while ((body_match = body_re.exec(src)) !== null) {
			const open_end = body_match.index + body_match[0].indexOf(">") + 1;
			const close_len = `</${tag}>`.length;
			const body_end = body_match.index + body_match[0].length - close_len;
			ranges.push([open_end, body_end]);
		}
	}
	return ranges;
}

function in_any_range(pos: number, ranges: Array<[number, number]>): boolean {
	for (const [start, end] of ranges) {
		if (pos >= start && pos < end) return true;
	}
	return false;
}

/**
 * Stamp block-level tags in a raw .ree template with data-ree="<file>:<line>".
 * `file` is the project-root-relative source path (e.g. "apps/main/home.ree").
 */
export function stamp_ree_source(src: string, file: string): string {
	const ranges = ree_skip_ranges(src);
	let out = "";
	let last = 0;
	OPEN_TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OPEN_TAG_RE.exec(src)) !== null) {
		const raw_name = match[1] ?? "";
		const tag_name = raw_name.toLowerCase();
		if (!BLOCK_TAGS.has(tag_name)) continue;

		const match_start = match.index;
		if (in_any_range(match_start, ranges)) continue;

		const line = line_of_offset(src, match_start);
		const name_end = match_start + 1 + raw_name.length;
		const stamp = ` data-ree="${file}:${line}"`;
		out += src.slice(last, name_end) + stamp;
		last = name_end;
	}
	out += src.slice(last);
	return out;
}

// Translation lookup in template source: {_ dotted.path} (escaped text),
// {- dotted.path} (raw/markup), or {@ dotted.path} (markdown). Restricted to a
// simple dotted path - the same shape lib/template/translation_path.ts's
// DOTTED_PATH_RE accepts - so this never wraps an arbitrary expression.
const I18N_LOOKUP_RE = /\{([_@-])\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}/g;

/**
 * Wrap each {_ path}/{- path}/{@ path} translation lookup in a dev-only marker
 * span so the inspector can target the exact rendered string. The span
 * carries the dotted key path. The source file identifies the co-located
 * namespace JSON file used for reads and writes.
 *
 * Skips lookups inside {{ }} raw-JS, raw-text element bodies, and HTML
 * attribute values (wrapping a span inside an attribute would corrupt the
 * tag). `file` is the project-root-relative source path, echoed for
 * open-in-editor.
 */
export function stamp_ree_i18n(src: string, file: string): string {
	const skip = ree_skip_ranges(src);
	const attr_ranges = attribute_value_ranges(src);
	let out = "";
	let last = 0;
	I18N_LOOKUP_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = I18N_LOOKUP_RE.exec(src)) !== null) {
		const start = match.index;
		if (in_any_range(start, skip) || in_any_range(start, attr_ranges)) continue;

		const prefix = match[1] ?? "_";
		const key = match[2] ?? "";
		// {- } (markup) and {@ } (markdown) both edit as source in the dialog
		// (raw=1); {_ } (plain escaped text) edits in place (raw=0).
		const raw_flag = prefix === "-" || prefix === "@" ? "1" : "0";
		const lookup = match[0];
		const wrapped = `<span data-ree-i18n="${key}" data-ree-i18n-file="${file}" data-ree-i18n-raw="${raw_flag}">${lookup}</span>`;
		out += src.slice(last, start) + wrapped;
		last = start + lookup.length;
	}
	out += src.slice(last);
	return out;
}

/**
 * Ranges covering the inside of double/single-quoted HTML attribute values, so
 * a translation lookup used as an attribute value (title="{_ ui.x}") is not
 * wrapped in a span. Only scans within opening tags.
 */
function attribute_value_ranges(src: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const tag_re = /<[a-zA-Z][^>]*>/g;
	let tag_match: RegExpExecArray | null;
	while ((tag_match = tag_re.exec(src)) !== null) {
		const tag_start = tag_match.index;
		const tag_text = tag_match[0];
		const attr_re = /=\s*("([^"]*)"|'([^']*)')/g;
		let attr_match: RegExpExecArray | null;
		while ((attr_match = attr_re.exec(tag_text)) !== null) {
			const quoted = attr_match[1] ?? "";
			const value_start = tag_start + attr_match.index + attr_match[0].length - quoted.length;
			ranges.push([value_start, value_start + quoted.length]);
		}
	}
	return ranges;
}
