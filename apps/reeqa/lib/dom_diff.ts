/**
 * DOM snapshot diffing - maps a pixel-diff region back to the HTML elements
 * occupying it, and diffs the baseline/test DOM trees structurally so a
 * report can name *what* changed ("the footer nav lost a link") instead of
 * just counting pixels. Pixels stay authoritative for pass/fail; this only
 * explains. See IN_PROGRESS_reeqa_qa_procedure.md §3.
 *
 * The input is the raw DOMSnapshot.captureSnapshot response: a `documents`
 * array plus a `strings` table, where nodeName/nodeValue/attributes hold
 * integer indices into that table and layout rects live on the document
 * (not inside `nodes`).
 */

export type Rect = { left: number; top: number; width: number; height: number };

export type Changed_element = {
	tag: string;
	id?: string;
	class?: string;
	text: string;
	reason: "pixel" | "added" | "removed" | "changed";
	/** For reason "changed" (from html_diff.ts): a human summary, e.g. `href: "/a" → "/b"`. */
	detail?: string;
	/** For reason "changed": just the new value (attribute or text) - the short diff-screen narration speaks only this, never "from". */
	to?: string;
	/** For reason "changed", paired with `to`: the old value - the fuller current-screenshot-screen narration speaks "from X to Y" using both. */
	from?: string;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
};

type Dom_nodes = {
	parentIndex?: number[];
	nodeType?: number[];
	nodeName?: number[];
	nodeValue?: number[];
	attributes?: Array<number[] | undefined>;
};

type Dom_document = {
	nodes?: Dom_nodes;
	layout?: { nodeIndex: number[]; bounds: number[][] | number[] };
};

type Dom_snapshot = {
	documents?: Dom_document[];
	strings?: string[];
};

type Element_descriptor = {
	index: number;
	tag: string;
	id?: string;
	class?: string;
	text: string;
	rect?: Rect;
};

const SKIP_TAGS = new Set(["script", "style", "meta", "link", "noscript", "head", "title", "base", "iframe"]);

const MAX_TEXT = 100;

/** Resolve a string-table index; -1 (and out-of-range) is null. */
function string_at(strings: string[], index: number | undefined): string | undefined {
	if (index === undefined || index < 0 || index >= strings.length) return undefined;
	return strings[index];
}

function rect_at(bounds: number[][] | number[], index: number): Rect | undefined {
	const entry = bounds[index];
	if (Array.isArray(entry) && entry.length >= 4) {
		return { left: Number(entry[0]), top: Number(entry[1]), width: Number(entry[2]), height: Number(entry[3]) };
	}
	// Older Chrome returns a flat array of 4 numbers per node.
	const start = index * 4;
	if (typeof bounds[start] === "number") {
		return { left: Number(bounds[start]), top: Number(bounds[start + 1]), width: Number(bounds[start + 2]), height: Number(bounds[start + 3]) };
	}
	return undefined;
}

/**
 * Flatten a DOMSnapshot response into visible, interesting element
 * descriptors. Text is aggregated up from descendant text nodes so a
 * `<button>Save</button>` with no id/class still carries its label.
 */
