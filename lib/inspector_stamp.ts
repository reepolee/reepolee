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

// Opening tag matcher: <name ...attrs...> or <name .../>. ReeTags use
// hyphenated names and are stamped before their component expansion.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

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

function escape_attribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
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
		if (!BLOCK_TAGS.has(tag_name) && !tag_name.includes("-")) continue;

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
 * Child sections render in the parent form but own their translations in the
 * child's co-located namespace. Keep the runtime lookup namespaced in
 * `ctx.translations`, while giving the inspector the child source and its
 * original key so an edit never creates a key in the parent locale file.
 */
function inspector_translation_target(key: string, file: string): { key: string; file: string; } {
	const match = key.match(/^children\.([A-Za-z_$][\w$]*)\.(.+)$/);
	if (!match) return { key, file };

	const child_table = match[1] as string;
	const child_key = match[2] as string;
	const separator = file.lastIndexOf("/");
	if (separator < 0) return { key, file };

	return {
		key: child_key,
		file: `${file.slice(0, separator)}/${child_table}/index.ree`,
	};
}

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
		const target = inspector_translation_target(key, file);
		const wrapped = `<span data-ree-i18n="${target.key}" data-ree-i18n-file="${target.file}" data-ree-i18n-raw="${raw_flag}">${lookup}</span>`;
		out += src.slice(last, start) + wrapped;
		last = start + lookup.length;
	}
	out += src.slice(last);
	return stamp_ree_tag_label_i18n(out, file);
}

/**
 * A ReeTag label is rendered later by its component, so an attribute lookup
 * cannot use an inline span in the invoking template. Preserve its source
 * identity as opaque inspector metadata until the rendered label is stamped.
 */
function stamp_ree_tag_label_i18n(src: string, file: string): string {
	const ranges = ree_skip_ranges(src);
	const tag_re = /<([a-zA-Z][a-zA-Z0-9]*-[a-zA-Z0-9-]*)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
	const label_re = /\slabel\s*=\s*(["'])\{([_@-])\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\}\1/;
	let out = "";
	let last = 0;
	let match: RegExpExecArray | null;

	while ((match = tag_re.exec(src)) !== null) {
		if (in_any_range(match.index, ranges)) continue;
		const attributes = match[2] ?? "";
		const label_match = attributes.match(label_re);
		if (!label_match || attributes.includes("data-ree-i18n-target")) continue;

		const prefix = label_match[2] ?? "_";
		const key = label_match[3] ?? "";
		const raw_flag = prefix === "-" || prefix === "@" ? "1" : "0";
		const target = inspector_translation_target(key, file);
		const insertion = ` data-ree-i18n="${target.key}" data-ree-i18n-file="${target.file}" data-ree-i18n-raw="${raw_flag}" data-ree-i18n-target="label"`;
		const slash = match[3] ?? "";
		const insert_at = match.index + match[0].length - 1 - slash.length;
		out += src.slice(last, insert_at) + insertion;
		last = insert_at;
	}

	out += src.slice(last);
	return out;
}

/**
 * Apply dev-only inspector metadata from a ReeTag invocation to its rendered
 * HTML. This keeps components unaware of the inspector and their public props
 * unchanged.
 */
export function stamp_inspector_component_output(html: string, props: Record<string, any>): string {
	const attributes = props.attributes ?? {};
	const source_stamp = attributes["data-ree"];
	let stamped_html = html;

	if (typeof source_stamp === "string" && source_stamp.length > 0) {
		const opening_tag = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])([^>]*)>/;
		stamped_html = stamped_html.replace(opening_tag, (tag, tag_name: string, rendered_attributes: string) => {
			if (/\sdata-ree\s*=/.test(rendered_attributes)) return tag;
			const escaped_stamp = escape_attribute(source_stamp);
			return `<${tag_name} data-ree="${escaped_stamp}"${rendered_attributes}>`;
		});
	}

	const key = attributes["data-ree-i18n"];
	const file = attributes["data-ree-i18n-file"];
	const raw = attributes["data-ree-i18n-raw"];
	if (attributes["data-ree-i18n-target"] !== "label" || typeof key !== "string" || typeof file !== "string" || typeof raw !== "string") {
		return stamped_html;
	}

	const locale = typeof props.locale === "string" ? ` data-ree-i18n-locale="${escape_attribute(props.locale)}"` : "";
	const i18n_attributes = ` data-ree-i18n="${escape_attribute(key)}" data-ree-i18n-file="${escape_attribute(file)}" data-ree-i18n-raw="${escape_attribute(raw)}"${locale}`;
	const label_tag = /<label(?=[\s>])([^>]*)>/;
	return stamped_html.replace(label_tag, (tag, rendered_attributes: string) => {
		if (/\sdata-ree-i18n\s*=/.test(rendered_attributes)) return tag;
		return `<label${i18n_attributes}${rendered_attributes}>`;
	});
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
