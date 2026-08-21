import type { Changed_element } from "./dom_diff";

/**
 * Element-level diff of two full HTML documents (the "complete HTML page
 * saved as baseline" signal from IN_PROGRESS_reeqa_qa_procedure.md §3): a
 * ground-truth complement to the pixel diff. The pixel diff says *something*
 * changed and roughly where; this says *which element, attribute or text*
 * changed in the markup, independent of whether it produced a visible pixel.
 *
 * Supersedes the old DOMSnapshot-signature-counting structural_diff, which
 * could only see whole-element add/remove (never an attribute or a text
 * edit on an element with a stable id/class) and silently skipped any
 * element without an id, class or text. A real tree diff below fixes both.
 */

const SKIP_TAGS = new Set(["script", "style", "meta", "link", "noscript", "head", "title", "base", "iframe"]);

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const MAX_TEXT = 100;

type Html_element_node = {
	kind: "element";
	tag: string;
	attrs: Map<string, string>;
	children: Html_node[];
};

type Html_text_node = { kind: "text"; text: string };

type Html_node = Html_element_node | Html_text_node;

function normalize_text(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

/**
 * Parse HTML into a tree via Bun's native HTMLRewriter (a real streaming
 * HTML parser, not a hand-rolled regex one) - zero dependencies, matching
 * the project's Bun-native policy. HTMLRewriter only exposes start-tag and
 * (for non-void elements) end-tag events plus text runs, in document
 * order, so the tree is reconstructed here with an explicit stack.
 */
async function parse_html(html: string): Promise<Html_element_node> {
	const root: Html_element_node = { kind: "element", tag: "#root", attrs: new Map(), children: [] };
	const stack: Html_element_node[] = [root];
	// >0 while inside a SKIP_TAGS subtree - its children are parsed (so the
	// stack/end-tag bookkeeping stays correct) but never attached to the tree.
	let skip_depth = 0;
	let text_buffer = "";

	function flush_text(): void {
		const text = normalize_text(text_buffer);
		text_buffer = "";
		if (!text) return;
		if (skip_depth > 0) return;
		stack[stack.length - 1]!.children.push({ kind: "text", text });
	}

	const rewriter = new HTMLRewriter();
	rewriter.on("*", {
		element(el) {
			flush_text();
			const tag = el.tagName;
			const currently_skipped = skip_depth > 0 || SKIP_TAGS.has(tag);
			const is_void = VOID_TAGS.has(tag) || el.selfClosing;
			if (currently_skipped) {
				skip_depth++;
				if (is_void) {
					skip_depth--; // no end tag will ever fire for it
				} else {
					el.onEndTag(() => { skip_depth--; });
				}
				return;
			}
			const node: Html_element_node = { kind: "element", tag, attrs: new Map([...el.attributes]), children: [] };
			stack[stack.length - 1]!.children.push(node);
			if (!is_void) {
				stack.push(node);
				el.onEndTag(() => {
					flush_text();
					stack.pop();
				});
			}
		},
		text(t) {
			text_buffer += t.text;
			if (t.lastInTextNode) flush_text();
		},
	});
	await rewriter.transform(new Response(html)).text();
	return root;
}

function element_children(node: Html_element_node): Html_element_node[] {
	return node.children.filter((child): child is Html_element_node => child.kind === "element");
}

/** An element's own direct text - its immediate text-node children, not nested elements' text. */
function own_text(node: Html_element_node): string {
	return node.children
		.filter((child): child is Html_text_node => child.kind === "text")
		.map((child) => child.text)
		.join(" ")
		.slice(0, MAX_TEXT);
}

function to_changed(node: Html_element_node, reason: Changed_element["reason"], detail?: string, to?: string, from?: string): Changed_element {
	const id = node.attrs.get("id");
	const class_name = node.attrs.get("class");
	return {
		tag: node.tag,
		...(id ? { id } : {}),
		...(class_name ? { class: class_name } : {}),
		text: own_text(node),
		reason,
		...(detail ? { detail } : {}),
		...(to ? { to } : {}),
		...(to && from !== undefined ? { from } : {}),
	};
}

function quote(value: string): string {
	const truncated = value.length > 60 ? `${value.slice(0, 60)}…` : value;
	return `"${truncated}"`;
}

/**
 * `class: "a b c" → "a b c d"` buries the one token that actually changed
 * in whatever the rest of the (often long, Tailwind-style) utility-class
 * list already was - the exact opposite of a trustworthy diff. Token-diff
 * the two space-separated lists instead and report only what moved: which
 * classes were added, which were removed. A class list edited only by
 * reordering (same tokens, different order/whitespace) has nothing to
 * report as added/removed, so it's called out as a reorder instead of
 * silently claiming nothing changed.
 */
function diff_class_value(from: string, to: string): string {
	const from_tokens = new Set(from.split(/\s+/).filter(Boolean));
	const to_tokens = new Set(to.split(/\s+/).filter(Boolean));
	const added = [...to_tokens].filter((token) => !from_tokens.has(token));
	const removed = [...from_tokens].filter((token) => !to_tokens.has(token));
	if (added.length === 0 && removed.length === 0) return "class reordered";
	const parts: string[] = [];
	if (added.length > 0) parts.push(`+${added.join(" +")}`);
	if (removed.length > 0) parts.push(`-${removed.join(" -")}`);
	return `class ${parts.join(" ")}`;
}

/**
 * Sequence alignment (classic LCS, same idea unkeyed virtual-DOM diffing
 * uses) over siblings that share a tag - positional matching by element
 * type, same as React/Vue reconcile children without keys. `class` is
 * deliberately *not* part of this identity check: it's one of the things
 * diff_element() needs to diff, so folding it into "same element" would
 * make any class edit look like the element was replaced (remove+add of a
 * generic tag, no attribute detail, and its subtree never gets recursed
 * into - exactly the bug this comment used to cause). Good enough for
 * page-sized sibling lists; not attempting a globally-optimal tree edit
 * distance.
 */
function same_element(a: Html_element_node, b: Html_element_node): boolean {
	return a.tag === b.tag;
}

type Alignment = { baseline?: Html_element_node; current?: Html_element_node };

function align_siblings(baseline: Html_element_node[], current: Html_element_node[]): Alignment[] {
	const n = baseline.length;
	const m = current.length;
	// dp[i][j] = length of the longest common (same_element) subsequence of
	// baseline[i..] and current[j..].
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i]![j] = same_element(baseline[i]!, current[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}
	const alignment: Alignment[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (same_element(baseline[i]!, current[j]!)) {
			alignment.push({ baseline: baseline[i], current: current[j] });
			i++;
			j++;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			alignment.push({ baseline: baseline[i] });
			i++;
		} else {
			alignment.push({ current: current[j] });
			j++;
		}
	}
	while (i < n) alignment.push({ baseline: baseline[i++] });
	while (j < m) alignment.push({ current: current[j++] });
	return alignment;
}

/**
 * Match siblings by id first (a stable identity regardless of position or
 * intervening add/remove), then align whatever's left by (tag, class).
 */
function match_siblings(baseline: Html_element_node[], current: Html_element_node[]): Alignment[] {
	const baseline_by_id = new Map<string, Html_element_node>();
	const current_by_id = new Map<string, Html_element_node>();
	for (const node of baseline) { const id = node.attrs.get("id"); if (id) baseline_by_id.set(id, node); }
	for (const node of current) { const id = node.attrs.get("id"); if (id) current_by_id.set(id, node); }

	const alignment: Alignment[] = [];
	const matched_ids = new Set<string>();
	for (const [id, baseline_node] of baseline_by_id) {
		const current_node = current_by_id.get(id);
		if (current_node) {
			alignment.push({ baseline: baseline_node, current: current_node });
			matched_ids.add(id);
		}
	}
	const remaining_baseline = baseline.filter((node) => { const id = node.attrs.get("id"); return !id || !matched_ids.has(id); });
	const remaining_current = current.filter((node) => { const id = node.attrs.get("id"); return !id || !matched_ids.has(id); });
	alignment.push(...align_siblings(remaining_baseline, remaining_current));
	return alignment;
}

function diff_element(baseline: Html_element_node, current: Html_element_node, out: Changed_element[]): void {
	const changed_attributes: string[] = [];
	const keys = new Set([...baseline.attrs.keys(), ...current.attrs.keys()]);
	for (const key of keys) {
		if (baseline.attrs.get(key) !== current.attrs.get(key)) changed_attributes.push(key);
	}
	const baseline_text = own_text(baseline);
	const current_text = own_text(current);
	const text_changed = baseline_text !== current_text;

	if (changed_attributes.length > 0 || text_changed) {
		const details: string[] = [];
		// The short "changed to X" narration (record_page_evidence_video's
		// diff screen) only ever speaks the "to" side - saying both reads as
		// noise out loud there. The fuller "changed from X to Y" narration
		// (its follow-up current-screenshot screen) wants both, so track
		// them as a pair from the same source (text wins as most
		// human-legible; an attribute whose new value was actually removed
		// has no "to" to pair, so it's skipped as a spoken candidate and
		// narration falls back to a generic sentence for this element).
		let spoken_to: string | undefined = text_changed ? current_text : undefined;
		let spoken_from: string | undefined = text_changed ? baseline_text : undefined;
		for (const key of changed_attributes.slice(0, 3)) {
			const from = baseline.attrs.get(key);
			const to = current.attrs.get(key);
			if (key === "class" && from !== undefined && to !== undefined) {
				details.push(diff_class_value(from, to));
			} else {
				details.push(from === undefined ? `+${key}=${quote(to!)}` : to === undefined ? `-${key}` : `${key}: ${quote(from)} → ${quote(to)}`);
			}
			if (spoken_to === undefined && to !== undefined) {
				spoken_to = to;
				spoken_from = from ?? "";
			}
		}
		if (text_changed) details.push(`text: ${quote(baseline_text)} → ${quote(current_text)}`);
		out.push(to_changed(current, "changed", details.join(", "), spoken_to, spoken_from));
	}

	diff_children(element_children(baseline), element_children(current), out);
}

function diff_children(baseline: Html_element_node[], current: Html_element_node[], out: Changed_element[]): void {
	for (const pair of match_siblings(baseline, current)) {
		if (pair.baseline && pair.current) diff_element(pair.baseline, pair.current, out);
		else if (pair.baseline) out.push(to_changed(pair.baseline, "removed"));
		else if (pair.current) out.push(to_changed(pair.current, "added"));
	}
}

/**
 * Diff two full HTML documents (typically document.documentElement.outerHTML
 * captured at baseline time and again at compare time) element by element.
 * Reports every added/removed element plus every attribute or direct-text
 * change on elements matched between the two trees.
 */
export async function diff_html(baseline_html: string, current_html: string): Promise<Changed_element[]> {
	const baseline_root = await parse_html(baseline_html);
	const current_root = await parse_html(current_html);
	const out: Changed_element[] = [];
	diff_children(element_children(baseline_root), element_children(current_root), out);
	return out;
}