function element_descriptors(snapshot: unknown): Element_descriptor[] {
	const document = (snapshot as Dom_snapshot)?.documents?.[0];
	const strings = (snapshot as Dom_snapshot)?.strings ?? [];
	const nodes = document?.nodes;
	if (!nodes) return [];
	const parent_index = nodes.parentIndex ?? [];
	const node_type = nodes.nodeType ?? [];
	const node_name = nodes.nodeName ?? [];
	const node_value = nodes.nodeValue ?? [];
	const attributes = nodes.attributes ?? [];

	const rect_by_index = new Map<number, Rect>();
	if (document?.layout) {
		for (let i = 0; i < document.layout.nodeIndex.length; i++) {
			const rect = rect_at(document.layout.bounds, i);
			if (rect) rect_by_index.set(document.layout.nodeIndex[i]!, rect);
		}
	}

	// Aggregate each text node's value into every ancestor element, so an
	// element's text reflects its rendered content, not just a direct child.
	const element_text = new Map<number, string>();
	for (let i = 0; i < node_type.length; i++) {
		if (node_type[i] !== 3) continue; // text node
		const raw = (string_at(strings, node_value[i]) ?? "").replace(/\s+/g, " ").trim();
		if (!raw) continue;
		let parent = parent_index[i] ?? -1;
		while (parent >= 0) {
			const existing = element_text.get(parent) ?? "";
			const combined = existing ? `${existing} ${raw}` : raw;
			element_text.set(parent, combined.length > MAX_TEXT ? combined.slice(0, MAX_TEXT) : combined);
			parent = parent_index[parent] ?? -1;
		}
	}

	// Containers accumulate every descendant's text, so their text is not a
	// stable identity - only a leaf element's own text is. Track which
	// elements have element children so the signature/identity uses text only
	// for leaves (a `<button>Save</button>` is "Save"; a `<body>` is not).
	const has_element_children = new Set<number>();
	for (let i = 0; i < node_type.length; i++) {
		if (node_type[i] !== 1) continue;
		const parent = parent_index[i] ?? -1;
		if (parent >= 0) has_element_children.add(parent);
	}

	const result: Element_descriptor[] = [];
	for (let i = 0; i < node_type.length; i++) {
		if (node_type[i] !== 1) continue; // element node
		const tag = (string_at(strings, node_name[i]) ?? "?").toLowerCase();
		if (SKIP_TAGS.has(tag)) continue;
		const attrs = attributes[i] ?? [];
		let id: string | undefined;
		let class_name: string | undefined;
		for (let j = 0; j + 1 < attrs.length; j += 2) {
			const name = string_at(strings, attrs[j]);
			const value = string_at(strings, attrs[j + 1]);
			if (name === "id") id = value;
			else if (name === "class") class_name = value;
		}
		const is_leaf = !has_element_children.has(i);
		const text = is_leaf ? (element_text.get(i) ?? "").slice(0, MAX_TEXT) : "";
		const rect = rect_by_index.get(i);
		if (!rect || rect.width <= 0 || rect.height <= 0) continue;
		if (!id && !class_name && !text) continue;
		result.push({ index: i, tag, id, class: class_name, text, rect });
	}
	return result;
}

function intersects(a: Rect, b: Rect): boolean {
	return a.left < b.left + b.width
		&& a.left + a.width > b.left
		&& a.top < b.top + b.height
		&& a.top + a.height > b.top;
}

function contains(outer: Rect, inner: Rect): boolean {
	return inner.left >= outer.left
		&& inner.top >= outer.top
		&& inner.left + inner.width <= outer.left + outer.width
		&& inner.top + inner.height <= outer.top + outer.height;
}

function to_changed(element: Element_descriptor, reason: Changed_element["reason"]): Changed_element {
	return {
		tag: element.tag,
		...(element.id ? { id: element.id } : {}),
		...(element.class ? { class: element.class } : {}),
		text: element.text,
		reason,
		...(element.rect ? { left: element.rect.left, top: element.rect.top, width: element.rect.width, height: element.rect.height } : {}),
	};
}

/**
 * The elements occupying a differing pixel region. Keeps the innermost
 * (leaf) elements - the actual changed control/link, not its `<body>` or
 * `<nav>` ancestor - and caps the list so a whole-page diff doesn't drown
 * the report in every text node.
 */
export function elements_intersecting(snapshot: unknown, bounds: Rect): Changed_element[] {
	const candidates = element_descriptors(snapshot)
		.filter((element) => element.rect && intersects(element.rect, bounds))
		.sort((left, right) => (left.rect!.width * left.rect!.height) - (right.rect!.width * right.rect!.height));

	const selected: Element_descriptor[] = [];
	for (const element of candidates) {
		// Processed smallest-first, so an element that fully contains an
		// already-selected one is an ancestor - skip it in favour of the leaf.
		if (selected.some((picked) => contains(element.rect!, picked.rect!))) continue;
		selected.push(element);
	}
	return selected.slice(0, 12).map((element) => to_changed(element, "pixel"));
}

export function element_label(element: Changed_element): string {
	const selector = `${element.tag}${element.id ? `#${element.id}` : ""}${element.class ? `.${element.class.split(/\s+/)[0]}` : ""}`;
	const text = element.text ? ` "${element.text}"` : "";
	const detail = element.detail ? ` (${element.detail})` : "";
	return `<${selector}>${text}${detail}`;
}

/**
 * A spoken word for a tag, so narration and captions read like English
 * rather than raw markup. macOS `say` otherwise spells a bare `<a>` tag as
 * the letter name ("capital A"). A tag not in the curated list below reads
 * fine as itself as long as it's a real word (div, section, article,
 * aside, main, figure, ...) - only short/abbreviation tags (2 characters
 * or fewer: tr, td, th, br, hr, ...) are at real risk of being spelled out
 * letter by letter, so only those fall back to the generic "element".
 */
function spoken_tag(tag: string): string {
	const words: Record<string, string> = {
		a: "link",
		button: "button",
		form: "form",
		footer: "footer",
		header: "header",
		h1: "heading",
		h2: "heading",
		h3: "heading",
		h4: "heading",
		h5: "heading",
		h6: "heading",
		img: "image",
		input: "input field",
		label: "label",
		li: "list item",
		nav: "navigation",
		ol: "list",
		p: "paragraph",
		select: "dropdown",
		span: "text",
		table: "table",
		textarea: "text area",
		ul: "list",
	};
	if (words[tag]) return words[tag];
	return tag.length <= 2 ? "element" : tag;
}

function spoken_element_name(element: Changed_element): string {
	const kind = spoken_tag(element.tag);
	if (element.text) return `${kind} "${element.text}"`;
	if (element.id) return `${kind} with id "${element.id}"`;
	return kind;
}

/** "heading with id X" / "button" - the element's kind plus, if it has one, its id - never its text (the caller decides whether text is the "to" value being spoken or just incidental context). */
function spoken_kind_and_identity(element: Changed_element): string {
	const kind = spoken_tag(element.tag);
	const identity = element.id ? ` with id "${element.id}"` : "";
	return `${kind}${identity}`;
}

/** One element's change, "to"-only (saying both sides reads as noise out loud on the shorter diff screen - see describe_element_full for the fuller version). */
function describe_element(element: Changed_element): string {
	if (element.reason === "removed") return `The ${spoken_element_name(element)} was removed.`;
	if (element.reason === "added") {
		const name = spoken_element_name(element);
		return `${/^[aeiou]/i.test(name) ? "An" : "A"} ${name} was added.`;
	}
	if (element.reason === "changed" && element.to) return `The ${spoken_kind_and_identity(element)} changed to "${element.to}".`;
	return `The ${spoken_element_name(element)} changed.`;
}

/** Same as describe_element, but a "changed" entry says both sides: "from X to Y". */
function describe_element_full(element: Changed_element): string {
	if (element.reason === "changed" && element.to !== undefined && element.from !== undefined) {
		const from = element.from.trim() ? `"${element.from}"` : "nothing";
		return `The ${spoken_kind_and_identity(element)} changed from ${from} to "${element.to}".`;
	}
	return describe_element(element);
}

/**
 * Narration only ever speaks this many elements in full - past that, a
 * growing list stops being a description and starts being noise (and,
 * worse, starts overrunning the evidence video's per-screen hold: several
 * full sentences of narration made the "Done" card appear while the diff
 * screen's voice was still talking). Was 3; cut to 1 for that reason - just
 * the first change, then a trailing count for the rest.
 */
const MAX_SPOKEN_ELEMENTS = 1;

/**
 * A spoken description of the first changed element, for the evidence
 * narration and captions, plus a trailing count of anything past
 * MAX_SPOKEN_ELEMENTS rather than speaking every one out in full.
 */
function describe_all(elements: Changed_element[] | undefined, describe_one: (element: Changed_element) => string): string {
	if (!elements || elements.length === 0) return "";
	const spoken = elements.slice(0, MAX_SPOKEN_ELEMENTS).map(describe_one).join(" ");
	const remaining = elements.length - MAX_SPOKEN_ELEMENTS;
	if (remaining <= 0) return spoken;
	return `${spoken} And ${remaining} more change${remaining === 1 ? "" : "s"}.`;
}

export function describe_changed_elements(elements: Changed_element[] | undefined): string {
	return describe_all(elements, describe_element);
}

/**
 * The fuller "changed from X to Y" narration for the evidence video's
 * current-screenshot screen, which follows the diff screen and has room to
 * say both sides of a changed element (unlike describe_changed_elements'
 * "to"-only sentences, paced for the shorter diff screen).
 */
export function describe_changed_elements_full(elements: Changed_element[] | undefined): string {
	return describe_all(elements, describe_element_full);
}
